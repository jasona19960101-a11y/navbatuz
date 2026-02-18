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
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL env topilmadi. Render’da DATABASE_URL ni qo‘ying.");
}

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

// ---- CORS ----
const corsOrigin = (process.env.CORS_ORIGIN || "").trim();
if (corsOrigin) {
  const allow = corsOrigin.split(",").map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: allow, credentials: true }));
} else {
  app.use(cors());
}

app.use(express.json({ limit: "3mb" }));

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
  for (const key of Object.keys(map)) {
    const arr = map[key] || [];
    for (const org of arr) {
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
      status TEXT NOT NULL DEFAULT 'waiting', -- waiting | missed | served | cancelled
      full_name TEXT,
      platform TEXT,
      user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      served_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(org_id, number)
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_status_number ON tickets(org_id, status, number);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_created ON tickets(org_id, created_at DESC);`);

  console.log("✅ DB ready");
}

async function ensureOrgState(orgId) {
  await pool.query(
    `INSERT INTO org_state (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId]
  );
}

async function computeAvgServiceSec(orgId) {
  // oxirgi 80 ta served bo‘yicha avg vaqt (ticketlar orasidagi served interval)
  // Soddaroq: served_at lar orasidagi farqlar o‘rtachasi
  const r = await pool.query(
    `
    WITH s AS (
      SELECT served_at
      FROM tickets
      WHERE org_id=$1 AND status='served' AND served_at IS NOT NULL
      ORDER BY served_at DESC
      LIMIT 80
    ),
    x AS (
      SELECT served_at, LAG(served_at) OVER (ORDER BY served_at) AS prev
      FROM s
    )
    SELECT AVG(EXTRACT(EPOCH FROM (served_at - prev))) AS avg_sec
    FROM x
    WHERE prev IS NOT NULL
    `,
    [orgId]
  );
  const v = Number(r.rows[0]?.avg_sec);
  if (!Number.isFinite(v) || v <= 0) return null;
  // juda kichik bo‘lib ketmasin
  return Math.max(30, Math.round(v));
}

function requireAdmin(req, res, next) {
  const k = (req.header("X-Admin-Key") || "").trim();
  if (!ADMIN_KEY) return res.status(500).json({ ok: false, error: "ADMIN_KEY env qo‘yilmagan" });
  if (!k || k !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "Admin key noto‘g‘ri" });
  next();
}

