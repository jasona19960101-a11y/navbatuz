const express = require("express");
const path = require("path");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// (Debug) har bir request log bo‘lsin
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const DATABASE_URL = process.env.DATABASE_URL;

// PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// DB init + columnlar
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue (
        id SERIAL PRIMARY KEY,
        name TEXT,
        phone TEXT,
        status TEXT DEFAULT 'WAIT',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // eski table bo‘lsa ham columnlar yo‘q bo‘lsa qo‘shib ketadi
    await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS name TEXT;`);
    await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS phone TEXT;`);
    await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'WAIT';`);
    await pool.query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);

    console.log("Database ready");
  } catch (err) {
    console.error("DB init error:", err);
  }
}
initDB();

// TEST
app.get("/api/test", (req, res) => {
  res.json({ success: true, message: "API working" });
});

// ✅ 1) FRONTEND UCHUN: POST /api/take  (ism+telefon)
app.post("/api/take", async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    const phone = (req.body?.phone || "").trim();

    if (!name) return res.status(400).json({ success: false, error: "Ism kiriting" });
    if (!phone) return res.status(400).json({ success: false, error: "Telefon kiriting" });

    const result = await pool.query(
      "INSERT INTO queue (name, phone, status) VALUES ($1, $2, 'WAIT') RETURNING id",
      [name, phone]
    );

    const id = result.rows[0].id;
    return res.json({ success: true, ticket_id: id });
  } catch (err) {
    console.error("TAKE error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 2) FRONTEND UCHUN: GET /api/ticket?id=123  (status, ahead)
app.get("/api/ticket", async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ success: false, error: "id noto‘g‘ri" });

    const t = await pool.query("SELECT id, status FROM queue WHERE id=$1", [id]);
    if (t.rowCount === 0) return res.status(404).json({ success: false, error: "Chipta topilmadi" });

    const row = t.rows[0];

    // navbatdagi hozir kiradigan odam (eng kichik WAIT)
    const nowQ = await pool.query(
      "SELECT id FROM queue WHERE status='WAIT' ORDER BY id ASC LIMIT 1"
    );
    const nowId = nowQ.rowCount ? nowQ.rows[0].id : null;

    let status = row.status || "WAIT";
    if (status !== "SERVED") {
      status = (nowId && Number(nowId) === id) ? "NOW" : "WAIT";
    }

    // oldinda nechta odam bor (WAIT va id kichik)
    const aheadQ = await pool.query(
      "SELECT COUNT(*)::int AS c FROM queue WHERE status='WAIT' AND id < $1",
      [id]
    );
    const ahead = aheadQ.rows[0].c;

    return res.json({
      success: true,
      ticket_id: id,
      status,
      ahead
    });
  } catch (err) {
    console.error("TICKET error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 3) Orqaga moslik: GET /api/navbat (eski demo)
app.get("/api/navbat", async (req, res) => {
  try {
    const result = await pool.query("INSERT INTO queue (status) VALUES ('WAIT') RETURNING id");
    res.json({ success: true, number: result.rows[0].id });
  } catch (err) {
    console.error("NAVBAT error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Static
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Telegram bot (hozircha o‘chiq – 409 bo‘lmasin)
if (BOT_TOKEN && WEBAPP_URL) {
  const bot = new Telegraf(BOT_TOKEN);
  bot.start((ctx) => {
    ctx.reply("Navbat olish uchun tugmani bosing", {
      reply_markup: {
        inline_keyboard: [[{ text: "Navbat olish", web_app: { url: WEBAPP_URL } }]],
      },
    });
  });

  // bot.launch(); // Hozircha o‘chiq
  console.log("Telegram bot disabled temporarily");
} else {
  console.log("BOT_TOKEN or WEBAPP_URL missing (bot off)");
}

// Start
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
