// bot.js (NEW - geo.json + sources asosida)
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN env yo‘q");

const API_BASE = process.env.PUBLIC_URL || process.env.WEBAPP_URL || "http://localhost:3000";
const bot = new Telegraf(BOT_TOKEN);

// oddiy in-memory session
const session = new Map();

function setSess(chatId, data) {
  session.set(String(chatId), { ...(session.get(String(chatId)) || {}), ...data });
}
function getSess(chatId) {
  return session.get(String(chatId)) || {};
}

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${url}`);
  return await r.json();
}

// geo.json -> regions/districts/cities ni olib, bot uchun tayyor ko‘rinishga keltiramiz
async function buildGeoForBot() {
  const cfg = await getJson(`${API_BASE}/geo.json`);

  const regionsRaw = await getJson(cfg.sources.regions);
  const districtsRaw = await getJson(cfg.sources.districts);

  let citiesRaw = [];
  try {
    citiesRaw = await getJson(cfg.sources.cities);
  } catch (e) {
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

  // botga orglar: endi orgsByUnitUzKey bo‘yicha olinadi
  const orgsByUnitUzKey = cfg.orgsByUnitUzKey || {};

  return { regions, units, orgsByUnitUzKey };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

bot.start(async (ctx) => {
  await ctx.reply("NAVBATUZ bot\n\n/navbat - navbat olish\n/holat <ticketId> - ticket holati");
});

bot.command("navbat", async (ctx) => {
  try {
    const geo = await buildGeoForBot();
    setSess(ctx.chat.id, { geo, step: "region" });

    const buttons = geo.regions
      .slice(0, 40)
      .map((r) => Markup.button.callback(r.nameUz || r.nameRu || r.id, `REGION:${r.id}`));

    await ctx.reply("Viloyat tanlang:", Markup.inlineKeyboard(chunk(buttons, 2)));
  } catch (e) {
    await ctx.reply(`Xatolik: ${e.message}`);
  }
});

bot.command("holat", async (ctx) => {
  try {
    const parts = (ctx.message.text || "").split(" ").filter(Boolean);
    const id = parts[1];
    if (!id) return ctx.reply("Misol: /holat 123e4567-e89b-12d3-a456-426614174000");

    const j = await getJson(`${API_BASE}/api/ticket/${id}`);
    if (!j.ok) throw new Error(j.error || "Ticket topilmadi");

    const t = j.ticket;
    await ctx.reply(
      `Ticket: ${t.id}\nOrg: ${t.orgId}\nRaqam: ${t.number}\nHozirgi: ${t.currentNumber}\nQolgan: ${t.remaining}\nETA: ~${t.etaMinutes} daqiqa\nStatus: ${t.status}`
    );
  } catch (e) {
    await ctx.reply(`Xatolik: ${e.message}`);
  }
});

bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data || "";
    const chatId = ctx.chat.id;

    const s = getSess(chatId);
    const geo = s.geo || (await buildGeoForBot());

    // REGION
    if (data.startsWith("REGION:")) {
      const regionId = data.split(":")[1];
      setSess(chatId, { regionId, step: "unit", geo });

      const units = geo.units.filter((u) => String(u.regionId) === String(regionId));
      const buttons = units
        .slice(0, 60)
        .map((u) => {
          const prefix = u.kind === "city" ? "Shahar: " : "Tuman: ";
          return Markup.button.callback(prefix + (u.nameUz || u.nameRu || u.id), `UNIT:${u.id}`);
        });

      await ctx.editMessageText("Tuman/Shahar tanlang:", Markup.inlineKeyboard(chunk(buttons, 2)));
      return;
    }

    // UNIT
    if (data.startsWith("UNIT:")) {
      const unitId = data.split(":")[1];
      setSess(chatId, { unitId, step: "org", geo });

      const region = geo.regions.find((r) => String(r.id) === String(s.regionId));
      const unit = geo.units.find((u) => String(u.id) === String(unitId));
      if (!region || !unit) {
        await ctx.answerCbQuery("Tanlov topilmadi");
        return;
      }

      const uzKey = `${(region.nameUz || "").trim()}|${(unit.nameUz || "").trim()}`;
      const orgs = geo.orgsByUnitUzKey[uzKey] || [];
      if (!orgs.length) {
        await ctx.editMessageText("Hozircha bu tuman/shahar uchun muassasa yo‘q.");
        return;
      }

      const buttons = orgs.slice(0, 50).map((o) =>
        Markup.button.callback(o.name?.uz || o.name?.ru || o.id, `ORG:${encodeURIComponent(o.id)}`)
      );

      await ctx.editMessageText("Muassasa tanlang:", Markup.inlineKeyboard(chunk(buttons, 1)));
      return;
    }

    // ORG
    if (data.startsWith("ORG:")) {
      const encOrgId = data.split(":")[1];
      const orgId = decodeURIComponent(encOrgId);

      const r = await fetch(`${API_BASE}/api/take`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, platform: "bot", userId: String(chatId) }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Ticket olinmadi");

      const t = j.ticket;
      const webLink = `${API_BASE}/ticket.html?id=${t.id}`;

      await ctx.editMessageText(
        `✅ Ticket olindi!\n\nRaqam: ${t.number}\nQolgan: ${t.remaining}\nETA: ~${t.etaMinutes} daqiqa\n\nTicket ID: ${t.id}\nLink: ${webLink}`
      );
      return;
    }

    await ctx.answerCbQuery("Noma’lum amal");
  } catch (e) {
    await ctx.reply(`Xatolik: ${e.message}`);
  }
});

(async () => {
  // ✅ agar oldin webhook qo‘yilgan bo‘lsa, polling ishlamay qoladi — shuni tozalaymiz
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (_) {}

  await bot.launch();
  console.log("Bot started:", API_BASE);
})();

// Render shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
