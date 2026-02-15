const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Telegraf, Markup } = require("telegraf");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ===== ENV =====
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const AVG_SERVICE_MIN = Number(process.env.AVG_SERVICE_MIN || 5);

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // masalan: https://navbatuz.onrender.com
const WEBAPP_URL = process.env.WEBAPP_URL || ""; // telegram webapp bo'lsa
// ixtiyoriy admin chat id (telegramda staff tugmalar uchun)
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

// ===== DB =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS queue (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT,
      chat_id BIGINT,
      status TEXT DEFAULT 'WAIT', -- WAIT | NOW | SERVED
      acknowledged BOOLEAN DEFAULT FALSE,
      notified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // migratsiya uchun
  await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'WAIT';`);
  await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS notified BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);

  console.log("Database ready");
}
initDB().catch((e) => console.error("DB init error:", e));

// ===== HELPERS =====
function etaTextFromAhead(ahead) {
  const min = Math.max(0, Number(ahead || 0)) * AVG_SERVICE_MIN;
  if (min <= 0) return "Hozir kirishingiz mumkin";
  return `${min} minut`;
}

async function getNowIdOrAuto() {
  // real NOW
  const nowQ = await pool.query("SELECT id FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
  if (nowQ.rowCount) return Number(nowQ.rows[0].id);

  // agar NOW yo'q bo'lsa: birinchi WAIT ni auto NOW deb ko'rsatamiz (frontend/telegram uchun)
  const firstWait = await pool.query("SELECT id FROM queue WHERE status='WAIT' ORDER BY id ASC LIMIT 1");
  return firstWait.rowCount ? Number(firstWait.rows[0].id) : null;
}

async function getWaitCount() {
  const q = await pool.query("SELECT COUNT(*)::int AS c FROM queue WHERE status='WAIT'");
  return q.rows[0].c;
}

async function getTicketStats(ticketId) {
  const t = await pool.query("SELECT id,status,chat_id,acknowledged FROM queue WHERE id=$1", [ticketId]);
  if (!t.rowCount) return null;

  const nowIdRealQ = await pool.query("SELECT id FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
  const nowIdReal = nowIdRealQ.rowCount ? Number(nowIdRealQ.rows[0].id) : null;

  const autoNowId = await getNowIdOrAuto();
  let status = t.rows[0].status || "WAIT";

  if (status !== "SERVED") {
    status = autoNowId && autoNowId === Number(ticketId) ? "NOW" : "WAIT";
  }

  let ahead = 0;
  if (status === "WAIT") {
    // oldin WAIT lar
    const aheadWaitQ = await pool.query(
      "SELECT COUNT(*)::int AS c FROM queue WHERE status='WAIT' AND id < $1",
      [ticketId]
    );
    ahead = aheadWaitQ.rows[0].c;

    // agar real NOW bor bo'lsa va u ticketId dan kichik bo'lsa, oldinda 1 ta bo'ladi
    if (nowIdReal && nowIdReal < ticketId) ahead += 1;
  }

  const wait_count = await getWaitCount();
  const eta = etaTextFromAhead(ahead);

  return {
    ticket_id: Number(ticketId),
    status,
    ahead,
    wait_count,
    eta,
    avg_service_min: AVG_SERVICE_MIN,
    now_id: autoNowId,
    acknowledged: !!t.rows[0].acknowledged,
    chat_id: t.rows[0].chat_id ? Number(t.rows[0].chat_id) : null,
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(500).json({ success: false, error: "ADMIN_KEY Render ENV da yo‘q" });
  const k = req.headers["x-admin-key"] || "";
  if (k !== ADMIN_KEY) return res.status(401).json({ success: false, error: "Admin key noto‘g‘ri" });
  next();
}

// ===== TELEGRAM BOT =====
let bot = null;

function isAdminChat(ctx) {
  if (!ADMIN_CHAT_ID) return false;
  return ctx.chat && Number(ctx.chat.id) === Number(ADMIN_CHAT_ID);
}

function makeUserButtons(ticketId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Holatim 🔄", `st:${ticketId}`)],
    [
      Markup.button.callback("Navbatim keldi ✅", `ack:${ticketId}`),
      Markup.button.callback("Hali kelmadi ⏳", `no:${ticketId}`),
    ],
    [
      Markup.button.callback("Xizmat tugadi ✅", `done:${ticketId}`),
      Markup.button.callback("Navbatdan chiqish ❌", `leave:${ticketId}`),
    ],
  ]);
}

function makeAdminButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Oldingi", "admin:prev"), Markup.button.callback("➡️ Keyingi", "admin:next")],
    [Markup.button.callback("🧹 Tozalash", "admin:clear")],
    [Markup.button.callback("🔄 Yangilash", "admin:list")],
  ]);
}

async function sendTicketMessage(ctx, ticketId, prefix = "✅ Navbat olindi!") {
  const st = await getTicketStats(ticketId);
  if (!st) return ctx.reply("Chipta topilmadi.");

  const text =
    `${prefix}\n\n` +
    `🎟 Ticket: ${st.ticket_id}\n` +
    `📌 Holat: ${st.status}\n` +
    `👥 Oldingizda: ${st.ahead}\n` +
    `⏳ Kutayotganlar (WAIT): ${st.wait_count}\n` +
    `🕒 Kutish: ${st.eta}\n`;

  return ctx.reply(text, makeUserButtons(st.ticket_id));
}

async function notifyIfNowChanged() {
  if (!bot) return;

  // real NOW bo'lsa - o'shani notif qilamiz
  const nowRealQ = await pool.query("SELECT id, chat_id, notified FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
  if (!nowRealQ.rowCount) return;

  const row = nowRealQ.rows[0];
  const nowId = Number(row.id);
  const chatId = row.chat_id ? Number(row.chat_id) : null;
  const notified = !!row.notified;

  if (!chatId) return;
  if (notified) return;

  // notif yuborish
  try {
    await bot.telegram.sendMessage(
      chatId,
      `🎉 NAVBATINGIZ KELDI!\n🎟 Ticket: ${nowId}\n\nPastdagi tugmalar orqali holatingizni boshqaring.`,
      makeUserButtons(nowId)
    );
    await pool.query("UPDATE queue SET notified=TRUE WHERE id=$1", [nowId]);
  } catch (e) {
    console.error("Notify error:", e.message);
  }
}

// telegram init
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    const kb = Markup.keyboard([
      [Markup.button.contactRequest("📲 Telefon yuborish (navbat olish)")],
      ["🎟 Holatim", "❌ Navbatdan chiqish"],
    ])
      .resize()
      .oneTime(false);

    let msg =
      "Assalomu alaykum! NAVBATUZ bot.\n\n" +
      "✅ Navbat olish uchun: *📲 Telefon yuborish* tugmasini bosing.\n" +
      "🎟 Holatni ko‘rish: *Holatim*\n" +
      "❌ Navbatdan chiqish: *Navbatdan chiqish*\n";

    if (WEBAPP_URL) {
      msg += "\n🌐 Web orqali: pastdagi tugma (WebApp) ham bo'lishi mumkin.";
    }

    await ctx.replyWithMarkdown(msg, kb);

    if (WEBAPP_URL) {
      await ctx.reply(
        "Web orqali navbat olish:",
        Markup.inlineKeyboard([[Markup.button.webApp("🌐 WebApp ochish", WEBAPP_URL)]])
      );
    }

    if (isAdminChat(ctx)) {
      await ctx.reply("👑 Admin panel (telegramdan):", makeAdminButtons());
    }
  });

  // contact => ticket yaratamiz
  bot.on("contact", async (ctx) => {
    try {
      const c = ctx.message.contact;
      const name = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim() || "No name";
      const phone = c.phone_number ? (c.phone_number.startsWith("+") ? c.phone_number : `+${c.phone_number}`) : "unknown";
      const chatId = Number(ctx.chat.id);

      // avvalgi active ticket bo'lsa qaytaramiz (WAIT/NOW)
      const existing = await pool.query(
        "SELECT id FROM queue WHERE chat_id=$1 AND status IN ('WAIT','NOW') ORDER BY id DESC LIMIT 1",
        [chatId]
      );
      if (existing.rowCount) {
        return sendTicketMessage(ctx, Number(existing.rows[0].id), "Sizda aktiv navbat bor:");
      }

      const r = await pool.query(
        "INSERT INTO queue (name, phone, chat_id, status) VALUES ($1,$2,$3,'WAIT') RETURNING id",
        [name, phone, chatId]
      );

      await sendTicketMessage(ctx, Number(r.rows[0].id), "✅ Navbat olindi!");
    } catch (e) {
      console.error("Contact take error:", e);
      ctx.reply("Xatolik bo‘ldi. Keyinroq qayta urinib ko‘ring.");
    }
  });

  // text commands
  bot.hears("🎟 Holatim", async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const q = await pool.query(
      "SELECT id FROM queue WHERE chat_id=$1 AND status IN ('WAIT','NOW') ORDER BY id DESC LIMIT 1",
      [chatId]
    );
    if (!q.rowCount) return ctx.reply("Sizda aktiv navbat yo‘q. 📲 Telefon yuborib navbat oling.");
    return sendTicketMessage(ctx, Number(q.rows[0].id), "🎟 Sizning holatingiz:");
  });

  bot.hears("❌ Navbatdan chiqish", async (ctx) => {
    const chatId = Number(ctx.chat.id);
    const q = await pool.query(
      "SELECT id,status FROM queue WHERE chat_id=$1 AND status IN ('WAIT','NOW') ORDER BY id DESC LIMIT 1",
      [chatId]
    );
    if (!q.rowCount) return ctx.reply("Sizda aktiv navbat yo‘q.");

    const id = Number(q.rows[0].id);
    const st = q.rows[0].status;
    if (st === "NOW") return ctx.reply("Sizning navbatingiz kelgan. Admin bilan bog‘laning.");

    await pool.query("DELETE FROM queue WHERE id=$1", [id]);
    ctx.reply("✅ Navbatdan chiqdingiz. Kerak bo‘lsa qayta navbat olishingiz mumkin.");
  });

  // callback: user actions
  bot.on("callback_query", async (ctx) => {
    try {
      const data = ctx.callbackQuery.data || "";
      const chatId = Number(ctx.chat.id);

      // admin actions
      if (data.startsWith("admin:")) {
        if (!isAdminChat(ctx)) {
          await ctx.answerCbQuery("Admin emassiz");
          return;
        }

        if (data === "admin:list") {
          const list = await pool.query(
            "SELECT id,name,phone,status FROM queue ORDER BY id ASC LIMIT 50"
          );
          const nowId = await getNowIdOrAuto();
          const waitCount = await getWaitCount();

          const text =
            `📋 Navbat ro‘yxati (50 ta):\n` +
            `NOW: ${nowId ?? "—"} | WAIT: ${waitCount}\n\n` +
            list.rows.map((r) => `#${r.id} ${r.status} - ${r.name || ""}`).join("\n");

          await ctx.editMessageText(text, makeAdminButtons());
          await ctx.answerCbQuery("OK");
          return;
        }

        if (data === "admin:next") {
          // NOW -> SERVED
          const nowQ = await pool.query("SELECT id FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
          if (nowQ.rowCount) {
            await pool.query("UPDATE queue SET status='SERVED' WHERE id=$1", [nowQ.rows[0].id]);
          }

          // next WAIT -> NOW
          const nextQ = await pool.query("SELECT id FROM queue WHERE status='WAIT' ORDER BY id ASC LIMIT 1");
          if (nextQ.rowCount) {
            const nextId = Number(nextQ.rows[0].id);
            await pool.query("UPDATE queue SET status='NOW', notified=FALSE WHERE id=$1", [nextId]);
          }

          await notifyIfNowChanged();
          await ctx.answerCbQuery("Keyingi chaqirildi");
          return;
        }

        if (data === "admin:prev") {
          const nowQ = await pool.query("SELECT id FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
          if (!nowQ.rowCount) {
            await ctx.answerCbQuery("NOW yo‘q");
            return;
          }
          const nowId = Number(nowQ.rows[0].id);

          // hozirgini WAIT
          await pool.query("UPDATE queue SET status='WAIT', notified=FALSE WHERE id=$1", [nowId]);

          // oldingi WAIT -> NOW
          const prevQ = await pool.query(
            "SELECT id FROM queue WHERE status='WAIT' AND id < $1 ORDER BY id DESC LIMIT 1",
            [nowId]
          );

          if (!prevQ.rowCount) {
            // rollback
            await pool.query("UPDATE queue SET status='NOW' WHERE id=$1", [nowId]);
            await ctx.answerCbQuery("Oldingi topilmadi");
            return;
          }

          const prevId = Number(prevQ.rows[0].id);
          await pool.query("UPDATE queue SET status='NOW', notified=FALSE WHERE id=$1", [prevId]);

          await notifyIfNowChanged();
          await ctx.answerCbQuery("Oldingi chaqirildi");
          return;
        }

        if (data === "admin:clear") {
          await pool.query("TRUNCATE TABLE queue RESTART IDENTITY");
          await ctx.answerCbQuery("Tozalandi");
          return;
        }
      }

      // user actions
      const [cmd, idStr] = data.split(":");
      const id = Number(idStr);
      if (!id) {
        await ctx.answerCbQuery("Noto‘g‘ri");
        return;
      }

      // ticket chat owner tekshirish (faqat o'zi bossin)
      const ownerQ = await pool.query("SELECT chat_id,status FROM queue WHERE id=$1", [id]);
      if (!ownerQ.rowCount) {
        await ctx.answerCbQuery("Chipta topilmadi");
        return;
      }
      const ownerChat = ownerQ.rows[0].chat_id ? Number(ownerQ.rows[0].chat_id) : null;
      const statusReal = ownerQ.rows[0].status;

      if (ownerChat && ownerChat !== chatId && !isAdminChat(ctx)) {
        await ctx.answerCbQuery("Bu sizning chiptangiz emas");
        return;
      }

      if (cmd === "st") {
        const st = await getTicketStats(id);
        if (!st) return ctx.answerCbQuery("Topilmadi");
        const text =
          `🎟 Ticket: ${st.ticket_id}\n` +
          `📌 Holat: ${st.status}\n` +
          `👥 Oldingizda: ${st.ahead}\n` +
          `⏳ Kutayotganlar (WAIT): ${st.wait_count}\n` +
          `🕒 Kutish: ${st.eta}`;
        await ctx.editMessageText(text, makeUserButtons(id));
        await ctx.answerCbQuery("Yangilandi");
        return;
      }

      if (cmd === "ack") {
        await pool.query("UPDATE queue SET acknowledged=TRUE WHERE id=$1", [id]);
        await ctx.answerCbQuery("Qabul qilindi ✅");
        return;
      }

      if (cmd === "no") {
        await pool.query("UPDATE queue SET acknowledged=FALSE WHERE id=$1", [id]);
        await ctx.answerCbQuery("OK ⏳");
        return;
      }

      if (cmd === "done") {
        // faqat NOW bo'lsa SERVED
        const st = await getTicketStats(id);
        if (!st) return ctx.answerCbQuery("Topilmadi");
        if (st.status !== "NOW") {
          await ctx.answerCbQuery("Hali navbat kelmagan");
          return;
        }
        await pool.query("UPDATE queue SET status='SERVED' WHERE id=$1", [id]);
        await ctx.answerCbQuery("Xizmat tugadi ✅");

        // keyingini avtomatik chaqirib yuboramiz
        const nextQ = await pool.query("SELECT id FROM queue WHERE status='WAIT' ORDER BY id ASC LIMIT 1");
        if (nextQ.rowCount) {
          const nextId = Number(nextQ.rows[0].id);
          await pool.query("UPDATE queue SET status='NOW', notified=FALSE WHERE id=$1", [nextId]);
        }
        await notifyIfNowChanged();
        return;
      }

      if (cmd === "leave") {
        if (statusReal === "NOW") {
          await ctx.answerCbQuery("Navbat kelgan, chiqib bo‘lmaydi");
          return;
        }
        await pool.query("DELETE FROM queue WHERE id=$1", [id]);
        await ctx.answerCbQuery("Chiqdingiz ❌");
        try {
          await ctx.editMessageText("Siz navbatdan chiqdingiz. Qayta navbat olish uchun /start bosing.");
        } catch {}
        return;
      }

      await ctx.answerCbQuery("OK");
    } catch (e) {
      console.error("callback error:", e);
      try {
        await ctx.answerCbQuery("Xatolik");
      } catch {}
    }
  });

  // webhook/polling setup
  (async () => {
    try {
      const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 16);
      const webhookPath = `/tg/webhook/${secret}`;

      if (WEBHOOK_URL) {
        // webhook
        const fullUrl = `${WEBHOOK_URL}${webhookPath}`;
        await bot.telegram.setWebhook(fullUrl);
        app.use(bot.webhookCallback(webhookPath));
        console.log("Telegram webhook set:", fullUrl);
      } else {
        // polling (faqat 1 instans bo'lsa)
        await bot.launch();
        console.log("Telegram bot launched via polling");
      }
    } catch (e) {
      console.error("Bot init error:", e.message);
    }
  })();
} else {
  console.log("BOT_TOKEN yo'q: telegram bot o'chirilgan");
}

