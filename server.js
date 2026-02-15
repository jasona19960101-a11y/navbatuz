const express = require("express");
const path = require("path");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS queue (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDB();

// API: navbat olish
app.get("/api/navbat", async (req, res) => {
  try {
    const result = await pool.query(
      "INSERT INTO queue DEFAULT VALUES RETURNING id"
    );

    res.json({
      success: true,
      number: result.rows[0].id,
    });
  } catch (err) {
    console.error(err);
    res.json({
      success: false,
    });
  }
});

// static site
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Telegram bot
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

bot.launch();

// server start
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
