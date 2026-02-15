const express = require("express");
const path = require("path");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

// Middleware (body parse uchun)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ENV variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const DATABASE_URL = process.env.DATABASE_URL;

// PostgreSQL connection
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Jadval yaratish
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS queue (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Database ready");
  } catch (err) {
    console.error("DB init error:", err);
  }
}
initDB();


// TEST route
app.get("/api/test", (req, res) => {
  res.json({ success: true, message: "API working" });
});


// API: navbat olish
app.get("/api/navbat", async (req, res) => {
  try {
    console.log("Navbat request received");

    const result = await pool.query(
      "INSERT INTO queue DEFAULT VALUES RETURNING id"
    );

    const id = result.rows[0].id;

    console.log("Created queue id:", id);

    res.json({
      success: true,
      number: id,
    });

  } catch (err) {
    console.error("Navbat error:", err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// static site
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


// Telegram bot
if (BOT_TOKEN && WEBAPP_URL) {

  const bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    ctx.reply("Navbat olish uchun tugmani bosing", {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Navbat olish",
              web_app: { url: WEBAPP_URL },
            },
          ],
        ],
      },
    });
  });

  // VAQTINCHA O‘CHIRILGAN (409 xatoni oldini olish uchun)
  // bot.launch();

  console.log("Telegram bot disabled temporarily");

} else {
  console.log("BOT_TOKEN or WEBAPP_URL missing");
}


// server start
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
