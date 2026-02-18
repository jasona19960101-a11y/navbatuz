// server.js (Node >=18, ESM)
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import { Pool } from "pg";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) console.error("❌ DATABASE_URL env topilmadi. Render’da DATABASE_URL ni qo‘ying.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const app = express();

// ---- Security-ish headers (depsiz) ----
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// ---- CORS (ixtiyoriy) ----
const corsOrigin = (process.env.CORS_ORIGIN || "").trim();
if (corsOrigin) {
  const allow = corsOrigin.split(",").map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: allow, credentials: true }));
} else {
  app.use(cors());
}

app.use(express.json({ limit: "2mb" }));

// Static
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1h",
    etag: true,
  })
);

const GEO_PATH = path.join(__dirname, "public", "geo.json");

function loadGeo() {
  if (!fs.existsSync(GEO_PATH)) throw new Error(`geo.json topilmadi: ${GEO_PATH}`);
  const raw = fs.readFileSync(GEO_PATH, "utf-8");
  return JSON.parse(raw);
}

function safeInt(n, def = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : def;
}
function safeStr(s, def = "") {
  return typeof s === "string" ? s : def;
}

function validateOrgId(geo, orgId) {
  if (!orgId || typeof orgId !== "string") return false;
  const map = geo.orgsByUnitUzKey || {};
  for (const k of Object.keys(map)) {
    for (const org of map[k] || []) {
      if (String(org.id) === orgId) return true;
    }
  }
  return false;
}

async function initDb() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_state (
      org_id TEXT PRIMARY KEY,
      next_number INTEGER NOT NULL DEFAULT 1,
      current_number INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting', -- waiting | missed | cancelled | served
      platform TEXT,
      user_id TEXT,
      full_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      served_at TIMESTAMPTZ
    );
  `);

  // indexes
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_num ON tickets(org_id, number);`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_status ON tickets(org_id, status);`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_served_at ON tickets(org_id, served_at);`); } catch {}
}

async function computeAvgServiceSec(orgId) {
  // last 6 served tickets -> time diffs -> average (need at least 3 diffs)
  try {
    const r = await pool.query(
      `
      SELECT served_at
      FROM tickets
      WHERE org_id=$1 AND status='served' AND served_at IS NOT NULL
      ORDER BY served_at DESC
      LIMIT 6
      `,
      [orgId]
    );

    const times = r.rows
      .map((x) => new Date(x.served_at).getTime())
      .filter((t) => Number.isFinite(t));

    if (times.length < 4) return null;

    const diffsSec = [];
    for (let i = 0; i < times.length - 1; i++) {
      const d = Math.round((times[i] - times[i + 1]) / 1000);
      if (d > 5 && d < 21600) diffsSec.push(d);
      if (diffsSec.length >= 4) break;
    }

    if (diffsSec.length < 3) return null;

    return Math.round(diffsSec.reduce((a, b) => a + b, 0) / diffsSec.length);
  } catch (e) {
    console.error("avgServiceSec error:", e);
    return null;
  }
}

