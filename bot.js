// bot.js
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN env yo‘q");

const API_BASE = process.env.PUBLIC_URL || process.env.WEBAPP_URL || "http://localhost:3000";

const bot = new Telegraf(BOT_TOKEN);

// oddiy in-memory session (Render’da restart bo‘lsa tozalanadi; keyin DB/Redis qilamiz)
const session = new Map();

async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`);
  const j = await r.json();
  if (!j.ok && j.error) throw new Error(j.error);
  return j;
}
async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok && j.error) throw new Error(j.error);
  return j;
}

function setSess(chatId, data) {
  session.set(String(chatId), { ...(session.get(String(chatId)) || {}), ...data });
}
function getSess(chatId) {
  return session.get(String(chatId)) || {};
}

function orgIdOf(unitId, org) {
  return String(org.id ?? `${unitId}:${org.name}`);
}

bot.start(async (ctx) => {
  await ctx.reply(
    "NAVBATUZ bot\n\n/navbat - navbat olish\n/holat <ticketId> - ticket holati"
  );
});

bot.command("navbat", async (ctx) => {
  try {
    const geo = await apiGet("/api/geo");
    setSess(ctx.chat.id, { geo, step: "region" });

    const regions = geo.regions || [];
    const buttons = regions.slice(0, 30).map((r) =>
      Markup.button.callback(r.name, `REGION:${r.id}`)
    );

    await ctx.reply(
      "Region tanlang:",
      Markup.inlineKeyboard(chunk(buttons, 2))
    );
  } catch (e) {
    await ctx.reply(`Xatolik: ${e.message}`);
  }
});

bot.command("holat", async (ctx) => {
  try {
    const parts = (ctx.message.text || "").split(" ").filter(Boolean);
    const id = parts[1];
    if (!id) return ctx.reply("Misol: /holat 123e4567-e89b-12d3-a456-426614174000");

    const j = await apiGet(`/api/ticket/${id}`);
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
    const geo = s.geo || (await apiGet("/api/geo"));

    if (data.startsWith("REGION:")) {
      const regionId = data.split(":")[1];
      setSess(chatId, { regionId, step: "unit", geo });

      const units = (geo.units || []).filter((u) => String(u.regionId) === String(regionId));
      const buttons = units.slice(0, 40).map((u) =>
        Markup.button.callback(u.name, `UNIT:${u.id}`)
      );

      await ctx.editMessageText(
        "Unit (tuman/shahar) tanlang:",
        Markup.inlineKeyboard(chunk(buttons, 2))
      );
      return;
    }

    if (data.startsWith("UNIT:")) {
      const unitId = data.split(":")[1];
      setSess(chatId, { unitId, step: "org", geo });

      const orgsByUnitId = geo.orgsByUnitId || {};
      const orgs = orgsByUnitId[String(unitId)] || [];

      const buttons = orgs.slice(0, 50).map((org) =>
        Markup.button.callback(org.name, `ORG:${unitId}:${encodeURIComponent(orgIdOf(unitId, org))}`)
      );

      await ctx.editMessageText(
        "Tashkilot (org) tanlang:",
        Markup.inlineKeyboard(chunk(buttons, 1))
      );
      return;
    }

    if (data.startsWith("ORG:")) {
      const [, unitId, encOrgId] = data.split(":");
      const orgId = decodeURIComponent(encOrgId);

      const j = await apiPost("/api/take", {
        orgId,
        platform: "bot",
        userId: String(chatId),
      });

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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

bot.launch();
console.log("Bot started:", API_BASE);

// Render shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
