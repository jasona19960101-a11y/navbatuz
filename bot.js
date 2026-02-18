// bot.js (Node >=18, ESM)
// NAVBATUZ Telegram bot: web + admin panel bilan 100% bitta navbat (bitta DB)
// Muhim: bot ham /api/take endpointidan foydalanadi, shu sabab navbat tartibi buzilmaydi.

import { Telegraf, Markup } from "telegraf";

// Bot instance for server-side notifications
let __botRef = null;

export function getBot() {
  return __botRef;
}


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

export function startBot({
  port,
  publicUrl,
}) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.log("ℹ️ BOT_TOKEN yo‘q — bot ishga tushirilmaydi");
    return null;
  }

  // Bot server bilan bitta konteynerda ishlaydi: API chaqiriqlarni lokal qiladi
  const API_BASE_INTERNAL = `http://127.0.0.1:${port}`;
  const PUBLIC_BASE = publicUrl;

  const bot = new Telegraf(BOT_TOKEN);
  __botRef = bot;

  // oddiy in-memory session (Render restart bo‘lsa ketadi — bu navbat raqamiga ta’sir qilmaydi)
  const session = new Map();
  const keyOf = (chatId) => String(chatId);
  const setSess = (chatId, data) => {
    session.set(keyOf(chatId), { ...(session.get(keyOf(chatId)) || {}), ...data });
  };
  const getSess = (chatId) => session.get(keyOf(chatId)) || {};

  async function getJson(url) {
    const r = await fetch(url, { cache: "no-store" });
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
    const item = T[key];
    if (!item) return "";
    return item[lang] ?? item.uz ?? "";
  }
  function langKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇿 O‘zbekcha", "LANG:uz"), Markup.button.callback("🇷🇺 Русский", "LANG:ru")],
    ]);
  }

  async function sendMenu(ctx) {
    const lang = getLang(ctx);
    const kb = Markup.keyboard([
      [T.menuNavbat[lang], T.menuHolat[lang]],
      [T.menuTil[lang]],
    ])
      .resize()
      .persistent();

    await ctx.reply(T.menuTitle[lang], kb);
    await ctx.reply(T.helpText[lang]);
  }

  // ====== geo.json -> bot format ======
  async function buildGeoForBot() {
    const cfg = await getJson(`${API_BASE_INTERNAL}/geo.json`);
    const regionsRaw = await getJson(cfg.sources.regions);
    const districtsRaw = await getJson(cfg.sources.districts);

    let citiesRaw = [];
    try {
      citiesRaw = await getJson(cfg.sources.cities);
    } catch {
      citiesRaw = [];
    }

    const regions = regionsRaw.map((r) => ({
      id: String(r.id ?? r.soato_id ?? r.code),
      nameUz: String(r.name_uz ?? r.nameUz ?? r.name ?? ""),
      nameRu: String(r.name_ru ?? r.nameRu ?? ""),
    }));

    const toUnit = (u, kind) => ({
      id: String(u.id ?? u.soato_id ?? u.code ?? (u.name_uz || u.name_ru || "")),
      regionId: String(u.region_id ?? u.regionId ?? u.parent_id ?? u.parentId ?? ""),
      kind,
      nameUz: String(u.name_uz ?? u.nameUz ?? u.name ?? ""),
      nameRu: String(u.name_ru ?? u.nameRu ?? ""),
    });

    const units = [
      ...(Array.isArray(districtsRaw) ? districtsRaw : []).map((x) => toUnit(x, "district")),
      ...(Array.isArray(citiesRaw) ? citiesRaw : []).map((x) => toUnit(x, "city")),
    ].filter((u) => u.regionId);

    const orgsByUnitUzKey = cfg.orgsByUnitUzKey || {};
    return { regions, units, orgsByUnitUzKey };
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function normalizeFullName(text) {
    const t = String(text || "").trim().replace(/\s+/g, " ");
    if (t.length < 3) return "";
    return t.slice(0, 80);
  }

  function defaultFullNameFromTelegram(ctx) {
    const first = (ctx.from?.first_name || "").trim();
    const last = (ctx.from?.last_name || "").trim();
    return normalizeFullName(`${first} ${last}`.trim());
  }

  async function ensureName(ctx) {
    const s = getSess(ctx.chat.id);
    if (s.fullName && s.fullName.length >= 3) return s.fullName;
    const d = defaultFullNameFromTelegram(ctx);
    if (d && d.length >= 3) {
      setSess(ctx.chat.id, { fullName: d });
      return d;
    }
    return "";
  }

  // ====== COMMANDS ======
  bot.start(async (ctx) => {
    await ctx.reply(tr(ctx, "chooseLang"), langKeyboard());
  });

  bot.command("til", async (ctx) => {
    await ctx.reply(tr(ctx, "chooseLang"), langKeyboard());
  });

  bot.hears(["📲 Navbat olish", "📲 Получить очередь"], async (ctx) => {
    // /navbat ni trigger qilamiz
    return bot.handleUpdate({
      ...ctx.update,
      message: { ...ctx.update.message, text: "/navbat" },
    });
  });

  bot.hears(["🧾 Holatim", "🧾 Мой статус"], async (ctx) => {
    const lang = getLang(ctx);
    await ctx.reply(T.holatUsage[lang]);
  });

  bot.hears(["🌐 Tilni o‘zgartirish", "🌐 Сменить язык"], async (ctx) => {
    await ctx.reply(tr(ctx, "chooseLang"), langKeyboard());
  });

  bot.command("navbat", async (ctx) => {
    try {
      const geo = await buildGeoForBot();
      setSess(ctx.chat.id, { geo, step: "region", regionId: null, unitId: null, orgId: null });

      const lang = getLang(ctx);
      const buttons = geo.regions
        .slice(0, 40)
        .map((r) =>
          Markup.button.callback(
            (lang === "ru" ? (r.nameRu || r.nameUz) : (r.nameUz || r.nameRu)) || r.id,
            `REGION:${r.id}`
          )
        );

      await ctx.reply(tr(ctx, "pickRegion"), Markup.inlineKeyboard(chunk(buttons, 2)));
    } catch (e) {
      await ctx.reply(tr(ctx, "errPrefix") + e.message);
    }
  });

  bot.command("holat", async (ctx) => {
    try {
      const parts = (ctx.message.text || "").split(" ").filter(Boolean);
      const id = parts[1];
      if (!id) return ctx.reply(tr(ctx, "holatUsage"));

      const j = await getJson(`${API_BASE_INTERNAL}/api/ticket/${id}`);
      if (!j.ok) throw new Error(j.error || tr(ctx, "ticketNotFound"));

      const lang = getLang(ctx);
      const t = j.ticket;
      await ctx.reply(
        `Ticket: ${t.id}\nOrg: ${t.orgId}\n${T.number[lang]}: ${t.number}\nHozirgi: ${t.currentNumber}\n${T.remaining[lang]}: ${t.remaining}\n${T.eta[lang]}: ~${t.etaMinutes ?? "-"} ${T.minutes[lang]}\nStatus: ${t.status}`
      );
    } catch (e) {
      await ctx.reply(tr(ctx, "errPrefix") + e.message);
    }
  });

  // Name input step
  bot.on("text", async (ctx, next) => {
    const s = getSess(ctx.chat.id);
    if (s.step !== "name") return next();

    const name = normalizeFullName(ctx.message.text);
    if (!name) {
      await ctx.reply(tr(ctx, "askName"), { parse_mode: "HTML" });
      return;
    }

    setSess(ctx.chat.id, { fullName: name, step: "org_take" });
    await ctx.reply(tr(ctx, "nameSaved"));

    // endi navbat olishni davom ettiramiz
    await takeTicket(ctx);
  });

  async function takeTicket(ctx) {
    const s = getSess(ctx.chat.id);
    const orgId = s.orgId;
    if (!orgId) {
      await ctx.reply(tr(ctx, "errPrefix") + "orgId topilmadi");
      return;
    }

    const fullName = (await ensureName(ctx)) || s.fullName || "";
    if (!fullName) {
      setSess(ctx.chat.id, { step: "name" });
      await ctx.reply(tr(ctx, "askName"), { parse_mode: "HTML" });
      return;
    }

    const r = await fetch(`${API_BASE_INTERNAL}/api/take`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId,
        platform: "bot",
        userId: String(ctx.chat.id),
        fullName,
        telegramChatId: String(ctx.chat.id),
        telegramUserId: String(ctx.from?.id || ctx.chat.id),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j?.error || "Ticket olinmadi");

    const lang = getLang(ctx);
    const t = j.ticket;
    const webLink = `${PUBLIC_BASE}/ticket.html?id=${t.id}`;

    await ctx.reply(
      `${T.ticketTaken[lang]}\n\n` +
        `${T.number[lang]}: ${t.number}\n` +
        `${T.remaining[lang]}: ${t.remaining}\n` +
        `${T.eta[lang]}: ~${t.etaMinutes ?? "-"} ${T.minutes[lang]}\n\n` +
        `${T.ticketId[lang]}: ${t.id}\n` +
        `${T.link[lang]}: ${webLink}`
    );

    setSess(ctx.chat.id, { step: null });
  }

  bot.on("callback_query", async (ctx) => {
    try {
      const data = ctx.callbackQuery.data || "";
      const chatId = ctx.chat.id;

      // LANGUAGE
      if (data.startsWith("LANG:")) {
        const lang = data.split(":")[1] === "ru" ? "ru" : "uz";
        setSess(chatId, { lang });

        if (lang === "uz") await ctx.answerCbQuery(T.langSetUz.uz);
        else await ctx.answerCbQuery(T.langSetRu.ru);

        await ctx.editMessageText(T.chooseLang[lang]);
        await sendMenu(ctx);
        return;
      }

      const s = getSess(chatId);
      const geo = s.geo || (await buildGeoForBot());
      const lang = getLang(ctx);

      // REGION
      if (data.startsWith("REGION:")) {
        const regionId = data.split(":")[1];
        setSess(chatId, { regionId, step: "unit", geo });

        const units = geo.units.filter((u) => String(u.regionId) === String(regionId));
        const buttons = units.slice(0, 60).map((u) => {
          const prefix = u.kind === "city" ? T.cityPrefix[lang] : T.districtPrefix[lang];
          const name = lang === "ru" ? (u.nameRu || u.nameUz) : (u.nameUz || u.nameRu);
          return Markup.button.callback(prefix + (name || u.id), `UNIT:${u.id}`);
        });

        await ctx.editMessageText(tr(ctx, "pickUnit"), Markup.inlineKeyboard(chunk(buttons, 2)));
        return;
      }

      // UNIT
      if (data.startsWith("UNIT:")) {
        const unitId = data.split(":")[1];
        setSess(chatId, { unitId, step: "org", geo });

        const region = geo.regions.find((r) => String(r.id) === String(s.regionId));
        const unit = geo.units.find((u) => String(u.id) === String(unitId));
        if (!region || !unit) {
          await ctx.answerCbQuery(tr(ctx, "notFoundChoice"));
          return;
        }

        const uzKey = `${(region.nameUz || "").trim()}|${(unit.nameUz || "").trim()}`;
        const orgs = geo.orgsByUnitUzKey[uzKey] || [];
        if (!orgs.length) {
          await ctx.editMessageText(tr(ctx, "noOrgs"));
          return;
        }

        const buttons = orgs.slice(0, 50).map((o) => {
          const label =
            lang === "ru" ? (o.name?.ru || o.name?.uz || o.id) : (o.name?.uz || o.name?.ru || o.id);
          return Markup.button.callback(label, `ORG:${encodeURIComponent(o.id)}`);
        });

        await ctx.editMessageText(tr(ctx, "pickOrg"), Markup.inlineKeyboard(chunk(buttons, 1)));
        return;
      }

      // ORG
      if (data.startsWith("ORG:")) {
        const orgId = decodeURIComponent(data.split(":")[1] || "");
        setSess(chatId, { orgId, step: "org_take" });

        // Telegraf callback'ni tez yopib qo'yamiz
        try { await ctx.answerCbQuery("OK"); } catch {}

        await takeTicket(ctx);
        return;
      }

      await ctx.answerCbQuery(tr(ctx, "unknownAction"));
    } catch (e) {
      await ctx.reply(tr(ctx, "errPrefix") + e.message);
    }
  });

  (async () => {
    const WEBHOOK_URL = process.env.WEBHOOK_URL;

    if (WEBHOOK_URL) {
      const base = WEBHOOK_URL.replace(/\/$/, "");
      try {
        await bot.telegram.setWebhook(`${base}/telegram`, { drop_pending_updates: true });
      } catch (e) {
        console.error("❌ setWebhook failed:", e);
      }
      console.log("✅ Bot webhook mode. WEBHOOK:", `${base}/telegram`);
      return;
    }

    // Polling mode
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch {}

    await bot.launch();
    console.log("✅ Bot polling mode. PUBLIC:", PUBLIC_BASE);
  })();
process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}
