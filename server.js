// server.js
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// Render/Heroku kabi joylarda SSL kerak bo‘lishi mumkin:
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: "2mb" }));

// Static site
app.use(express.static(path.join(__dirname, "public")));

// --- Geo loader (single source of truth) ---
const GEO_PATH = path.join(__dirname, "public", "geo.json");

function loadGeo() {
  if (!fs.existsSync(GEO_PATH)) {
    throw new Error(`geo.json topilmadi: ${GEO_PATH}`);
  }
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

// --- Helper: org validation ---
function validateOrgId(geo, orgId) {
  if (!orgId || typeof orgId !== "string") return false;

  // orgsByUnitUzKey ichidan qidiramiz
  const map = geo.orgsByUnitUzKey || {};
  for (const key of Object.keys(map)) {
    const arr = map[key] || [];
    for (const org of arr) {
      const oid = String(org.id);
      if (oid === orgId) return true;
    }
  }
  return false;
}

// --- DB init ---
async function initDb() {
  // gen_random_uuid() uchun extension avval:
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_state (
      org_id TEXT PRIMARY KEY,
      next_number INTEGER NOT NULL DEFAULT 1,
      current_number INTEGER NOT NULL DEFAULT 0, -- bu: oxirgi "served" bo'lgan raqam
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting', -- waiting|served|cancelled
      platform TEXT,
      user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      served_at TIMESTAMPTZ
    );
  `);

  // Indexlar (tezlik uchun)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_num ON tickets(org_id, number);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_status ON tickets(org_id, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_served_at ON tickets(org_id, served_at);`);
}

// --- Avg service seconds (last 3-4 served intervals) ---
async function computeAvgServiceSec(orgId) {
  // oxirgi 6 ta served_at ni olamiz (diff uchun)
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

  const times = r.rows.map((x) => new Date(x.served_at).getTime()).filter((t) => Number.isFinite(t));
  if (times.length < 3) return null;

  // consecutive difflar: t0-t1, t1-t2, ...
  const diffsSec = [];
  for (let i = 0; i < times.length - 1; i++) {
    const d = (times[i] - times[i + 1]) / 1000;
    if (d > 5 && d < 60 * 60 * 6) diffsSec.push(Math.round(d)); // 5s..6h
    if (diffsSec.length >= 4) break;
  }

  if (diffsSec.length < 3) return null;

  const avg = Math.round(diffsSec.reduce((a, b) => a + b, 0) / diffsSec.length);
  return avg;
}

// --- API: health ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "navbatuz", time: new Date().toISOString() });
});