// ===== API =====
app.get("/api/test", (req, res) => res.json({ success: true, message: "API working" }));

app.post("/api/take", async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    const phone = (req.body?.phone || "").trim();
    if (!name) return res.status(400).json({ success: false, error: "Ism kiriting" });
    if (!phone) return res.status(400).json({ success: false, error: "Telefon kiriting" });

    const r = await pool.query(
      "INSERT INTO queue (name, phone, status) VALUES ($1,$2,'WAIT') RETURNING id",
      [name, phone]
    );

    const ticket_id = Number(r.rows[0].id);
    const st = await getTicketStats(ticket_id);

    res.json({ success: true, ticket_id, ...st });
  } catch (err) {
    console.error("TAKE error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/ticket", async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ success: false, error: "id noto‘g‘ri" });

    const st = await getTicketStats(id);
    if (!st) return res.status(404).json({ success: false, error: "Chipta topilmadi" });

    res.json({ success: true, ...st });
  } catch (err) {
    console.error("TICKET error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== ADMIN API =====
app.get("/api/admin/list", requireAdmin, async (req, res) => {
  const r = await pool.query(
    "SELECT id,name,phone,status,acknowledged,notified,to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at FROM queue ORDER BY id ASC LIMIT 500"
  );
  const now_id = await getNowIdOrAuto();
  const wait_count = await getWaitCount();
  res.json({ success: true, items: r.rows, now_id, wait_count });
});

app.post("/api/admin/next", requireAdmin, async (req, res) => {
  const nowQ = await pool.query("SELECT id FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
  if (nowQ.rowCount) {
    await pool.query("UPDATE queue SET status='SERVED' WHERE id=$1", [nowQ.rows[0].id]);
  }

  const nextQ = await pool.query("SELECT id FROM queue WHERE status='WAIT' ORDER BY id ASC LIMIT 1");
  if (!nextQ.rowCount) {
    return res.json({ success: true, message: "Navbat bo‘sh" });
  }

  const nextId = Number(nextQ.rows[0].id);
  await pool.query("UPDATE queue SET status='NOW', notified=FALSE WHERE id=$1", [nextId]);

  await notifyIfNowChanged();
  res.json({ success: true, now_id: nextId });
});

app.post("/api/admin/prev", requireAdmin, async (req, res) => {
  const nowQ = await pool.query("SELECT id FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
  if (!nowQ.rowCount) return res.json({ success: true, message: "NOW yo‘q" });

  const nowId = Number(nowQ.rows[0].id);
  await pool.query("UPDATE queue SET status='WAIT', notified=FALSE WHERE id=$1", [nowId]);

  const prevQ = await pool.query(
    "SELECT id FROM queue WHERE status='WAIT' AND id < $1 ORDER BY id DESC LIMIT 1",
    [nowId]
  );

  if (!prevQ.rowCount) {
    await pool.query("UPDATE queue SET status='NOW' WHERE id=$1", [nowId]);
    return res.json({ success: true, message: "Oldingi topilmadi" });
  }

  const prevId = Number(prevQ.rows[0].id);
  await pool.query("UPDATE queue SET status='NOW', notified=FALSE WHERE id=$1", [prevId]);

  await notifyIfNowChanged();
  res.json({ success: true, now_id: prevId });
});

app.post("/api/admin/serve", requireAdmin, async (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  await pool.query("UPDATE queue SET status='SERVED' WHERE id=$1", [id]);

  // agar SERVED qilingan ticket NOW bo'lsa, keyingisini NOW qilamiz
  const nowRealQ = await pool.query("SELECT id FROM queue WHERE status='NOW' ORDER BY id ASC LIMIT 1");
  if (!nowRealQ.rowCount) {
    const nextQ = await pool.query("SELECT id FROM queue WHERE status='WAIT' ORDER BY id ASC LIMIT 1");
    if (nextQ.rowCount) {
      const nextId = Number(nextQ.rows[0].id);
      await pool.query("UPDATE queue SET status='NOW', notified=FALSE WHERE id=$1", [nextId]);
      await notifyIfNowChanged();
    }
  }

  res.json({ success: true });
});

app.post("/api/admin/delete", requireAdmin, async (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  await pool.query("DELETE FROM queue WHERE id=$1", [id]);
  res.json({ success: true });
});

app.post("/api/admin/clear", requireAdmin, async (req, res) => {
  await pool.query("TRUNCATE TABLE queue RESTART IDENTITY");
  res.json({ success: true });
});

// ===== ADMIN PAGE (/admin) =====
app.get("/admin", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="uz">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NAVBATUZ Admin</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f6f7fb;margin:0;padding:16px}
    .wrap{max-width:1100px;margin:0 auto}
    .card{background:#fff;border-radius:14px;box-shadow:0 12px 30px rgba(0,0,0,.12);padding:16px;margin-bottom:14px}
    h1{margin:0 0 10px}
    input,button{padding:10px;border-radius:10px;border:1px solid #ddd;font-size:14px}
    button{border:0;cursor:pointer}
    .btn{background:#5b2cff;color:#fff}
    .btn2{background:#111;color:#fff}
    .danger{background:#ff2c55;color:#fff}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px;border-bottom:1px solid #eee;font-size:14px;text-align:left}
    .pill{padding:4px 10px;border-radius:999px;background:#f2f3ff;display:inline-block}
    .muted{color:#666}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>NAVBATUZ Admin</h1>
      <div class="row">
        <input id="key" placeholder="ADMIN_KEY kiriting" style="min-width:240px"/>
        <button class="btn" id="saveKey">Saqlash</button>
        <span class="muted" id="msg"></span>
      </div>
      <p class="muted">/admin ochilishi uchun alohida fayl kerak emas — server o‘zi beradi.</p>
    </div>

    <div class="card">
      <div class="row">
        <button class="btn2" id="refresh">Yangilash</button>
        <button class="btn" id="prev">Oldingi</button>
        <button class="btn" id="next">Keyingi</button>
        <button class="danger" id="clear">Tozalash</button>
      </div>
      <p class="muted">Keyingi = NOW → SERVED, next WAIT → NOW. (Telegramga “Navbatingiz keldi” xabari ketadi)</p>
    </div>

    <div class="card">
      <div class="row">
        <div class="pill">NOW: <b id="now">—</b></div>
        <div class="pill">WAIT count: <b id="wc">—</b></div>
      </div>
    </div>

    <div class="card">
      <h3>Navbat ro‘yxati</h3>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Ism</th><th>Telefon</th><th>Status</th><th>Ack</th><th>Created</th><th>Action</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>

<script>
  const msg = document.getElementById("msg");
  const tbody = document.getElementById("tbody");
  const nowEl = document.getElementById("now");
  const wcEl = document.getElementById("wc");

  function getKey(){ return localStorage.getItem("ADMIN_KEY") || ""; }
  function setKey(v){ localStorage.setItem("ADMIN_KEY", v); }

  document.getElementById("key").value = getKey();

  async function api(path, opts={}){
    const res = await fetch(path, {
      headers: { "Content-Type":"application/json", "x-admin-key": getKey() },
      ...opts
    });
    const data = await res.json().catch(()=> ({}));
    if(!res.ok) throw new Error(data.error || "Xatolik");
    return data;
  }

  function render(items){
    tbody.innerHTML = "";
    for(const r of items){
      const tr = document.createElement("tr");
      tr.innerHTML = \`
        <td>\${r.id}</td>
        <td>\${r.name || ""}</td>
        <td>\${r.phone || ""}</td>
        <td><span class="pill">\${r.status}</span></td>
        <td>\${r.acknowledged ? "✅" : "—"}</td>
        <td>\${r.created_at}</td>
        <td class="row">
          <button class="btn2" data-serve="\${r.id}">SERVED</button>
          <button class="danger" data-del="\${r.id}">DEL</button>
        </td>
      \`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll("[data-serve]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        await api(\`/api/admin/serve?id=\${encodeURIComponent(b.getAttribute("data-serve"))}\`, {method:"POST"});
        await load();
      });
    });
    tbody.querySelectorAll("[data-del]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        if(!confirm("O‘chirasizmi?")) return;
        await api(\`/api/admin/delete?id=\${encodeURIComponent(b.getAttribute("data-del"))}\`, {method:"POST"});
        await load();
      });
    });
  }

  async function load(){
    try{
      msg.textContent = "Yuklanmoqda...";
      const r = await api("/api/admin/list");
      render(r.items);
      nowEl.textContent = r.now_id ?? "—";
      wcEl.textContent = r.wait_count ?? "—";
      msg.textContent = "OK";
    }catch(e){
      msg.textContent = e.message;
    }
  }

  document.getElementById("saveKey").addEventListener("click", ()=>{
    setKey(document.getElementById("key").value.trim());
    msg.textContent = "Saqlandi";
  });

  document.getElementById("refresh").addEventListener("click", load);

  document.getElementById("next").addEventListener("click", async ()=>{
    try{ await api("/api/admin/next", {method:"POST"}); await load(); }
    catch(e){ msg.textContent = e.message; }
  });

  document.getElementById("prev").addEventListener("click", async ()=>{
    try{ await api("/api/admin/prev", {method:"POST"}); await load(); }
    catch(e){ msg.textContent = e.message; }
  });

  document.getElementById("clear").addEventListener("click", async ()=>{
    if(!confirm("Hammasini tozalaysizmi?")) return;
    try{ await api("/api/admin/clear", {method:"POST"}); await load(); }
    catch(e){ msg.textContent = e.message; }
  });

  load();
</script>
</body>
</html>`);
});

// ===== STATIC =====
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log("Server running on port " + PORT));
