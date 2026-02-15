require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { Telegraf, Markup } = require("telegraf");
const QRCode = require("qrcode");
const Jimp = require("jimp");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// ENV
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // masalan: https://navbatuz.onrender.com
const WEBAPP_URL = process.env.WEBAPP_URL || PUBLIC_URL; // web app url
const ADMIN_KEY = process.env.ADMIN_KEY || "12345";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : ""; // admin telegram chat id (ixtiyoriy)
const AVG_SERVICE_MIN_FALLBACK = Number(process.env.AVG_SERVICE_MIN || 5);

if (!DATABASE_URL) console.log("⚠️ DATABASE_URL missing");
if (!BOT_TOKEN) console.log("⚠️ BOT_TOKEN missing");

// DB
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function isAdminReq(req) {
  return (req.headers["x-admin-key"] || "") === ADMIN_KEY;
}

// --- DB INIT ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      chat_id BIGINT,
      status TEXT NOT NULL DEFAULT 'WAIT',  -- WAIT | NOW | SERVED | CANCELLED
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      now_at TIMESTAMP,
      served_at TIMESTAMP,
      last_ahead INT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_log (
      id SERIAL PRIMARY KEY,
      minutes INT NOT NULL,
      served_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  console.log("Database ready");
}
initDB().catch(console.error);

// --- ETA calc: average of last 4 services, else fallback ---
async function getAvgServiceMin() {
  try {
    const r = await pool.query(
      `SELECT minutes FROM service_log ORDER BY served_at DESC LIMIT 4`
    );
    if (!r.rows.length) return AVG_SERVICE_MIN_FALLBACK;
    const avg =
      r.rows.reduce((s, x) => s + Number(x.minutes || 0), 0) / r.rows.length;
    return Math.max(1, Math.round(avg));
  } catch {
    return AVG_SERVICE_MIN_FALLBACK;
  }
}

async function getAhead(ticketId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM tickets
     WHERE status='WAIT' AND id < $1`,
    [ticketId]
  );
  return r.rows[0]?.c ?? 0;
}

async function getWaitingTotal() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM tickets WHERE status='WAIT'`
  );
  return r.rows[0]?.c ?? 0;
}

async function getTicket(ticketId) {
  const r = await pool.query(`SELECT * FROM tickets WHERE id=$1`, [ticketId]);
  return r.rows[0] || null;
}

async function computeTicketView(ticketId) {
  const t = await getTicket(ticketId);
  if (!t) return null;

  const ahead = await getAhead(ticketId);
  const waitingTotal = await getWaitingTotal();
  const avgMin = await getAvgServiceMin();

  // ETA (min) = ahead * avgMin, NOW bo'lsa 0
  const etaMin = t.status === "NOW" ? 0 : Math.max(0, ahead * avgMin);

  return {
    ticket_id: t.id,
    name: t.name,
    phone: t.phone,
    status: t.status,
    ahead,
    waiting_total: waitingTotal,
    avg_service_min: avgMin,
    eta_min: etaMin,
  };
}

// --- TELEGRAM BOT ---
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

function userKb(ticketId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Holatim", `status:${ticketId}`)],
    [
      Markup.button.callback("✅ Navbatim keldi", `arrived:${ticketId}`),
      Markup.button.callback("⏳ Hali kelmadi", `wait:${ticketId}`),
    ],
    [
      Markup.button.callback("✅ Xizmat tugadi", `served:${ticketId}`),
      Markup.button.callback("❌ Navbatdan chiqish", `cancel:${ticketId}`),
    ],
  ]);
}

function mainMenuKb() {
  return Markup.keyboard([
    ["📲 Telefon yuborish (navbat olish)"],
    ["🔄 Holatim", "❌ Navbatdan chiqish"],
  ])
    .resize()
    .oneTime(false);
}

function adminKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➡️ Keyingisini chaqirish", "admin:next")],
    [
      Markup.button.callback("📋 Navbat ro'yxati", "admin:list"),
      Markup.button.callback("🧹 Tozalash", "admin:clear"),
    ],
  ]);
}