async function ensureOrgState(orgId) {
  await pool.query(
    `INSERT INTO org_state (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId]
  );
}

/**
 * MUHIM: org_state ni normalizatsiya qilish.
 * - next_number hech qachon current_number+2 dan kichik bo‘lmaydi (Now serving dan keyingi raqam)
 * - next_number max(ticket.number)+1 dan ham kichik bo‘lmaydi
 * Natija: Now=24 bo‘lsa, yangi ticket 25+ bo‘ladi; "Last number" ham Now dan kichik bo‘lib qolmaydi.
 */
async function normalizeOrgState(clientOrPool, orgId) {
  const db = clientOrPool || pool;

  await db.query(
    `INSERT INTO org_state (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId]
  );

  const st = await db.query(
    `SELECT current_number, next_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
    [orgId]
  );

  let currentNumber = safeInt(st.rows[0]?.current_number, 0);
  let nextNumber = safeInt(st.rows[0]?.next_number, 1);

  const mx = await db.query(`SELECT COALESCE(MAX(number),0) AS maxn FROM tickets WHERE org_id=$1`, [orgId]);
  const maxTicket = safeInt(mx.rows[0]?.maxn, 0);

  // Now serving = current+1, shuning uchun next issue = current+2 dan past bo‘lmasin
  const minNext = currentNumber + 2;
  const minByMax = maxTicket + 1;

  const fixedNext = Math.max(nextNumber, minNext, minByMax);

  if (fixedNext !== nextNumber) {
    nextNumber = fixedNext;
    await db.query(
      `UPDATE org_state SET next_number=$2, updated_at=now() WHERE org_id=$1`,
      [orgId, nextNumber]
    );
  }

  return { currentNumber, nextNumber, maxTicket };
}

async function autoUpdateTicketStatusIfNeeded({ ticketId, number, nowServing }) {
  if (!ticketId || !number || !Number.isFinite(nowServing)) return null;

  const diff = nowServing - number;
  if (diff <= 0) return null;

  if (diff <= 5) {
    await pool.query(
      `UPDATE tickets SET status='missed', updated_at=now()
       WHERE id=$1 AND status='waiting'`,
      [ticketId]
    );
    return "missed";
  } else {
    await pool.query(
      `UPDATE tickets SET status='cancelled', updated_at=now()
       WHERE id=$1 AND status IN ('waiting','missed')`,
      [ticketId]
    );
    return "cancelled";
  }
}

function publicBaseUrl() {
  return process.env.PUBLIC_URL || `http://localhost:${PORT}`;
}

async function makeQr(ticketId) {
  const qrData = `${publicBaseUrl()}/ticket.html?id=${ticketId}`;
  let qrPngBase64 = null;
  try {
    qrPngBase64 = await QRCode.toDataURL(qrData);
  } catch {}
  return { qrData, qrPngBase64 };
}

// =======================
// ADMIN AUTH (required)
// =======================
function requireAdmin(req, res, next) {
  const key = (req.headers["x-admin-key"] || "").toString();
  const expected = (process.env.ADMIN_KEY || "").toString();

  if (!expected) return res.status(500).json({ ok: false, error: "ADMIN_KEY env sozlanmagan" });
  if (!key || key !== expected) return res.status(401).json({ ok: false, error: "Admin ruxsat yo‘q (X-Admin-Key xato)" });
  next();
}

// ===== ROUTES =====

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "navbatuz", time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "DB error", detail: e.message });
  }
});

