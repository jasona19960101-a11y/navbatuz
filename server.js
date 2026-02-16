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

// Sizda public/ bor — shuni serve qilamiz
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;

// ====== DB ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
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

// ====== I18N TEXTS ======
const TEXT = {
  uz: {
    welcome: "NAVBATUZga xush kelibsiz!\nNAVBATUZ bilan siz vaqtingizni tejaysiz.",
    chooseLang: "Tilni tanlang:",
    saved: "✅ Til saqlandi: O‘zbek"
  },
  ru: {
    welcome: "Добро пожаловать в NAVBATUZ!\nС NAVBATUZ вы экономите время.",
    chooseLang: "Выберите язык:",
    saved: "✅ Язык сохранён: Русский"
  },
  en: {
    welcome: "Welcome to NAVBATUZ!\nWith NAVBATUZ you save time.",
    chooseLang: "Choose a language:",
    saved: "✅ Language saved: English"
  }
};

// ====== WEB API (tilni saqlash) ======
app.post("/api/lang", async (req, res) => {
  try {
    const { web_session, lang } = req.body || {};
    const safeLang = ["uz", "ru", "en"].includes(lang) ? lang : "uz";
    if (!web_session) return res.status(400).json({ ok: false, error: "web_session required" });

    await pool.query(
      `
      INSERT INTO user_prefs (web_session, lang)
      VALUES ($1, $2)
      ON CONFLICT (web_session)
      DO UPDATE SET lang = EXCLUDED.lang, updated_at = NOW();
      `,
      [web_session, safeLang]
    );

    res.json({ ok: true, lang: safeLang });
  } catch (e) {
    console.error("POST /api/lang error:", e);
    res.status(500).json({ ok: false });
  }
});

// ====== TELEGRAM BOT ======
let bot = null;

function langKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🇺🇿 O‘zbek", "LANG_uz")],
    [Markup.button.callback("🇷🇺 Русский", "LANG_ru")],
    [Markup.button.callback("🇬🇧 English", "LANG_en")]
  ]);
}

async function startBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.log("BOT_TOKEN not set -> bot will not start.");
    return;
  }

  bot = new Telegraf(token);

  bot.start(async (ctx) => {
    // Flow kabi: UZ -> RU -> EN
    await ctx.reply(TEXT.uz.welcome);
    await new Promise(r => setTimeout(r, 3000));
    await ctx.reply(TEXT.ru.welcome);
    await new Promise(r => setTimeout(r, 3000));
    await ctx.reply(TEXT.en.welcome);
    await new Promise(r => setTimeout(r, 1000));
    await ctx.reply(TEXT.uz.chooseLang, langKeyboard());
  });

  bot.action(/^LANG_(uz|ru|en)$/, async (ctx) => {
    const lang = ctx.match[1];
    const telegramId = ctx.from.id;

    await setTelegramLang(telegramId, lang);
    await ctx.answerCbQuery();

    const t = TEXT[lang] || TEXT.uz;
    await ctx.reply(t.saved);
    await ctx.reply((TEXT[lang] || TEXT.uz).welcome + "\n\n(Keyingi bosqich: Viloyat → Tuman → Xizmat ...)");
  });

  await bot.launch();
  console.log("Telegram bot started.");
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