async function sendTicketStatusToChat(chatId, ticketId, prefix = "✅ Navbat olindi!") {
  const v = await computeTicketView(ticketId);
  if (!v) return;

  const holatText =
    v.status === "WAIT"
      ? "WAIT"
      : v.status === "NOW"
      ? "NOW"
      : v.status === "SERVED"
      ? "SERVED"
      : v.status;

  const text =
    `${prefix}\n\n` +
    `🧾 Ticket: ${v.ticket_id}\n` +
    `👤 Ism: ${v.name}\n` +
    `📞 Tel: ${v.phone}\n` +
    `📌 Holat: ${holatText}\n` +
    `👥 Oldingizda: ${v.ahead}\n` +
    `👥 Kutayotganlar (WAIT): ${v.waiting_total}\n` +
    `⏱ Kutish: ${v.eta_min} minut\n`;

  await bot.telegram.sendMessage(chatId, text, userKb(ticketId));
}

async function broadcastQueueUpdate() {
  // WAIT holatdagilarga ahead o'zgarsa xabar beramiz
  const avgMin = await getAvgServiceMin();

  const waiters = await pool.query(
    `SELECT id, chat_id, name, last_ahead FROM tickets WHERE status='WAIT' AND chat_id IS NOT NULL`
  );

  for (const row of waiters.rows) {
    const ticketId = row.id;
    const chatId = row.chat_id;
    const ahead = await getAhead(ticketId);

    // spam kamaytirish: faqat ahead o'zgarganda yuboramiz
    if (row.last_ahead === null || Number(row.last_ahead) !== Number(ahead)) {
      const etaMin = Math.max(0, ahead * avgMin);

      const txt =
        `🔔 Navbat yangilandi!\n` +
        `🧾 Ticket: ${ticketId}\n` +
        `👥 Oldingizda: ${ahead}\n` +
        `⏱ Taxminiy kutish: ${etaMin} minut`;

      try {
        await bot.telegram.sendMessage(chatId, txt, userKb(ticketId));
        await pool.query(`UPDATE tickets SET last_ahead=$1 WHERE id=$2`, [
          ahead,
          ticketId,
        ]);
      } catch (e) {
        // chat blocked bo'lishi mumkin
      }
    }
  }
}

async function notifyNowTicket(ticketId) {
  const t = await getTicket(ticketId);
  if (!t || !t.chat_id) return;

  const txt =
    `✅ NAVBATINGIZ KELDI!\n` +
    `🧾 Ticket: ${t.id}\n` +
    `👤 ${t.name}\n` +
    `Iltimos, xizmatingizni boshlang.`;

  try {
    await bot.telegram.sendMessage(t.chat_id, txt, userKb(ticketId));
  } catch (e) {}
}

async function adminNext() {
  // Keyingisini chaqirish: WAIT dan eng kichik id ni NOW qilish
  const next = await pool.query(
    `SELECT id FROM tickets WHERE status='WAIT' ORDER BY id ASC LIMIT 1`
  );
  if (!next.rows.length) return { ok: false, message: "WAIT navbat yo'q" };

  const id = next.rows[0].id;
  await pool.query(`UPDATE tickets SET status='NOW', now_at=NOW() WHERE id=$1`, [
    id,
  ]);

  // shu odamga "navbatingiz keldi"
  if (bot) await notifyNowTicket(id);

  // boshqalarga navbat yangilandi
  if (bot) await broadcastQueueUpdate();

  return { ok: true, ticket_id: id };
}

async function adminClear() {
  // eski SERVED/CANCELLED larni o'chirish (ixtiyoriy)
  await pool.query(
    `DELETE FROM tickets WHERE status IN ('SERVED','CANCELLED') AND created_at < NOW() - INTERVAL '7 days'`
  );
  return { ok: true };
}