app.get("/api/geo", (req, res) => {
  try {
    const geo = loadGeo();
    res.json(geo);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Ticket olish
// =======================
app.post("/api/take", async (req, res) => {
  try {
    const { orgId, platform = "web", userId = null, fullName = "" } = req.body || {};
    const geo = loadGeo();

    const org = safeStr(orgId, "").trim();
    if (!validateOrgId(geo, org)) {
      return res.status(400).json({ ok: false, error: "Noto‘g‘ri orgId (geo.json’dan topilmadi)" });
    }

    const full_name = safeStr(fullName, "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!full_name || full_name.length < 3) {
      return res.status(400).json({ ok: false, error: "Ism familiya kiriting" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // MUHIM: normalizatsiya (lock bilan)
      const st2 = await normalizeOrgState(client, org);
      const currentNumber = st2.currentNumber;

      // Endi next_number doim to‘g‘ri
      const st = await client.query(
        `SELECT next_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );
      const nextNumber = safeInt(st.rows[0]?.next_number, 1);

      const t = await client.query(
        `INSERT INTO tickets (org_id, number, platform, user_id, full_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, org_id, number, status, created_at, full_name`,
        [org, nextNumber, platform, userId, full_name]
      );

      await client.query(
        `UPDATE org_state SET next_number = next_number + 1, updated_at=now()
         WHERE org_id=$1`,
        [org]
      );

      await client.query("COMMIT");

      const ticket = t.rows[0];

      // public snapshot
      const nowServing = currentNumber + 1;
      const avgServiceSec = await computeAvgServiceSec(org);

      const stAfter = await pool.query(`SELECT next_number FROM org_state WHERE org_id=$1`, [org]);
      const lastNumber = Math.max(0, safeInt(stAfter.rows[0]?.next_number, 1) - 1);

      const { qrData, qrPngBase64 } = await makeQr(ticket.id);

      return res.json({
        ok: true,
        ticketId: String(ticket.id),
        number: safeInt(ticket.number, 0),
        nowServing,
        lastNumber,
        avgServiceSec: avgServiceSec ?? null,
        ticket: {
          id: ticket.id,
          orgId: ticket.org_id,
          number: ticket.number,
          status: ticket.status,
          createdAt: ticket.created_at,
          currentNumber,
          remaining: Math.max(0, ticket.number - nowServing),
          etaMinutes: avgServiceSec ? Math.round((Math.max(0, ticket.number - nowServing) * avgServiceSec) / 60) : null,
          fullName: ticket.full_name,
          qrData,
          qrPngBase64,
          platform,
          userId,
        },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /api/take error:", e);
    res.status(500).json({
      ok: false,
      error: e.message || "Server error",
      hint: "DATABASE_URL va DB ulanishini tekshiring. Render logs'ni ko'ring.",
    });
  }
});

// =======================
// Status (orgId + number)
// =======================
app.get("/api/ticket", async (req, res) => {
  try {
    const orgId = safeStr(req.query.orgId, "").trim();
    const number = req.query.number ? safeInt(req.query.number, 0) : null;

    if (!orgId) return res.status(400).json({ ok: false, error: "orgId kerak" });

    // Normalizatsiya: now/last mos bo‘lsin
    await normalizeOrgState(pool, orgId);

    const st = await pool.query(`SELECT current_number, next_number FROM org_state WHERE org_id=$1`, [orgId]);

    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);

    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(orgId);

    const base = { ok: true, nowServing, lastNumber, avgServiceSec: avgServiceSec ?? null };

    if (number) {
      const t = await pool.query(
        `SELECT id, org_id, number, status, created_at, updated_at, full_name
         FROM tickets WHERE org_id=$1 AND number=$2
         ORDER BY created_at DESC
         LIMIT 1`,
        [orgId, number]
      );

      if (t.rowCount) {
        const row = t.rows[0];

        await autoUpdateTicketStatusIfNeeded({
          ticketId: row.id,
          number: safeInt(row.number, 0),
          nowServing,
        });

        const t2 = await pool.query(
          `SELECT id, org_id, number, status, created_at, updated_at, full_name
           FROM tickets WHERE id=$1`,
          [row.id]
        );
        const row2 = t2.rows[0];

        base.ticket = {
          id: row2.id,
          orgId: row2.org_id,
          number: row2.number,
          status: row2.status,
          createdAt: row2.created_at,
          updatedAt: row2.updated_at,
          currentNumber,
          remaining: Math.max(0, number - nowServing),
          etaMinutes: avgServiceSec ? Math.round((Math.max(0, number - nowServing) * avgServiceSec) / 60) : null,
          fullName: row2.full_name,
        };
      }
    }

    res.json(base);
  } catch (e) {
    console.error("GET /api/ticket error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Ticket by ID + QR
// =======================
app.get("/api/ticket/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const t = await pool.query(
      `SELECT id, org_id, number, status, created_at, updated_at, full_name
       FROM tickets WHERE id=$1`,
      [id]
    );
    if (!t.rowCount) return res.status(404).json({ ok: false, error: "Ticket topilmadi" });

    const ticket = t.rows[0];

    await normalizeOrgState(pool, ticket.org_id);

    const st = await pool.query(`SELECT current_number, next_number FROM org_state WHERE org_id=$1`, [ticket.org_id]);

    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);

    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(ticket.org_id);

    await autoUpdateTicketStatusIfNeeded({
      ticketId: ticket.id,
      number: safeInt(ticket.number, 0),
      nowServing,
    });

    const t2 = await pool.query(
      `SELECT id, org_id, number, status, created_at, updated_at, full_name
       FROM tickets WHERE id=$1`,
      [id]
    );
    const ticket2 = t2.rows[0];

    const { qrData, qrPngBase64 } = await makeQr(ticket2.id);

    res.json({
      ok: true,
      ticketId: String(ticket2.id),
      number: safeInt(ticket2.number, 0),
      nowServing,
      lastNumber,
      avgServiceSec: avgServiceSec ?? null,
      qrData,
      qrPngBase64,
      ticket: {
        id: ticket2.id,
        orgId: ticket2.org_id,
        number: ticket2.number,
        status: ticket2.status,
        createdAt: ticket2.created_at,
        updatedAt: ticket2.updated_at,
        currentNumber,
        remaining: Math.max(0, ticket2.number - nowServing),
        etaMinutes: avgServiceSec ? Math.round((Math.max(0, ticket2.number - nowServing) * avgServiceSec) / 60) : null,
        fullName: ticket2.full_name,
        qrData,
        qrPngBase64,
      },
    });
  } catch (e) {
    console.error("GET /api/ticket/:id error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// cancel
// =======================
app.post("/api/cancel", async (req, res) => {
  try {
    const { orgId, number } = req.body || {};
    const org = safeStr(orgId, "").trim();
    const num = safeInt(number, 0);

    if (!org || !num) return res.status(400).json({ ok: false, error: "orgId va number kerak" });

    const r = await pool.query(
      `UPDATE tickets
       SET status='cancelled', updated_at=now()
       WHERE org_id=$1 AND number=$2 AND status IN ('waiting','missed')
       RETURNING id`,
      [org, num]
    );

    res.json({ ok: true, cancelled: !!r.rowCount });
  } catch (e) {
    console.error("POST /api/cancel error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// USER: served
// =======================
app.post("/api/ticket/served", async (req, res) => {
  try {
    const { ticketId } = req.body || {};
    const id = safeStr(ticketId, "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "ticketId kerak" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const t = await client.query(
        `SELECT id, org_id, number, status FROM tickets WHERE id=$1 FOR UPDATE`,
        [id]
      );
      if (!t.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "Ticket topilmadi" });
      }

      const ticket = t.rows[0];

      await client.query(
        `UPDATE tickets
         SET status='served', served_at=now(), updated_at=now()
         WHERE id=$1`,
        [id]
      );

      const stx = await normalizeOrgState(client, ticket.org_id);
      let currentNumber = stx.currentNumber;

      const nowServing = currentNumber + 1;
      if (safeInt(ticket.number, 0) === nowServing) {
        await client.query(
          `UPDATE org_state
           SET current_number=current_number+1, updated_at=now()
           WHERE org_id=$1`,
          [ticket.org_id]
        );
        currentNumber++;
      }

      await client.query("COMMIT");

      const stAfter = await pool.query(`SELECT next_number FROM org_state WHERE org_id=$1`, [ticket.org_id]);
      const lastNumber = Math.max(0, safeInt(stAfter.rows[0]?.next_number, 1) - 1);

      return res.json({
        ok: true,
        served: true,
        currentNumber,
        nowServing: currentNumber + 1,
        lastNumber,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /api/ticket/served error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// ADMIN: queue snapshot
// GET /api/admin/queue?orgId=xxx
// (admin.html shu endpointni chaqiryapti :contentReference[oaicite:2]{index=2})
// =======================
app.get("/api/admin/queue", requireAdmin, async (req, res) => {
  try {
    const orgId = safeStr(req.query.orgId, "").trim();
    if (!orgId) return res.status(400).json({ ok: false, error: "orgId kerak" });

    await normalizeOrgState(pool, orgId);

    const st = await pool.query(`SELECT current_number, next_number FROM org_state WHERE org_id=$1`, [orgId]);
    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);

    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(orgId);

    const t = await pool.query(
      `SELECT id, org_id, number, status, created_at, full_name
       FROM tickets
       WHERE org_id=$1 AND status IN ('waiting','missed')
       ORDER BY number ASC
       LIMIT 500`,
      [orgId]
    );

    return res.json({
      ok: true,
      orgId,
      nowServing,
      lastNumber,
      avgServiceSec: avgServiceSec ?? null,
      tickets: t.rows.map((r) => ({
        id: String(r.id),
        orgId: r.org_id,
        number: safeInt(r.number, 0),
        status: r.status,
        createdAt: r.created_at,
        fullName: r.full_name,
      })),
    });
  } catch (e) {
    console.error("GET /api/admin/queue error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// ADMIN: next
// POST /api/admin/next { orgId }
// =======================
app.post("/api/admin/next", requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const stx = await normalizeOrgState(client, org);
      const currentNumber = stx.currentNumber;

      const st = await client.query(
        `SELECT current_number, next_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );
      const cur = safeInt(st.rows[0]?.current_number, currentNumber);
      const next = safeInt(st.rows[0]?.next_number, 1);

      const nowServing = cur + 1;
      const lastNumber = Math.max(0, next - 1);

      // Navbat yo‘q bo‘lsa, oldinga o‘tkazmaymiz
      if (nowServing > lastNumber) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Aktiv navbat yo‘q (NEXT qilinmaydi)" });
      }

      await client.query(
        `UPDATE org_state SET current_number=current_number+1, updated_at=now() WHERE org_id=$1`,
        [org]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        currentNumber: cur + 1,
        nowServing: cur + 2,
        lastNumber,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /api/admin/next error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// ADMIN: delete one ticket (cancel)
// POST /api/admin/delete { ticketId }
// =======================
app.post("/api/admin/delete", requireAdmin, async (req, res) => {
  try {
    const { ticketId } = req.body || {};
    const id = safeStr(ticketId, "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "ticketId kerak" });

    const r = await pool.query(
      `UPDATE tickets
       SET status='cancelled', updated_at=now()
       WHERE id=$1 AND status IN ('waiting','missed')
       RETURNING id, org_id, number, status`,
      [id]
    );

    if (!r.rowCount) return res.json({ ok: true, changed: false, note: "ticket topilmadi yoki status mos emas" });
    return res.json({ ok: true, changed: true, ticket: r.rows[0] });
  } catch (e) {
    console.error("POST /api/admin/delete error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// ADMIN: delete ALL waiting/missed for org (cancel)
// POST /api/admin/deleteAll { orgId }
// =======================
app.post("/api/admin/deleteAll", requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });

    const r = await pool.query(
      `UPDATE tickets
       SET status='cancelled', updated_at=now()
       WHERE org_id=$1 AND status IN ('waiting','missed')`,
      [org]
    );

    return res.json({ ok: true, cancelledCount: r.rowCount || 0 });
  } catch (e) {
    console.error("POST /api/admin/deleteAll error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// ADMIN: skip one ticket (mark missed, and if it is nowServing -> advance)
// POST /api/admin/skip { orgId, ticketId }
// =======================
app.post("/api/admin/skip", requireAdmin, async (req, res) => {
  try {
    const { orgId, ticketId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    const id = safeStr(ticketId, "").trim();

    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });
    if (!id) return res.status(400).json({ ok: false, error: "ticketId kerak" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await normalizeOrgState(client, org);

      const t = await client.query(
        `SELECT id, org_id, number, status
         FROM tickets
         WHERE id=$1 AND org_id=$2
         FOR UPDATE`,
        [id, org]
      );

      if (!t.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "Ticket topilmadi" });
      }

      const ticket = t.rows[0];

      if (ticket.status === "waiting") {
        await client.query(`UPDATE tickets SET status='missed', updated_at=now() WHERE id=$1`, [id]);
      }

      const st = await client.query(`SELECT current_number FROM org_state WHERE org_id=$1 FOR UPDATE`, [org]);
      const currentNumber = safeInt(st.rows[0]?.current_number, 0);
      const nowServing = currentNumber + 1;

      if (safeInt(ticket.number, 0) === nowServing) {
        // skip qilingan navbat ayni "now" bo‘lsa, oldinga o‘tkazamiz
        await client.query(
          `UPDATE org_state SET current_number=current_number+1, updated_at=now() WHERE org_id=$1`,
          [org]
        );
      }

      await client.query("COMMIT");
      return res.json({ ok: true, skipped: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /api/admin/skip error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// ADMIN: reset
// POST /api/admin/reset { orgId }
// =======================
app.post("/api/admin/reset", requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });

    await pool.query(`UPDATE org_state SET current_number=0, next_number=1, updated_at=now() WHERE org_id=$1`, [org]);
    await pool.query(
      `UPDATE tickets SET status='cancelled', updated_at=now()
       WHERE org_id=$1 AND status IN ('waiting','missed')`,
      [org]
    );

    res.json({ ok: true, reset: true });
  } catch (e) {
    console.error("POST /api/admin/reset error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Boot
(async function start() {
  try {
    await initDb();
    app.listen(PORT, () => console.log(`✅ NAVBATUZ running on :${PORT}`));
  } catch (e) {
    console.error("❌ Failed to start:", e);
    process.exit(1);
  }
})();
