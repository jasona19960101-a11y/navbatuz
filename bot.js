// bot.js (Node >=18, ESM)
// NAVBATUZ Telegram bot: web + admin panel bilan 100% bitta navbat (bitta DB)
// Muhim: bot ham /api/take endpointidan foydalanadi, shu sabab navbat tartibi buzilmaydi.
//
// IMPORTANT (Render): polling (getUpdates) deploy vaqtida 409 conflict berishi mumkin.
// Shuning uchun agar WEBHOOK_URL env berilgan bo'lsa, bot webhook rejimida ishlaydi (tavsiya).
// WEBHOOK_URL misol: https://navbatuz.onrender.com  (oxirida / bo'lmasin)

import { Telegraf, Markup } from "telegraf";

// Bot instance for server-side notifications
let __botRef = null;
let __launched = false;

export async function tgSend(chatId, text, extra = {}) {
  if (!__botRef) return false;
  try {
    await __botRef.telegram.sendMessage(chatId, text, { disable_web_page_preview: true, ...extra });
    return true;
  } catch (e) {
    console.error("tgSend error:", e?.message || e);
    return false;
  }
}

/**
 * Start telegram bot.
 * @param {object} opts
 * @param {import('express').Express} [opts.app] - express app (webhook mode uchun kerak)
 * @param {number|string} opts.port - server port (internal API uchun)
 * @param {string} opts.publicUrl - public base url (ticket linklar uchun)
 */