// --- TELEGRAM handlers ---
if (bot) {
  bot.start(async (ctx) => {
    const txt =
      `Assalomu alaykum! NAVBATUZ bot.\n\n` +
      `Navbat olish uchun telefoningizni yuboring.\n` +
      `Yoki web orqali: ${WEBAPP_URL}`;
    await ctx.reply(txt, mainMenuKb());
    await ctx.reply("Web orqali navbat olish:", Markup.inlineKeyboard([
      [Markup.button.webApp("🌐 Web orqali navbat olish", WEBAPP_URL)]
    ]));
    if (ADMIN_CHAT_ID && String(ctx.chat.id) === ADMIN_CHAT_ID) {
      await ctx.reply("👑 Admin panel (telegramdan):", adminKb());
    }
  });

  // Telefon yuborish tugmasi
  bot.hears("📲 Telefon yuborish (navbat olish)", async (ctx) => {
    await ctx.reply(
      "📞 Telefon raqamingizni yuboring (Contact).",
      Markup.keyboard([[Markup.button.contactRequest("📲 Telefon yuborish")]])
        .resize()
        .oneTime(true)
    );
  });

  // Contact kelganda navbat beramiz
  bot.on("contact", async (ctx) => {
    try {
      const phone = ctx.message.contact.phone_number || "";
      const name =
        (ctx.message.contact.first_name || ctx.from.first_name || "Foydalanuvchi") +
        (ctx.message.contact.last_name ? " " + ctx.message.contact.last_name : "");
      const chatId = ctx.chat.id;

      const r = await pool.query(
        `INSERT INTO tickets(name, phone, chat_id, status)
         VALUES($1,$2,$3,'WAIT')
         RETURNING id`,
        [name.trim(), phone.trim(), chatId]
      );

      const ticketId = r.rows[0].id;

      // last_ahead initial
      const ahead = await getAhead(ticketId);
      await pool.query(`UPDATE tickets SET last_ahead=$1 WHERE id=$2`, [
        ahead,
        ticketId,
      ]);

      await sendTicketStatusToChat(chatId, ticketId, "✅ Navbat olindi!");
      if (bot) await broadcastQueueUpdate();
      await ctx.reply("Menyu:", mainMenuKb());
    } catch (e) {
      console.error(e);
      await ctx.reply("Xatolik. Qayta urinib ko‘ring.");
    }
  });

  // Holatim (menu)
  bot.hears("🔄 Holatim", async (ctx) => {
    const chatId = ctx.chat.id;
    const r = await pool.query(
      `SELECT id FROM tickets
       WHERE chat_id=$1 AND status IN ('WAIT','NOW')
       ORDER BY id DESC LIMIT 1`,
      [chatId]
    );
    if (!r.rows.length) {
      return ctx.reply("Sizda aktiv navbat yo‘q. 📲 Telefon yuborib navbat oling.", mainMenuKb());
    }
    await sendTicketStatusToChat(chatId, r.rows[0].id, "🔄 Holatingiz:");
  });

  // Navbatdan chiqish (menu)
  bot.hears("❌ Navbatdan chiqish", async (ctx) => {
    const chatId = ctx.chat.id;
    const r = await pool.query(
      `SELECT id FROM tickets
       WHERE chat_id=$1 AND status IN ('WAIT','NOW')
       ORDER BY id DESC LIMIT 1`,
      [chatId]
    );
    if (!r.rows.length) return ctx.reply("Aktiv navbat topilmadi.", mainMenuKb());

    const id = r.rows[0].id;
    await pool.query(`UPDATE tickets SET status='CANCELLED' WHERE id=$1`, [id]);
    await ctx.reply("❌ Navbatdan chiqdingiz.", mainMenuKb());
    if (bot) await broadcastQueueUpdate();
  });

  // Inline actions
  bot.on("callback_query", async (ctx) => {
    try {
      const data = ctx.callbackQuery.data || "";
      const [cmd, idStr] = data.split(":");
      const ticketId = Number(idStr);

      if (cmd === "status") {
        await ctx.answerCbQuery("Holat yangilandi");
        await sendTicketStatusToChat(ctx.chat.id, ticketId, "🔄 Holatingiz:");
        return;
      }

      if (cmd === "arrived") {
        // user "navbatim keldi" bosdi -> status NOW ga o'tkazmaymiz (admin o'tkazadi), faqat tasdiq
        await ctx.answerCbQuery("✅ Qabul qilindi");
        await ctx.reply("✅ Belgilandi: navbatim keldi.");
        return;
      }

      if (cmd === "wait") {
        await ctx.answerCbQuery("⏳ Qabul qilindi");
        await ctx.reply("⏳ Belgilandi: hali kutyapman.");
        return;
      }

      if (cmd === "served") {
        // xizmat tugadi: NOW bo'lsa SERVED qilamiz va service_log yozamiz
        const t = await getTicket(ticketId);
        if (!t) return ctx.answerCbQuery("Topilmadi");

        if (t.status !== "NOW") {
          await ctx.answerCbQuery("Hali navbatingiz kelmagan");
          return;
        }

        await pool.query(`UPDATE tickets SET status='SERVED', served_at=NOW() WHERE id=$1`, [
          ticketId,
        ]);

        // vaqtni hisoblash: now_at -> served_at (min), bo'lmasa fallback
        let minutes = AVG_SERVICE_MIN_FALLBACK;
        try {
          const dur = await pool.query(
            `SELECT EXTRACT(EPOCH FROM (served_at - now_at))/60 AS m
             FROM tickets WHERE id=$1`,
            [ticketId]
          );
          const m = Number(dur.rows[0]?.m);
          if (Number.isFinite(m) && m > 0) minutes = Math.max(1, Math.round(m));
        } catch {}

        await pool.query(`INSERT INTO service_log(minutes) VALUES($1)`, [minutes]);

        await ctx.answerCbQuery("✅ Yakunlandi");
        await ctx.reply(`✅ Xizmat tugadi. (${minutes} minut) Rahmat!`, mainMenuKb());

        if (bot) await broadcastQueueUpdate();
        return;
      }

      if (cmd === "cancel") {
        await pool.query(`UPDATE tickets SET status='CANCELLED' WHERE id=$1`, [ticketId]);
        await ctx.answerCbQuery("❌ Chiqildi");
        await ctx.reply("❌ Navbatdan chiqdingiz.", mainMenuKb());
        if (bot) await broadcastQueueUpdate();
        return;
      }

      // Admin panel
      if (cmd === "admin") {
        const action = idStr;

        if (ADMIN_CHAT_ID && String(ctx.chat.id) !== ADMIN_CHAT_ID) {
          await ctx.answerCbQuery("Admin emas");
          return;
        }

        if (action === "next") {
          const r = await adminNext();
          await ctx.answerCbQuery("OK");
          if (!r.ok) return ctx.reply("WAIT navbat yo‘q.", adminKb());
          return ctx.reply(`➡️ Keyingi chaqirildi: Ticket ${r.ticket_id}`, adminKb());
        }

        if (action === "list") {
          const r = await pool.query(
            `SELECT id, name, status FROM tickets
             WHERE status IN ('WAIT','NOW')
             ORDER BY status DESC, id ASC LIMIT 30`
          );
          if (!r.rows.length) return ctx.reply("Navbat bo‘sh.", adminKb());
          const txt =
            "📋 Navbat ro‘yxati:\n" +
            r.rows
              .map((x) => `🧾 ${x.id} | ${x.status} | ${x.name}`)
              .join("\n");
          await ctx.answerCbQuery("OK");
          return ctx.reply(txt, adminKb());
        }

        if (action === "clear") {
          await adminClear();
          await ctx.answerCbQuery("OK");
          return ctx.reply("🧹 Tozalandi (eski SERVED/CANCELLED).", adminKb());
        }
      }

      await ctx.answerCbQuery("OK");
    } catch (e) {
      console.error(e);
      try {
        await ctx.answerCbQuery("Xatolik");
      } catch {}
    }
  });

  // webhook
  app.use(bot.webhookCallback("/tg/webhook"));

  (async () => {
    try {
      if (PUBLIC_URL) {
        const url = `${PUBLIC_URL.replace(/\/$/, "")}/tg/webhook`;
        await bot.telegram.setWebhook(url);
        console.log("Telegram webhook set:", url);
      } else {
        // PUBLIC_URL bo'lmasa polling (Renderda tavsiya emas, lekin fallback)
        await bot.launch();
        console.log("Telegram bot launched (polling fallback)");
      }
    } catch (e) {
      console.log("Telegram init error:", e?.message || e);
    }
  })();
}

