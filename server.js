const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
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

// DB init (til jadvali)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      web_session TEXT UNIQUE,
      lang TEXT NOT NULL DEFAULT 'uz',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      "ℹ️ *Yordam*\n\n1) 🎫 Navbat olish — viloyat/tuman/xizmat tanlaysiz\n2) 📊 Mening navbatim — ticket holati\n3) 🌐 Til — tilni o‘zgartirish\n\nTexnik yordam: admin bilan bog‘laning.",
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
      "ℹ️ *Помощь*\n\n1) 🎫 Взять очередь — выбираете область/район/услугу\n2) 📊 Моя очередь — статус талона\n3) 🌐 Язык — сменить язык\n\nТехподдержка: свяжитесь с админом.",
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
      "ℹ️ *Help*\n\n1) 🎫 Take a ticket — choose region/district/service\n2) 📊 My ticket — ticket status\n3) 🌐 Language — change language\n\nSupport: contact admin.",
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

// ====== TELEGRAM BOT (webhook mode) ======
let bot = null;

async function startBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.log("BOT_TOKEN not set -> bot will not start.");
    return;
  }

  bot = new Telegraf(token);

  // /start — birinchi kirishda til tanlash + chiroyli home
  bot.start(async (ctx) => {
    const currentLang = await getTelegramLang(ctx.from.id);

    // Agar user oldin tanlagan bo'lsa — direkt home
    if (currentLang && ["uz", "ru", "en"].includes(currentLang)) {
      // istasangiz intro ham ko'rsatadi:
      // await ctx.reply(TEXT[currentLang].intro);
      await sendHome(ctx, currentLang);
      return;
    }

    // Default: intro + til tanlash
    await ctx.reply(TEXT.uz.intro);
    await new Promise((r) => setTimeout(r, 2500));
    await ctx.reply(TEXT.ru.intro);
    await new Promise((r) => setTimeout(r, 2500));
    await ctx.reply(TEXT.en.intro);
    await new Promise((r) => setTimeout(r, 800));
    await ctx.reply(TEXT.uz.chooseLang, langInlineKeyboard());
  });

  // Tilni inline tugma orqali tanlash
  bot.action(/^LANG_(uz|ru|en)$/, async (ctx) => {
    const lang = ctx.match[1];
    await setTelegramLang(ctx.from.id, lang);
    await ctx.answerCbQuery("✅ OK");

    const t = TEXT[lang] || TEXT.uz;
    await ctx.reply(t.saved);

    // Home menyu
    await sendHome(ctx, lang);
  });

  // 🌐 Til tugmasi (keyboard)
  bot.hears(
    [UI.uz.btnLang, UI.ru.btnLang, UI.en.btnLang],
    async (ctx) => {
      const lang = await getTelegramLang(ctx.from.id);
      const L = safeLang(lang);
      await ctx.reply(TEXT[L].chooseLang, langInlineKeyboard());
    }
  );

  // ℹ️ Yordam
  bot.hears(
    [UI.uz.btnHelp, UI.ru.btnHelp, UI.en.btnHelp],
    async (ctx) => {
      const lang = await getTelegramLang(ctx.from.id);
      const t = UI[safeLang(lang)];
      await ctx.replyWithMarkdown(t.helpText, homeKeyboard(safeLang(lang)));
    }
  );

  // 🎫 Navbat olish (hozircha placeholder)
  bot.hears(
    [UI.uz.btnQueue, UI.ru.btnQueue, UI.en.btnQueue],
    async (ctx) => {
      const lang = await getTelegramLang(ctx.from.id);
      const t = UI[safeLang(lang)];
      await ctx.reply(`${t.soon}\n\n(Keyingi bosqich: Viloyat → Tuman → Xizmat → Punkt)`);
    }
  );

  // 📊 Mening navbatim (placeholder)
  bot.hears(
    [UI.uz.btnMy, UI.ru.btnMy, UI.en.btnMy],
    async (ctx) => {
      const lang = await getTelegramLang(ctx.from.id);
      const t = UI[safeLang(lang)];
      await ctx.reply(t.soon);
    }
  );

  // 🧾 Xizmatlar (placeholder)
  bot.hears(
    [UI.uz.btnServices, UI.ru.btnServices, UI.en.btnServices],
    async (ctx) => {
      const lang = await getTelegramLang(ctx.from.id);
      const t = UI[safeLang(lang)];
      await ctx.reply(t.soon);
    }
  );

  // ====== WEBHOOK SETUP ======
  const base = process.env.WEBHOOK_URL;
  if (!base) {
    console.log("WEBHOOK_URL not set -> bot will not start.");
    return;
  }

  // tokenni URLga to'liq qo'ymaslik uchun bir qismini ishlatamiz
  const webhookPath = `/telegram/webhook/${process.env.BOT_TOKEN.slice(0, 12)}`;
  const webhookUrl = base.replace(/\/$/, "") + webhookPath;

  // Telegram update’larni shu endpointga yuboradi
  app.post(webhookPath, (req, res) => {
    bot.handleUpdate(req.body, res);
  });

  // Webhookni o'rnatamiz (pending update'larni ham tozalaydi)
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