// --- API: geo ---
app.get("/api/geo", (req, res) => {
  try {
    const geo = loadGeo();
    res.json(geo);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================================================
// ✅ API: take ticket  (index.html mos format)
// POST /api/take
// body: { orgId, platform?: "web|bot|app", userId?: "..." }
// =======================================================
app.post("/api/take", async (req, res) => {
  try {
    const { orgId, platform = "web", userId = null } = req.body || {};
    const geo = loadGeo();

    const org = safeStr(orgId, "").trim();
    if (!validateOrgId(geo, org)) {
      return res.status(400).json({ ok: false, error: "Noto‘g‘ri orgId (geo.json’dan topilmadi)" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // org_state yo‘q bo‘lsa yaratamiz
      await client.query(
        `INSERT INTO org_state (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO NOTHING`,
        [org]
      );

      // lock state
      const st = await client.query(
        `SELECT next_number, current_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );

      const nextNumber = safeInt(st.rows[0]?.next_number, 1);
      const currentNumber = safeInt(st.rows[0]?.current_number, 0);

      // Ticket yaratamiz
      const t = await client.query(
        `INSERT INTO tickets (org_id, number, platform, user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, org_id, number, status, created_at`,
        [org, nextNumber, platform, userId]
      );

      // next_number++
      await client.query(
        `UPDATE org_state SET next_number = next_number + 1, updated_at=now()
         WHERE org_id=$1`,
        [org]
      );

      await client.query("COMMIT");

      const ticket = t.rows[0];

      // INDEX.HTML uchun:
      // current_number = oxirgi served. Demak hozir xizmat qilinayotgan raqam: current_number + 1
      const nowServing = currentNumber + 1;
      const lastNumber = nextNumber; // hozir berilgan ticket ham last bo‘ldi (take oldidan nextNumber edi)
      const avgServiceSec = await computeAvgServiceSec(org);

      // QR: ticket link
      const publicBase = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
      const qrData = `${publicBase}/ticket.html?id=${ticket.id}`;
      const qrPngBase64 = await QRCode.toDataURL(qrData);

      // Eski “ticket{}”ni ham saqlaymiz (bot/app uchun qulay)
      // + index.html kutgan TOP-LEVEL maydonlar
      return res.json({
        ok: true,

        // ✅ index.html kutadi:
        ticketId: String(ticket.id),
        number: safeInt(ticket.number, 0),
        nowServing,
        lastNumber,
        avgServiceSec: avgServiceSec ?? null,

        // qo‘shimcha:
        ticket: {
          id: ticket.id,
          orgId: ticket.org_id,
          number: ticket.number,
          status: ticket.status,
          createdAt: ticket.created_at,
          currentNumber,
          remaining: Math.max(0, ticket.number - nowServing),
          etaMinutes: avgServiceSec ? Math.round((Math.max(0, ticket.number - nowServing) * avgServiceSec) / 60) : null,
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================================================
// ✅ API: ticket status (INDEX uchun)
// GET /api/ticket?orgId=...&number=...  (number ixtiyoriy)
// GET /api/ticket?orgId=...             (faqat org holati)
// =======================================================
app.get("/api/ticket", async (req, res) => {
  try {
    const orgId = safeStr(req.query.orgId, "").trim();
    const number = req.query.number ? safeInt(req.query.number, 0) : null;

    if (!orgId) return res.status(400).json({ ok: false, error: "orgId kerak" });

    const st = await pool.query(
      `SELECT current_number, next_number FROM org_state WHERE org_id=$1`,
      [orgId]
    );

    if (!st.rowCount) {
      return res.status(404).json({ ok: false, error: "org_state topilmadi" });
    }

    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);

    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(orgId);

    // index.html uchun top-level
    const base = {
      ok: true,
      nowServing,
      lastNumber,
      avgServiceSec: avgServiceSec ?? null,
    };

    // agar number berilgan bo‘lsa, ticketni ham tekshirib statusini qaytaramiz
    if (number) {
      const t = await pool.query(
        `SELECT id, org_id, number, status, created_at, updated_at
         FROM tickets WHERE org_id=$1 AND number=$2
         ORDER BY created_at DESC
         LIMIT 1`,
        [orgId, number]
      );

      if (t.rowCount) {
        base.ticket = {
          id: t.rows[0].id,
          orgId: t.rows[0].org_id,
          number: t.rows[0].number,
          status: t.rows[0].status,
          createdAt: t.rows[0].created_at,
          updatedAt: t.rows[0].updated_at,
          currentNumber,
          remaining: Math.max(0, number - nowServing),
          etaMinutes: avgServiceSec ? Math.round((Math.max(0, number - nowServing) * avgServiceSec) / 60) : null,
        };
      }
    }

    res.json(base);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- API: ticket status by id ---
// GET /api/ticket/:id   (saqlab qolindi)
app.get("/api/ticket/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const t = await pool.query(
      `SELECT id, org_id, number, status, created_at, updated_at
       FROM tickets WHERE id=$1`,
      [id]
    );
    if (!t.rowCount) return res.status(404).json({ ok: false, error: "Ticket topilmadi" });

    const ticket = t.rows[0];

    const st = await pool.query(
      `SELECT current_number, next_number FROM org_state WHERE org_id=$1`,
      [ticket.org_id]
    );

    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);
    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(ticket.org_id);

    // index.html uchun ham mos top-level qaytaramiz
    res.json({
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
        updatedAt: ticket.updated_at,
        currentNumber,
        remaining: Math.max(0, ticket.number - nowServing),
        etaMinutes: avgServiceSec ? Math.round((Math.max(0, ticket.number - nowServing) * avgServiceSec) / 60) : null,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================================================
// ✅ API: cancel ticket (index auto-cancel ham ishlashi uchun)
// POST /api/cancel  body: { orgId, number }  (ticketId ixtiyoriy)
// =======================================================
app.post("/api/cancel", async (req, res) => {
  try {
    const { orgId, number } = req.body || {};
    const org = safeStr(orgId, "").trim();
    const num = safeInt(number, 0);

    if (!org || !num) return res.status(400).json({ ok: false, error: "orgId va number kerak" });

    const r = await pool.query(
      `UPDATE tickets
       SET status='cancelled', updated_at=now()
       WHERE org_id=$1 AND number=$2 AND status='waiting'
       RETURNING id`,
      [org, num]
    );

    res.json({ ok: true, cancelled: !!r.rowCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- (ixtiyoriy) Admin: navbatni oldinga surish ---
// POST /api/admin/next  body: { orgId }
app.post("/api/admin/next", async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const st = await client.query(
        `SELECT current_number, next_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );
      if (!st.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "org_state topilmadi" });
      }

      const currentNumber = safeInt(st.rows[0]?.current_number, 0);
      const nextNumber = safeInt(st.rows[0]?.next_number, 1);

      // xizmat qilinadigan raqam: current + 1
      const servingNow = currentNumber + 1;

      // agar servingNow < nextNumber bo'lsa, demak navbatda kimdir bor
      if (servingNow < nextNumber) {
        // shu raqamdagi ticketni served qilamiz
        await client.query(
          `UPDATE tickets
           SET status='served', served_at=now(), updated_at=now()
           WHERE org_id=$1 AND number=$2 AND status='waiting'`,
          [org, servingNow]
        );

        // current_number++ qilamiz
        const r = await client.query(
          `UPDATE org_state
           SET current_number = current_number + 1, updated_at=now()
           WHERE org_id=$1
           RETURNING current_number`,
          [org]
        );

        await client.query("COMMIT");

        const newCurrent = safeInt(r.rows[0]?.current_number, 0);
        const nowServing = newCurrent + 1;
        const lastNumber = Math.max(0, nextNumber - 1);
        const avgServiceSec = await computeAvgServiceSec(org);

        return res.json({
          ok: true,
          currentNumber: newCurrent,
          nowServing,
          lastNumber,
          avgServiceSec: avgServiceSec ?? null,
        });
      } else {
        // navbat yo'q
        await client.query("COMMIT");
        return res.json({ ok: true, message: "Navbat bo‘sh", currentNumber, nowServing: currentNumber + 1, lastNumber: Math.max(0, nextNumber - 1) });
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// fallback: SPA index
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`NAVBATUZ server running on ${PORT}`));
  })
  .catch((e) => {
    console.error("DB init error:", e);
    process.exit(1);
  });