// --- API ---
// test
app.get("/api/test", (req, res) => {
  res.json({ success: true, message: "API working" });
});

// Navbat olish (WEB)
// body: {name, phone}
app.post("/api/take", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();

    if (!name) return res.status(400).json({ error: "Ism kiriting" });
    if (!phone) return res.status(400).json({ error: "Telefon kiriting" });

    const r = await pool.query(
      `INSERT INTO tickets(name, phone, status)
       VALUES($1,$2,'WAIT')
       RETURNING id`,
      [name, phone]
    );

    const ticketId = r.rows[0].id;
    const ahead = await getAhead(ticketId);
    await pool.query(`UPDATE tickets SET last_ahead=$1 WHERE id=$2`, [
      ahead,
      ticketId,
    ]);

    if (bot) await broadcastQueueUpdate();

    res.json({ success: true, ticket_id: ticketId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// ticket info
app.get("/api/ticket", async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: "id kerak" });

    const v = await computeTicketView(id);
    if (!v) return res.status(404).json({ error: "Ticket topilmadi" });

    res.json({ success: true, ...v });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// user actions from WEB
app.post("/api/action", async (req, res) => {
  try {
    const id = Number(req.body?.id);
    const action = String(req.body?.action || "");

    if (!id) return res.status(400).json({ error: "id kerak" });

    const t = await getTicket(id);
    if (!t) return res.status(404).json({ error: "Ticket topilmadi" });

    if (action === "cancel") {
      await pool.query(`UPDATE tickets SET status='CANCELLED' WHERE id=$1`, [id]);
      if (bot) await broadcastQueueUpdate();
      return res.json({ success: true });
    }

    if (action === "served") {
      if (t.status !== "NOW") return res.status(400).json({ error: "Hali navbat kelmagan" });
      await pool.query(`UPDATE tickets SET status='SERVED', served_at=NOW() WHERE id=$1`, [id]);

      // duration minutes: now_at->served_at
      let minutes = AVG_SERVICE_MIN_FALLBACK;
      try {
        const dur = await pool.query(
          `SELECT EXTRACT(EPOCH FROM (served_at - now_at))/60 AS m
           FROM tickets WHERE id=$1`,
          [id]
        );
        const m = Number(dur.rows[0]?.m);
        if (Number.isFinite(m) && m > 0) minutes = Math.max(1, Math.round(m));
      } catch {}

      await pool.query(`INSERT INTO service_log(minutes) VALUES($1)`, [minutes]);

      if (bot) await broadcastQueueUpdate();
      return res.json({ success: true, minutes });
    }

    if (action === "arrived" || action === "wait") {
      // UI uchun: faqat ack (statusni admin boshqaradi)
      return res.json({ success: true });
    }

    return res.status(400).json({ error: "Noto'g'ri action" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// admin: next
app.post("/api/admin/next", async (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(401).json({ error: "Unauthorized" });
    const r = await adminNext();
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// admin: list
app.get("/api/admin/list", async (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(401).json({ error: "Unauthorized" });

    const r = await pool.query(
      `SELECT id, name, phone, status, created_at
       FROM tickets
       WHERE status IN ('WAIT','NOW')
       ORDER BY status DESC, id ASC`
    );

    res.json({ success: true, items: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// admin: clear old served/cancelled
app.post("/api/admin/clear", async (req, res) => {
  try {
    if (!isAdminReq(req)) return res.status(401).json({ error: "Unauthorized" });
    const r = await adminClear();
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// Receipt JPG + QR
app.get("/api/receipt", async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).send("id kerak");

    const v = await computeTicketView(id);
    if (!v) return res.status(404).send("Ticket topilmadi");

    // QR data
    const qrData = `${PUBLIC_URL || WEBAPP_URL}/?ticket=${id}`;
    const qrPngDataUrl = await QRCode.toDataURL(qrData, { margin: 1, scale: 6 });

    const base = new Jimp(700, 420, 0xffffffff);
    const fontBig = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
    const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_14_BLACK);

    // header
    base.print(fontBig, 20, 15, "NAVBATUZ чек");
    base.print(font, 20, 65, `Ism: ${v.name}`);
    base.print(font, 20, 90, `Tel: ${v.phone}`);
    base.print(font, 20, 120, `Ticket: ${v.ticket_id}`);
    base.print(font, 20, 145, `Holat: ${v.status}`);
    base.print(font, 20, 170, `Oldingizda: ${v.ahead}`);
    base.print(font, 20, 195, `WAIT: ${v.waiting_total}`);
    base.print(font, 20, 220, `Kutish: ${v.eta_min} minut (avg: ${v.avg_service_min}m)`);

    // dashed line imitation
    base.print(fontSmall, 20, 255, "----------------------------------------------");

    base.print(fontSmall, 20, 280, `QR: ${qrData}`);
    base.print(fontSmall, 20, 305, `Vaqt: ${new Date().toLocaleString()}`);

    // QR image
    const qrBuf = Buffer.from(qrPngDataUrl.split(",")[1], "base64");
    const qrImg = await Jimp.read(qrBuf);
    qrImg.resize(220, 220);
    base.composite(qrImg, 450, 120);

    // output JPG
    const out = await base.quality(85).getBufferAsync(Jimp.MIME_JPEG);
    res.setHeader("Content-Type", "image/jpeg");
    res.send(out);
  } catch (e) {
    console.error(e);
    res.status(500).send("receipt xatosi");
  }
});

// static
app.use(express.static(path.join(__dirname, "public")));

// root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
