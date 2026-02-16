const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
dotenv.config();

const { Pool } = require("pg");
const { Telegraf, Markup } = require("telegraf");

const app = express();
app.use(cors());
app.use(express.json());

// public/ ni serve qilamiz
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;

// ====== DB ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ====== SETTINGS ======
// Taxminiy kutish vaqti (1 odam = 3 daqiqa)
const MINUTES_PER_PERSON = Number(process.env.MINUTES_PER_PERSON || 3);

// DB init
async function initDb() {
  // user_prefs: lang + last_ticket_id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      web_session TEXT UNIQUE,
      lang TEXT NOT NULL DEFAULT 'uz',
      last_ticket_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Agar oldingi jadvalda last_ticket_id yo'q bo'lsa ham qo'shib qo'yamiz
  await pool.query(`
    ALTER TABLE user_prefs
    ADD COLUMN IF NOT EXISTS last_ticket_id TEXT;
  `);

  // tickets table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT UNIQUE NOT NULL,
      number BIGSERIAL UNIQUE,
      status TEXT NOT NULL DEFAULT 'waiting', -- waiting | called | served | canceled
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      called_at TIMESTAMPTZ,
      served_at TIMESTAMPTZ
    );
  `);
}

async function setTelegramLang(telegramId, lang) {
  await pool.query(
    `
    INSERT INTO user_prefs (telegram_id, lang)
    VALUES ($1, $2)
    ON CONFLICT (telegram_id)
    DO UPDATE SET lang = EXCLUDED.lang, updated_at = NOW();
    `,
    [telegramId, lang]
  );
}

async function getTelegramLang(telegramId) {
  try {
    const r = await pool.query(
      `SELECT lang FROM user_prefs WHERE telegram_id = $1 LIMIT 1`,
      [telegramId]
    );
    const lang = r.rows?.[0]?.lang;
    return ["uz", "ru", "en"].includes(lang) ? lang : "uz";
  } catch (e) {
    console.error("getTelegramLang error:", e);
    return "uz";
  }
}

async function setTelegramLastTicket(telegramId, ticketId) {
  await pool.query(
    `
    INSERT INTO user_prefs (telegram_id, last_ticket_id)
    VALUES ($1, $2)
    ON CONFLICT (telegram_id)
    DO UPDATE SET last_ticket_id = EXCLUDED.last_ticket_id, updated_at = NOW();
    `,
    [telegramId, ticketId]
  );
}

async function getTelegramLastTicket(telegramId) {
  try {
    const r = await pool.query(
      `SELECT last_ticket_id FROM user_prefs WHERE telegram_id = $1 LIMIT 1`,
      [telegramId]
    );
    return r.rows?.[0]?.last_ticket_id || null;
  } catch (e) {
    console.error("getTelegramLastTicket error:", e);
    return null;
  }
}

// ====== QUEUE HELPERS ======
async function createTicket() {
  const ticketId = crypto.randomUUID();
  // Insert -> number avtomatik BIGSERIAL bo'ladi
  const r = await pool.query(
    `
    INSERT INTO tickets (ticket_id)
    VALUES ($1)
    RETURNING ticket_id, number, status, created_at
    `,
    [ticketId]
  );
  const row = r.rows[0];

  // queue position: nechta waiting oldinda
  const pos = await getQueuePosition(row.ticket_id);

  return {
    ticketId: row.ticket_id,
    number: Number(row.number),
    status: row.status,
    queuePosition: pos,
    estimatedMinutes: pos * MINUTES_PER_PERSON,
    createdAt: row.created_at,
  };
}

async function getQueuePosition(ticketId) {
  // position = waiting ticketlar ichida, number bo'yicha oldinda nechta bor
  const tr = await pool.query(
    `SELECT number, status FROM tickets WHERE ticket_id = $1 LIMIT 1`,
    [ticketId]
  );
  if (tr.rowCount === 0) return null;

  const { number, status } = tr.rows[0];
  // Agar served/canceled bo'lsa, position 0 deb qaytaramiz
  if (status !== "waiting") return 0;

  const cr = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM tickets
    WHERE status = 'waiting' AND number < $1
    `,
    [number]
  );
  return cr.rows[0].cnt + 1; // o'zi ham kiradi (1-based)
}