export function startBot({ app, port, publicUrl }) {
  if (__launched) {
    console.log("ℹ️ Bot already launched, skipping duplicate start.");
    return __botRef;
  }
  __launched = true;

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.log("ℹ️ BOT_TOKEN yo‘q — bot ishga tushirilmaydi");
    return null;
  }

  const API_BASE_INTERNAL = `http://127.0.0.1:${port}`;
  const PUBLIC_BASE = (publicUrl || "").replace(/\/$/, "");

  const bot = new Telegraf(BOT_TOKEN);
  __botRef = bot;

  // ---- tiny in-memory session ----
  const session = new Map();
  const keyOf = (chatId) => String(chatId);
  const setSess = (chatId, data) => {
    session.set(keyOf(chatId), { ...(session.get(keyOf(chatId)) || {}), ...data });
  };
  const getSess = (chatId) => session.get(keyOf(chatId)) || {};

  async function getJson(url, opts = {}) {
    const r = await fetch(url, { cache: "no-store", ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || `Fetch failed ${r.status}: ${url}`);
    return j;
  }

  // ====== LANGUAGE LAYER ======
  const T = {
    chooseLang: { uz: "Tilni tanlang:", ru: "Выберите язык:" },
    langSetUz: { uz: "✅ Til: O‘zbekcha", ru: "✅ Язык: Узбекский" },
    langSetRu: { uz: "✅ Til: Ruscha", ru: "✅ Язык: Русский" },
    menuTitle: { uz: "NAVBATUZ bot menyu:", ru: "Меню NAVBATUZ bot:" },
    menuNavbat: { uz: "📲 Navbat olish", ru: "📲 Получить очередь" },
    menuHolat: { uz: "🧾 Holatim", ru: "🧾 Мой статус" },
    menuTil: { uz: "🌐 Tilni o‘zgartirish", ru: "🌐 Сменить язык" },

    helpText: {
      uz: "NAVBATUZ bot\n\n/navbat - navbat olish\n/holat <ticketId> - ticket holati\n/til - tilni o‘zgartirish",
      ru: "NAVBATUZ bot\n\n/navbat - получить очередь\n/holat <ticketId> - статус талона\n/til - сменить язык",
    },

    pickRegion: { uz: "Viloyat tanlang:", ru: "Выберите область:" },
    pickUnit: { uz: "Tuman/Shahar tanlang:", ru: "Выберите район/город:" },
    noOrgs: { uz: "Hozircha bu tuman/shahar uchun muassasa yo‘q.", ru: "Пока нет учреждений для этого района/города." },
    pickOrg: { uz: "Muassasa tanlang:", ru: "Выберите учреждение:" },

    askName: {
      uz: "Ism va familiyangizni yozing (masalan: <b>Ali Valiyev</b>)",
      ru: "Введите имя и фамилию (например: <b>Ali Valiyev</b>)",
    },
    nameSaved: { uz: "✅ Saqlandi.", ru: "✅ Сохранено." },

    cityPrefix: { uz: "Shahar: ", ru: "Город: " },
    districtPrefix: { uz: "Tuman: ", ru: "Район: " },

    errPrefix: { uz: "Xatolik: ", ru: "Ошибка: " },
    notFoundChoice: { uz: "Tanlov topilmadi", ru: "Выбор не найден" },
    unknownAction: { uz: "Noma’lum amal", ru: "Неизвестное действие" },

    holatUsage: {
      uz: "Misol: /holat 123e4567-e89b-12d3-a456-426614174000",
      ru: "Пример: /holat 123e4567-e89b-12d3-a456-426614174000",
    },
    ticketNotFound: { uz: "Ticket topilmadi", ru: "Талон не найден" },

    ticketTaken: { uz: "✅ Ticket olindi!", ru: "✅ Талон получен!" },
    number: { uz: "Raqam", ru: "Номер" },
    remaining: { uz: "Qolgan", ru: "Осталось" },
    eta: { uz: "ETA", ru: "Ожидание" },
    minutes: { uz: "daqiqa", ru: "мин" },
    ticketId: { uz: "Ticket ID", ru: "ID талона" },
    link: { uz: "Link", ru: "Ссылка" },
  };

  function getLang(ctx) {
    const s = getSess(ctx.chat.id);
    if (s.lang === "uz" || s.lang === "ru") return s.lang;
    const code = ctx.from?.language_code || "";
    if (code.startsWith("ru")) return "ru";
    return "uz";
  }
  function tr(ctx, key) {
    const lang = getLang(ctx);
    return (T[key] && T[key][lang]) || "";
  }

  function mainMenu(ctx) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(tr(ctx, "menuNavbat"), "menu:navbat")],
      [Markup.button.callback(tr(ctx, "menuHolat"), "menu:holat")],
      [Markup.button.callback(tr(ctx, "menuTil"), "menu:til")],
    ]);
  }

  async function ensureGeo(ctx) {
    const s = getSess(ctx.chat.id);
    if (s.geo) return s.geo;
    const geo = await getJson(`${API_BASE_INTERNAL}/api/geo`);
    setSess(ctx.chat.id, { geo });
    return geo;
  }

  function regionsFromGeo(geo) {
    // geo.regions: [{id,name}] yoki unitlar ichida
    const regions = geo?.regions || geo?.data?.regions || [];
    return Array.isArray(regions) ? regions : [];
  }

  // In your project geo.json: regions.json + districts.json used, and orgsByUnitId mapping
  function unitsFromGeo(geo, regionId) {
    const units = geo?.units || geo?.data?.units || geo?.districts || [];
    const arr = Array.isArray(units) ? units : [];
    if (!regionId) return arr;
    return arr.filter((u) => String(u.region_id ?? u.regionId ?? u.region ?? "") === String(regionId));
  }

  function orgsForUnit(geo, unitId) {
    const map = geo?.orgsByUnitId || geo?.orgsByUnitUzKey || {};
    const key = String(unitId);
    const orgs = map[key] || [];
    return Array.isArray(orgs) ? orgs : [];
  }

  // --- flows ---
  async function showLang(ctx) {
    await ctx.reply(tr(ctx, "chooseLang"), Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇿 O‘zbek", "lang:uz"), Markup.button.callback("🇷🇺 Русский", "lang:ru")],
    ]));
  }

  async function showRegions(ctx) {
    const geo = await ensureGeo(ctx);
    const regions = regionsFromGeo(geo);
    if (!regions.length) {
      await ctx.reply(tr(ctx, "errPrefix") + "geo regions topilmadi");
      return;
    }
    const buttons = regions.slice(0, 60).map(r => [Markup.button.callback(String(r.name || r.title || r.label), `reg:${r.id}`)]);
    await ctx.reply(tr(ctx, "pickRegion"), Markup.inlineKeyboard(buttons));
  }

  async function showUnits(ctx, regionId) {
    const geo = await ensureGeo(ctx);
    const units = unitsFromGeo(geo, regionId);
    if (!units.length) {
      await ctx.reply(tr(ctx, "errPrefix") + "unit topilmadi");
      return;
    }
    setSess(ctx.chat.id, { regionId });
    const buttons = units.slice(0, 60).map(u => [Markup.button.callback(String(u.name || u.title || u.label), `unit:${u.id}`)]);
    await ctx.reply(tr(ctx, "pickUnit"), Markup.inlineKeyboard(buttons));
  }

  async function showOrgs(ctx, unitId) {
    const geo = await ensureGeo(ctx);
    const orgs = orgsForUnit(geo, unitId);
    if (!orgs.length) {
      await ctx.reply(tr(ctx, "noOrgs"));
      return;
    }
    setSess(ctx.chat.id, { unitId });
    const buttons = orgs.slice(0, 60).map(o => [Markup.button.callback(String(o.name || o.title || o.label), `org:${o.id}`)]);
    await ctx.reply(tr(ctx, "pickOrg"), Markup.inlineKeyboard(buttons));
  }

  async function askName(ctx) {
    setSess(ctx.chat.id, { step: "ask_name" });
    await ctx.reply(tr(ctx, "askName"), { parse_mode: "HTML" });
  }

  function bestName(ctx) {
    const fn = ctx.from?.first_name || "";
    const ln = ctx.from?.last_name || "";
    const full = `${fn} ${ln}`.trim();
    return full || ctx.from?.username || "User";
  }

  async function takeTicket(ctx) {
    const s = getSess(ctx.chat.id);
    const orgId = s.orgId;
    if (!orgId) {
      await showRegions(ctx);
      return;
    }

    // name
    const fullName = (s.fullName || "").trim() || bestName(ctx);
    // include chat/user to enable notifications
    const body = {
      orgId,
      fullName,
      platform: "telegram",
      telegramChatId: ctx.chat.id,
      telegramUserId: ctx.from?.id,
    };

    const j = await getJson(`${API_BASE_INTERNAL}/api/take`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ticket = j?.ticket || j;
    const ticketUrl = `${PUBLIC_BASE}/ticket.html?id=${ticket.id}`;

    const msg =
      `${tr(ctx, "ticketTaken")}\n` +
      `${tr(ctx, "number")}: <b>${ticket.number}</b>\n` +
      `${tr(ctx, "ticketId")}: <code>${ticket.id}</code>\n` +
      `${tr(ctx, "link")}: ${ticketUrl}`;

    await ctx.reply(msg, { parse_mode: "HTML", disable_web_page_preview: true });
  }

  async function holat(ctx, ticketId) {
    if (!ticketId) {
      await ctx.reply(tr(ctx, "holatUsage"));
      return;
    }
    const j = await getJson(`${API_BASE_INTERNAL}/api/ticket?id=${encodeURIComponent(ticketId)}`);
    if (!j?.ticket) {
      await ctx.reply(tr(ctx, "ticketNotFound"));
      return;
    }
    const t = j.ticket;
    const msg =
      `${tr(ctx, "number")}: <b>${t.number}</b>\n` +
      `Status: <b>${t.status}</b>\n` +
      `${tr(ctx, "remaining")}: <b>${t.remaining ?? "-"}</b>\n` +
      `${tr(ctx, "eta")}: <b>${t.etaMin ?? "-"}</b> ${tr(ctx, "minutes")}`;
    await ctx.reply(msg, { parse_mode: "HTML" });
  }

  // --- commands ---
  bot.start(async (ctx) => {
    await showLang(ctx);
    await ctx.reply(tr(ctx, "menuTitle"), mainMenu(ctx));
  });

  bot.command("til", async (ctx) => showLang(ctx));
  bot.command("help", async (ctx) => ctx.reply(T.helpText[getLang(ctx)]));
  bot.command("navbat", async (ctx) => showRegions(ctx));
  bot.command("holat", async (ctx) => {
    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    const ticketId = parts[1];
    await holat(ctx, ticketId);
  });

  bot.on("text", async (ctx) => {
    const s = getSess(ctx.chat.id);
    if (s.step === "ask_name") {
      setSess(ctx.chat.id, { fullName: String(ctx.message.text || "").trim(), step: null });
      await ctx.reply(tr(ctx, "nameSaved"));
      await takeTicket(ctx);
    }
  });

  // --- callback handlers ---
  bot.on("callback_query", async (ctx) => {
    try {
      const data = String(ctx.callbackQuery?.data || "");
      if (data === "menu:til") {
        await ctx.answerCbQuery();
        await showLang(ctx);
        return;
      }
      if (data === "menu:navbat") {
        await ctx.answerCbQuery();
        await showRegions(ctx);
        return;
      }
      if (data === "menu:holat") {
        await ctx.answerCbQuery();
        await ctx.reply(tr(ctx, "holatUsage"));
        return;
      }

      if (data.startsWith("lang:")) {
        const lang = data.split(":")[1];
        setSess(ctx.chat.id, { lang });
        await ctx.answerCbQuery(lang === "ru" ? tr(ctx, "langSetRu") : tr(ctx, "langSetUz"));
        await ctx.reply(tr(ctx, "menuTitle"), mainMenu(ctx));
        return;
      }

      if (data.startsWith("reg:")) {
        await ctx.answerCbQuery();
        const regionId = data.split(":")[1];
        await showUnits(ctx, regionId);
        return;
      }

      if (data.startsWith("unit:")) {
        await ctx.answerCbQuery();
        const unitId = data.split(":")[1];
        await showOrgs(ctx, unitId);
        return;
      }

      if (data.startsWith("org:")) {
        await ctx.answerCbQuery();
        const orgId = data.split(":")[1];
        setSess(ctx.chat.id, { orgId });
        const s = getSess(ctx.chat.id);
        if (!s.fullName) {
          await askName(ctx);
          return;
        }
        await takeTicket(ctx);
        return;
      }

      await ctx.answerCbQuery(tr(ctx, "unknownAction"));
    } catch (e) {
      try { await ctx.answerCbQuery(); } catch {}
      await ctx.reply(tr(ctx, "errPrefix") + (e?.message || String(e)));
    }
  });

  // ---- Start: webhook preferred, polling fallback ----
  (async () => {
    try {
      // Har ehtimolga qarshi eski webhookni tozalab qo'yamiz (pollingda muammo bermasin)
      await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    } catch {}

    const webhookBase = (process.env.WEBHOOK_URL || "").trim().replace(/\/$/, "");
    const webhookPath = "/tg";

    if (webhookBase) {
      if (!app) {
        console.log("⚠️ WEBHOOK_URL berilgan, lekin express app uzatilmagan. Pollingga o'tyapman.");
      } else {
        const fullWebhook = `${webhookBase}${webhookPath}`;
        try {
          // Express route
          app.use(webhookPath, bot.webhookCallback(webhookPath));
          await bot.telegram.setWebhook(fullWebhook);
          console.log("✅ Bot webhook mode. URL:", fullWebhook);
          return;
        } catch (e) {
          console.error("❌ setWebhook failed, fallback to polling:", e?.message || e);
        }
      }
    }

    // Polling fallback (dev/local). Deploy paytida 409 bo'lishi mumkin.
    await bot.launch();
    console.log("✅ Bot polling mode. PUBLIC:", PUBLIC_BASE);
  })();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}