// ----------------------
// Public basic endpoints
// ----------------------
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/geo", (req, res) => {
  try {
    const geo = loadGeo();
    res.json(geo);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------
// TAKE TICKET
// POST /api/take { orgId, fullName, platform, userId }
// ----------------------
app.post("/api/take", async (req, res) => {
  try {
    const { orgId, fullName, platform, userId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    const name = safeStr(fullName, "").trim().slice(0, 80);
    const plat = safeStr(platform, "web").trim().slice(0, 30);
    const uid = safeStr(userId, "").trim().slice(0, 80) || null;

    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });
    if (!name || name.length < 3) return res.status(400).json({ ok: false, error: "fullName kerak (min 3)" });

    const geo = loadGeo();
    if (!validateOrgId(geo, org)) {
      return res.status(400).json({ ok: false, error: "orgId geo.json ichida topilmadi" });
    }

    await ensureOrgState(org);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const st = await client.query(
        `SELECT next_number, current_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );
      const nextNumber = safeInt(st.rows[0]?.next_number, 1);
      const currentNumber = safeInt(st.rows[0]?.current_number, 0);

      const ins = await client.query(
        `INSERT INTO tickets (org_id, number, status, full_name, platform, user_id)
         VALUES ($1,$2,'waiting',$3,$4,$5)
         RETURNING id, org_id, number, status, created_at`,
        [org, nextNumber, name, plat, uid]
      );

      await client.query(
        `UPDATE org_state
         SET next_number = next_number + 1, updated_at=now()
         WHERE org_id=$1`,
        [org]
      );

      await client.query("COMMIT");

      const nowServing = currentNumber + 1;
      const lastNumber = nextNumber;

      const avgServiceSec = await computeAvgServiceSec(org);
      const qrData = JSON.stringify({ ticketId: ins.rows[0].id, orgId: org, number: nextNumber });
      const qrPngBase64 = await QRCode.toDataURL(qrData, { margin: 1, width: 260 });

      return res.json({
        ok: true,
        ticketId: ins.rows[0].id,
        number: nextNumber,
        nowServing,
        lastNumber,
        avgServiceSec: avgServiceSec ?? null,
        qrData,
        qrPngBase64,
        ticket: {
          id: ins.rows[0].id,
          orgId: org,
          number: nextNumber,
          status: "waiting",
          createdAt: ins.rows[0].created_at,
          currentNumber,
          remaining: Math.max(0, nextNumber - nowServing),
          etaMinutes: avgServiceSec ? Math.round((Math.max(0, nextNumber - nowServing) * avgServiceSec) / 60) : null,
          fullName: name,
          qrData,
          qrPngBase64,
        },
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /api/take error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------
// GET ticket status by orgId+number
// GET /api/ticket?orgId=xxx&number=19
// ----------------------
app.get("/api/ticket", async (req, res) => {
  try {
    const orgId = safeStr(req.query.orgId, "").trim();
    const number = safeInt(req.query.number, 0);
    if (!orgId || !number) return res.status(400).json({ ok: false, error: "orgId va number kerak" });

    await ensureOrgState(orgId);

    const st = await pool.query(`SELECT current_number, next_number FROM org_state WHERE org_id=$1`, [orgId]);
    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);

    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(orgId);

    const t = await pool.query(
      `SELECT id, org_id, number, status, created_at, updated_at, full_name
       FROM tickets
       WHERE org_id=$1 AND number=$2
       LIMIT 1`,
      [orgId, number]
    );

    const ticket = t.rows[0] || null;
    if (!ticket) {
      return res.json({
        ok: true,
        orgId,
        number,
        exists: false,
        nowServing,
        lastNumber,
        avgServiceSec: avgServiceSec ?? null,
      });
    }

    const remaining = Math.max(0, safeInt(ticket.number, 0) - nowServing);
    const etaMinutes = avgServiceSec ? Math.round((remaining * avgServiceSec) / 60) : null;

    return res.json({
      ok: true,
      orgId,
      number,
      exists: true,
      nowServing,
      lastNumber,
      avgServiceSec: avgServiceSec ?? null,
      ticket: {
        id: ticket.id,
        orgId: ticket.org_id,
        number: safeInt(ticket.number, 0),
        status: ticket.status,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
        currentNumber,
        remaining,
        etaMinutes,
        fullName: ticket.full_name,
      },
    });
  } catch (e) {
    console.error("GET /api/ticket error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------
// Cancel by orgId+number (user)
// POST /api/cancel { orgId, number }
// ----------------------
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

// ----------------------
// Served (user)
// POST /api/ticket/served { ticketId }
// ----------------------
app.post("/api/ticket/served", async (req, res) => {
  try {
    const { ticketId } = req.body || {};
    if (!ticketId) return res.status(400).json({ ok: false, error: "ticketId kerak" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const t = await client.query(
        `SELECT id, org_id, number, status
         FROM tickets
         WHERE id=$1
         FOR UPDATE`,
        [ticketId]
      );

      if (!t.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "Ticket topilmadi" });
      }

      const ticket = t.rows[0];

      if (ticket.status !== "served") {
        await client.query(
          `UPDATE tickets
           SET status='served',
               served_at=now(),
               updated_at=now()
           WHERE id=$1`,
          [ticketId]
        );
      }

      await client.query(
        `INSERT INTO org_state (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO NOTHING`,
        [ticket.org_id]
      );

      const st = await client.query(
        `SELECT current_number, next_number
         FROM org_state
         WHERE org_id=$1
         FOR UPDATE`,
        [ticket.org_id]
      );

      let currentNumber = safeInt(st.rows[0]?.current_number, 0);
      const nextNumber = safeInt(st.rows[0]?.next_number, 1);

      const nowServing = currentNumber + 1;

      // Agar aynan hozirgi chaqirilgan navbat served bo‘lsa, current_number++ qilamiz
      if (safeInt(ticket.number, 0) === nowServing) {
        await client.query(
          `UPDATE org_state
           SET current_number=current_number+1,
               updated_at=now()
           WHERE org_id=$1`,
          [ticket.org_id]
        );
        currentNumber++;
      }

      await client.query("COMMIT");

      return res.json({
        ok: true,
        served: true,
        currentNumber,
        nowServing: currentNumber + 1,
        lastNumber: Math.max(0, nextNumber - 1),
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
// ADMIN: queue snapshot (ALL statuses + counts)
// GET /api/admin/queue?orgId=xxx
// =======================
app.get("/api/admin/queue", requireAdmin, async (req, res) => {
  try {
    const orgId = safeStr(req.query.orgId, "").trim();
    if (!orgId) return res.status(400).json({ ok: false, error: "orgId kerak" });

    await ensureOrgState(orgId);

    const st = await pool.query(
      `SELECT current_number, next_number FROM org_state WHERE org_id=$1`,
      [orgId]
    );

    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);

    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(orgId);

    // counts
    const c = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status='waiting')::int AS waiting,
         COUNT(*) FILTER (WHERE status='missed')::int AS missed,
         COUNT(*) FILTER (WHERE status='served')::int AS served,
         COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
       FROM tickets
       WHERE org_id=$1`,
      [orgId]
    );

    const counts = c.rows[0] || { total: 0, waiting: 0, missed: 0, served: 0, cancelled: 0 };

    // ALL tickets (limit 1200)
    const t = await pool.query(
      `SELECT id, org_id, number, status, created_at, full_name
       FROM tickets
       WHERE org_id=$1
       ORDER BY
         CASE status
           WHEN 'waiting' THEN 1
           WHEN 'missed' THEN 2
           WHEN 'served' THEN 3
           WHEN 'cancelled' THEN 4
           ELSE 9
         END,
         number ASC
       LIMIT 1200`,
      [orgId]
    );

    const tickets = t.rows.map((r) => {
      const num = safeInt(r.number, 0);
      const remaining = Math.max(0, num - nowServing);
      const etaMinutes =
        avgServiceSec && (r.status === "waiting" || r.status === "missed")
          ? Math.round((remaining * avgServiceSec) / 60)
          : null;

      return {
        id: String(r.id),
        orgId: r.org_id,
        number: num,
        status: r.status,
        createdAt: r.created_at,
        fullName: r.full_name,
        remaining,
        etaMinutes,
      };
    });

    return res.json({
      ok: true,
      orgId,
      nowServing,
      lastNumber,
      avgServiceSec: avgServiceSec ?? null,
      counts: {
        total: safeInt(counts.total, 0),
        waiting: safeInt(counts.waiting, 0),
        missed: safeInt(counts.missed, 0),
        served: safeInt(counts.served, 0),
        cancelled: safeInt(counts.cancelled, 0),
      },
      tickets,
    });
  } catch (e) {
    console.error("GET /api/admin/queue error:", e);
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

    if (!r.rowCount) {
      return res.json({ ok: true, changed: false, note: "ticket topilmadi yoki status mos emas" });
    }

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
// ADMIN: skip one ticket (waiting -> missed, if it is nowServing -> advance)
// POST /api/admin/skip { orgId, ticketId }
// =======================
app.post("/api/admin/skip", requireAdmin, async (req, res) => {
  try {
    const { orgId, ticketId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    const id = safeStr(ticketId, "").trim();

    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });
    if (!id) return res.status(400).json({ ok: false, error: "ticketId kerak" });

    await ensureOrgState(org);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

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
        await client.query(
          `UPDATE tickets SET status='missed', updated_at=now()
           WHERE id=$1`,
          [id]
        );
      }

      const st = await client.query(
        `SELECT current_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );
      const currentNumber = safeInt(st.rows[0]?.current_number, 0);
      const nowServing = currentNumber + 1;

      if (safeInt(ticket.number, 0) === nowServing) {
        await client.query(
          `UPDATE org_state
           SET current_number=current_number+1, updated_at=now()
           WHERE org_id=$1`,
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
// ADMIN: next (advance current_number by 1)
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

      await client.query(
        `INSERT INTO org_state (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO NOTHING`,
        [org]
      );

      const st = await client.query(
        `SELECT current_number, next_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );

      const currentNumber = safeInt(st.rows[0]?.current_number, 0);
      const nextNumber = safeInt(st.rows[0]?.next_number, 1);

      await client.query(
        `UPDATE org_state
         SET current_number=current_number+1, updated_at=now()
         WHERE org_id=$1`,
        [org]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        currentNumber: currentNumber + 1,
        nowServing: currentNumber + 2,
        lastNumber: Math.max(0, nextNumber - 1),
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
// ADMIN: reset org (danger)
// POST /api/admin/reset { orgId }
// - current=0 next=1
// - waiting/missed -> cancelled
// =======================
app.post("/api/admin/reset", requireAdmin, async (req, res) => {
  try {
    const { orgId } = req.body || {};
    const org = safeStr(orgId, "").trim();
    if (!org) return res.status(400).json({ ok: false, error: "orgId kerak" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO org_state (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO NOTHING`,
        [org]
      );

      await client.query(
        `UPDATE org_state
         SET current_number=0, next_number=1, updated_at=now()
         WHERE org_id=$1`,
        [org]
      );

      const r = await client.query(
        `UPDATE tickets
         SET status='cancelled', updated_at=now()
         WHERE org_id=$1 AND status IN ('waiting','missed')`,
        [org]
      );

      await client.query("COMMIT");
      return res.json({ ok: true, reset: true, cancelledCount: r.rowCount || 0 });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /api/admin/reset error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Boot
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ NAVBATUZ running on :${PORT}`));
  })
  .catch((e) => {
    console.error("❌ initDb failed:", e);
    process.exit(1);
  });