async function getTicket(ticketId) {
  const r = await pool.query(
    `
    SELECT ticket_id, number, status, created_at, called_at, served_at
    FROM tickets
    WHERE ticket_id = $1
    LIMIT 1
    `,
    [ticketId]
  );

  if (r.rowCount === 0) return null;

  const row = r.rows[0];
  const pos = await getQueuePosition(row.ticket_id);

  return {
    ticketId: row.ticket_id,
    number: Number(row.number),
    status: row.status,
    queuePosition: pos,
    estimatedMinutes: (pos ?? 0) * MINUTES_PER_PERSON,
    createdAt: row.created_at,
    calledAt: row.called_at,
    servedAt: row.served_at,
  };
}

// (ixtiyoriy) Admin/test: navbatni keyingi odamga chaqirish
async function callNextTicket() {
  // Eng eski waiting ticketni called qilamiz
  const r = await pool.query(
    `
    UPDATE tickets
    SET status = 'called', called_at = NOW()
    WHERE ticket_id = (
      SELECT ticket_id FROM tickets
      WHERE status = 'waiting'
      ORDER BY number ASC
      LIMIT 1
    )
    RETURNING ticket_id, number, status, called_at
    `
  );

  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    ticketId: row.ticket_id,
    number: Number(row.number),
    status: row.status,
    calledAt: row.called_at,
  };
}

// ====== I18N TEXTS (minimal) ======
const TEXT = {
  uz: {
    intro: "NAVBATUZga xush kelibsiz!\nNAVBATUZ bilan siz vaqtingizni tejaysiz.",
    chooseLang: "Tilni tanlang:",
    saved: "✅ Til saqlandi: O‘zbek",
  },
  ru: {
    intro: "Добро пожаловать в NAVBATUZ!\nС NAVBATUZ вы экономите время.",
    chooseLang: "Выберите язык:",
    saved: "✅ Язык сохранён: Русский",
  },
  en: {
    intro: "Welcome to NAVBATUZ!\nWith NAVBATUZ you save time.",
    chooseLang: "Choose a language:",
    saved: "✅ Language saved: English",
  },
};

// ====== BOT UI (design) ======
const UI = {
  uz: {
    title: "🇺🇿 *NAVBATUZ*",
    desc: "Navbatni onlayn oling va vaqtingizni tejang ⏱️\n\nQuyidagilardan birini tanlang:",
    btnQueue: "🎫 Navbat olish",
    btnMy: "📊 Mening navbatim",
    btnServices: "🧾 Xizmatlar",
    btnLang: "🌐 Til",
    btnHelp: "ℹ️ Yordam",
    back: "⬅️ Orqaga",
    helpText:
      "ℹ️ *Yordam*\n\n1) 🎫 Navbat olish — ticket beriladi\n2) 📊 Mening navbatim — oxirgi ticket holati\n3) 🌐 Til — tilni o‘zgartirish\n\nTexnik yordam: admin bilan bog‘laning.",
    soon: "⏳ Bu bo‘lim hozircha tayyorlanmoqda.",
  },
  ru: {
    title: "🇷🇺 *NAVBATUZ*",
    desc: "Получайте очередь онлайн и экономьте время ⏱️\n\nВыберите действие:",
    btnQueue: "🎫 Взять очередь",
    btnMy: "📊 Моя очередь",
    btnServices: "🧾 Услуги",
    btnLang: "🌐 Язык",
    btnHelp: "ℹ️ Помощь",
    back: "⬅️ Назад",
    helpText:
      "ℹ️ *Помощь*\n\n1) 🎫 Взять очередь — выдаём талон\n2) 📊 Моя очередь — статус последнего талона\n3) 🌐 Язык — сменить язык\n\nТехподдержка: свяжитесь с админом.",
    soon: "⏳ Раздел пока в разработке.",
  },
  en: {
    title: "🇬🇧 *NAVBATUZ*",
    desc: "Get your queue online and save time ⏱️\n\nChoose an option:",
    btnQueue: "🎫 Take a ticket",
    btnMy: "📊 My ticket",
    btnServices: "🧾 Services",
    btnLang: "🌐 Language",
    btnHelp: "ℹ️ Help",
    back: "⬅️ Back",
    helpText:
      "ℹ️ *Help*\n\n1) 🎫 Take a ticket — we create a ticket\n2) 📊 My ticket — status of last ticket\n3) 🌐 Language — change language\n\nSupport: contact admin.",
    soon: "⏳ This section is coming soon.",
  },
};

