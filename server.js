const express = require("express");
const path = require("path");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBAPP_URL = process.env.WEBAPP_URL;

// DATABASE
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// TABLE yaratish
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS queue (
      id SERIAL PRIMARY KEY,
      ticket TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
initDB();

// navbat olish function
async function getNextTicket() {
  const result = await pool.query("SELECT COUNT(*) FROM queue");
  const count = parseInt(result.rows[0].count) + 1;
  const ticket = "N-" + count.toString().padStart(5, "0");

  await pool.query("INSERT INTO queue(ticket) VALUES($1)", [ticket]);

  return {
    ticket,
    position: count,
    eta: count * 2,
  };
}

// WEBSITE API
app.get("/api/next", async (req, res) => {
  const data = await getNextTicket();
  res.json(data);
});

// static
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// TELEGRAM BOT
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

// SERVER START
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