function safeLang(lang) {
  return UI[lang] ? lang : "uz";
}

function homeKeyboard(lang) {
  lang = safeLang(lang);
  const t = UI[lang];

  return Markup.keyboard(
    [
      [t.btnQueue, t.btnMy],
      [t.btnServices, t.btnLang],
      [t.btnHelp],
    ],
    { columns: 2 }
  )
    .resize()
    .persistent();
}

function langInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🇺🇿 O‘zbek", "LANG_uz")],
    [Markup.button.callback("🇷🇺 Русский", "LANG_ru")],
    [Markup.button.callback("🇬🇧 English", "LANG_en")],
  ]);
}

async function sendHome(ctx, lang) {
  lang = safeLang(lang);
  const t = UI[lang];
  await ctx.replyWithMarkdown(`${t.title}\n\n${t.desc}`, homeKeyboard(lang));
}

// ====== WEB API (tilni saqlash) ======
app.post("/api/lang", async (req, res) => {
  try {
    const { web_session, lang } = req.body || {};
    const safe = ["uz", "ru", "en"].includes(lang) ? lang : "uz";
    if (!web_session)
      return res.status(400).json({ ok: false, error: "web_session required" });

    await pool.query(
      `
      INSERT INTO user_prefs (web_session, lang)
      VALUES ($1, $2)
      ON CONFLICT (web_session)
      DO UPDATE SET lang = EXCLUDED.lang, updated_at = NOW();
      `,
      [web_session, safe]
    );

    res.json({ ok: true, lang: safe });
  } catch (e) {
    console.error("POST /api/lang error:", e);
    res.status(500).json({ ok: false });
  }
});

// ====== QUEUE API ======
app.post("/api/take", async (req, res) => {
  try {
    const ticket = await createTicket();
    res.json({ ok: true, ...ticket });
  } catch (e) {
    console.error("POST /api/take error:", e);
    res.status(500).json({ ok: false });
  }
});

app.get("/api/ticket/:ticketId", async (req, res) => {
  try {
    const { ticketId } = req.params;
    const ticket = await getTicket(ticketId);
    if (!ticket) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, ...ticket });
  } catch (e) {
    console.error("GET /api/ticket/:ticketId error:", e);
    res.status(500).json({ ok: false });
  }
});

// (ixtiyoriy) admin/test endpoint: keyingi ticketni chaqirish
app.post("/api/admin/next", async (req, res) => {
  try {
    const next = await callNextTicket();
    if (!next) return res.json({ ok: true, message: "no_waiting_tickets" });
    res.json({ ok: true, ...next });
  } catch (e) {
    console.error("POST /api/admin/next error:", e);
    res.status(500).json({ ok: false });
  }
});

// ====== TELEGRAM BOT (webhook mode) ======
let bot = null;

async function startBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.log("BOT_TOKEN not set -> bot will not start.");
    return;
  }

  bot = new Telegraf(token);

  // /start
  bot.start(async (ctx) => {
    const currentLang = await getTelegramLang(ctx.from.id);

    if (currentLang && ["uz", "ru", "en"].includes(currentLang)) {
      await sendHome(ctx, currentLang);
      return;
    }

    await ctx.reply(TEXT.uz.intro);
    await new Promise((r) => setTimeout(r, 2500));
    await ctx.reply(TEXT.ru.intro);
    await new Promise((r) => setTimeout(r, 2500));
    await ctx.reply(TEXT.en.intro);
    await new Promise((r) => setTimeout(r, 800));
    await ctx.reply(TEXT.uz.chooseLang, langInlineKeyboard());
  });

  // Til tanlash
  bot.action(/^LANG_(uz|ru|en)$/, async (ctx) => {
    const lang = ctx.match[1];
    await setTelegramLang(ctx.from.id, lang);
    await ctx.answerCbQuery("✅ OK");

    const t = TEXT[lang] || TEXT.uz;
    await ctx.reply(t.saved);
    await sendHome(ctx, lang);
  });

  // 🌐 Til tugmasi
  bot.hears([UI.uz.btnLang, UI.ru.btnLang, UI.en.btnLang], async (ctx) => {
    const lang = await getTelegramLang(ctx.from.id);
    const L = safeLang(lang);
    await ctx.reply(TEXT[L].chooseLang, langInlineKeyboard());
  });

  // ℹ️ Yordam
  bot.hears([UI.uz.btnHelp, UI.ru.btnHelp, UI.en.btnHelp], async (ctx) => {
    const lang = await getTelegramLang(ctx.from.id);
    const t = UI[safeLang(lang)];
    await ctx.replyWithMarkdown(t.helpText, homeKeyboard(safeLang(lang)));
  });

  // 🎫 Navbat olish — endi REAL
  bot.hears([UI.uz.btnQueue, UI.ru.btnQueue, UI.en.btnQueue], async (ctx) => {
    const lang = await getTelegramLang(ctx.from.id);
    const t = UI[safeLang(lang)];

    try {
      const ticket = await createTicket();
      await setTelegramLastTicket(ctx.from.id, ticket.ticketId);

      await ctx.replyWithMarkdown(
        `🎫 *Ticket tayyor!*\n\n` +
          `Raqam: *${ticket.number}*\n` +
          `Status: *${ticket.status}*\n` +
          `Navbatdagi o‘rin: *${ticket.queuePosition}*\n` +
          `Taxminiy: *${ticket.estimatedMinutes} min*\n\n` +
          `Ticket ID: \`${ticket.ticketId}\``,
        homeKeyboard(safeLang(lang))
      );
    } catch (e) {
      console.error("bot take error:", e);
      await ctx.reply(`❌ Xatolik: ticket yaratib bo‘lmadi.`, homeKeyboard(safeLang(lang)));
    }
  });

  // 📊 Mening navbatim — oxirgi ticket status
  bot.hears([UI.uz.btnMy, UI.ru.btnMy, UI.en.btnMy], async (ctx) => {
    const lang = await getTelegramLang(ctx.from.id);
    const t = UI[safeLang(lang)];

    try {
      const last = await getTelegramLastTicket(ctx.from.id);
      if (!last) {
        await ctx.reply(
          `📊 Sizda hali ticket yo‘q.\nAvval "${t.btnQueue}" bosing.`,
          homeKeyboard(safeLang(lang))
        );
        return;
      }

      const ticket = await getTicket(last);
      if (!ticket) {
        await ctx.reply(
          `📊 Oxirgi ticket topilmadi.\nYana "${t.btnQueue}" bosing.`,
          homeKeyboard(safeLang(lang))
        );
        return;
      }

      await ctx.replyWithMarkdown(
        `📊 *Mening navbatim*\n\n` +
          `Raqam: *${ticket.number}*\n` +
          `Status: *${ticket.status}*\n` +
          `Navbatdagi o‘rin: *${ticket.queuePosition}*\n` +
          `Taxminiy: *${ticket.estimatedMinutes} min*\n\n` +
          `Ticket ID: \`${ticket.ticketId}\``,
        homeKeyboard(safeLang(lang))
      );
    } catch (e) {
      console.error("bot my error:", e);
      await ctx.reply(`❌ Xatolik: ticket status olib bo‘lmadi.`, homeKeyboard(safeLang(lang)));
    }
  });

  // 🧾 Xizmatlar (placeholder)
  bot.hears([UI.uz.btnServices, UI.ru.btnServices, UI.en.btnServices], async (ctx) => {
    const lang = await getTelegramLang(ctx.from.id);
    const t = UI[safeLang(lang)];
    await ctx.reply(t.soon, homeKeyboard(safeLang(lang)));
  });

  // ====== WEBHOOK SETUP ======
  const base = process.env.WEBHOOK_URL;
  if (!base) {
    console.log("WEBHOOK_URL not set -> bot will not start.");
    return;
  }

  const webhookPath = `/telegram/webhook/${process.env.BOT_TOKEN.slice(0, 12)}`;
  const webhookUrl = base.replace(/\/$/, "") + webhookPath;

  app.post(webhookPath, (req, res) => {
    bot.handleUpdate(req.body, res);
  });

  await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
  console.log("Telegram bot started (webhook mode).");
}

// ====== START ======
(async () => {
  try {
    await initDb();
    console.log("DB ready.");

    app.listen(PORT, () => {
      console.log("Server running on port", PORT);
    });

    await startBot();
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
