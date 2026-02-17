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

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL env topilmadi. Render’da DATABASE_URL ni qo‘ying.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use(express.static(path.join(__dirname, "public")));

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
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_state' AND column_name='orgId')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_state' AND column_name='org_id')
      THEN
        ALTER TABLE org_state RENAME COLUMN "orgId" TO org_id;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_state' AND column_name='org_id') THEN
        ALTER TABLE org_state ADD COLUMN org_id TEXT;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_state' AND column_name='next_number') THEN
        ALTER TABLE org_state ADD COLUMN next_number INTEGER NOT NULL DEFAULT 1;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_state' AND column_name='current_number') THEN
        ALTER TABLE org_state ADD COLUMN current_number INTEGER NOT NULL DEFAULT 0;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_state' AND column_name='updated_at') THEN
        ALTER TABLE org_state ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      platform TEXT,
      user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      served_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='orgId')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='org_id')
      THEN
        ALTER TABLE tickets RENAME COLUMN "orgId" TO org_id;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='org_id') THEN
        ALTER TABLE tickets ADD COLUMN org_id TEXT;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='number') THEN
        ALTER TABLE tickets ADD COLUMN number INTEGER;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='status') THEN
        ALTER TABLE tickets ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting';
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='platform') THEN
        ALTER TABLE tickets ADD COLUMN platform TEXT;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='user_id') THEN
        ALTER TABLE tickets ADD COLUMN user_id TEXT;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='created_at') THEN
        ALTER TABLE tickets ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='updated_at') THEN
        ALTER TABLE tickets ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='served_at') THEN
        ALTER TABLE tickets ADD COLUMN served_at TIMESTAMPTZ;
      END IF;
    END $$;
  `);

  // ✅ ✅ ✅ CRITICAL FIX #1: eski DB'da tickets.name NOT NULL bo'lsa /api/take 500 bo'ladi.
  // Biz name ustunini nullable qilamiz (agar ustun bo'lsa).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='tickets' AND column_name='name'
      ) THEN
        BEGIN
          ALTER TABLE tickets ALTER COLUMN name DROP NOT NULL;
        EXCEPTION WHEN others THEN
          NULL;
        END;
      END IF;
    END $$;
  `);

  // ✅ ✅ ✅ CRITICAL FIX #2: sizdagi hozirgi xato — tickets.phone NOT NULL
  // Biz phone ustunini ham nullable qilamiz (agar ustun bo'lsa).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='tickets' AND column_name='phone'
      ) THEN
        BEGIN
          ALTER TABLE tickets ALTER COLUMN phone DROP NOT NULL;
        EXCEPTION WHEN others THEN
          NULL;
        END;
      END IF;
    END $$;
  `);

  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_num ON tickets(org_id, number);`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_status ON tickets(org_id, status);`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_served_at ON tickets(org_id, served_at);`); } catch {}
}

async function computeAvgServiceSec(orgId) {
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

    if (times.length < 3) return null;

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

async function autoUpdateTicketStatusIfNeeded({ ticketId, orgId, number, nowServing }) {
  if (!ticketId || !orgId || !number || !Number.isFinite(nowServing)) return null;

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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "navbatuz", time: new Date().toISOString() });
});

app.get("/api/geo", (req, res) => {
  try {
    const geo = loadGeo();
    res.json(geo);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

      await client.query(
        `INSERT INTO org_state (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO NOTHING`,
        [org]
      );

      const st = await client.query(
        `SELECT next_number, current_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [org]
      );

      const nextNumber = safeInt(st.rows[0]?.next_number, 1);
      const currentNumber = safeInt(st.rows[0]?.current_number, 0);

      const t = await client.query(
        `INSERT INTO tickets (org_id, number, platform, user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, org_id, number, status, created_at`,
        [org, nextNumber, platform, userId]
      );

      await client.query(
        `UPDATE org_state SET next_number = next_number + 1, updated_at=now()
         WHERE org_id=$1`,
        [org]
      );

      await client.query("COMMIT");

      const ticket = t.rows[0];
      const nowServing = currentNumber + 1;
      const lastNumber = nextNumber;
      const avgServiceSec = await computeAvgServiceSec(org);

      const publicBase = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
      const qrData = `${publicBase}/ticket.html?id=${ticket.id}`;

      let qrPngBase64 = null;
      try {
        qrPngBase64 = await QRCode.toDataURL(qrData);
      } catch (e) {
        console.error("QRCode error:", e?.message || e);
        qrPngBase64 = null;
      }

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
          qrData,
          qrPngBase64,
          platform,
          userId
        }
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
      hint: "DATABASE_URL va DB ulanishini tekshiring. Render logs'ni ko'ring."
    });
  }
});

app.get("/api/ticket", async (req, res) => {
  try {
    const orgId = safeStr(req.query.orgId, "").trim();
    const number = req.query.number ? safeInt(req.query.number, 0) : null;

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

    const base = { ok: true, nowServing, lastNumber, avgServiceSec: avgServiceSec ?? null };

    if (number) {
      const t = await pool.query(
        `SELECT id, org_id, number, status, created_at, updated_at
         FROM tickets WHERE org_id=$1 AND number=$2
         ORDER BY created_at DESC
         LIMIT 1`,
        [orgId, number]
      );

      if (t.rowCount) {
        const row = t.rows[0];

        await autoUpdateTicketStatusIfNeeded({
          ticketId: row.id,
          orgId: row.org_id,
          number: safeInt(row.number, 0),
          nowServing
        });

        const t2 = await pool.query(
          `SELECT id, org_id, number, status, created_at, updated_at
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
          etaMinutes: avgServiceSec ? Math.round((Math.max(0, number - nowServing) * avgServiceSec) / 60) : null
        };
      }
    }

    res.json(base);
  } catch (e) {
    console.error("GET /api/ticket error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

    await ensureOrgState(ticket.org_id);

    const st = await pool.query(
      `SELECT current_number, next_number FROM org_state WHERE org_id=$1`,
      [ticket.org_id]
    );

    const currentNumber = safeInt(st.rows[0]?.current_number, 0);
    const nextNumber = safeInt(st.rows[0]?.next_number, 1);

    const nowServing = currentNumber + 1;
    const lastNumber = Math.max(0, nextNumber - 1);
    const avgServiceSec = await computeAvgServiceSec(ticket.org_id);

    await autoUpdateTicketStatusIfNeeded({
      ticketId: ticket.id,
      orgId: ticket.org_id,
      number: safeInt(ticket.number, 0),
      nowServing
    });

    const t2 = await pool.query(
      `SELECT id, org_id, number, status, created_at, updated_at
       FROM tickets WHERE id=$1`,
      [id]
    );
    const ticket2 = t2.rows[0];

    res.json({
      ok: true,
      ticketId: String(ticket2.id),
      number: safeInt(ticket2.number, 0),
      nowServing,
      lastNumber,
      avgServiceSec: avgServiceSec ?? null,
      ticket: {
        id: ticket2.id,
        orgId: ticket2.org_id,
        number: ticket2.number,
        status: ticket2.status,
        createdAt: ticket2.created_at,
        updatedAt: ticket2.updated_at,
        currentNumber,
        remaining: Math.max(0, ticket2.number - nowServing),
        etaMinutes: avgServiceSec
          ? Math.round((Math.max(0, ticket2.number - nowServing) * avgServiceSec) / 60)
          : null
      }
    });
  } catch (e) {
    console.error("GET /api/ticket/:id error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
// USER: o‘z ticketini served deb belgilaydi
app.post("/api/ticket/served", async (req, res) => {
  try {
    const { ticketId } = req.body || {};

    if (!ticketId) {
      return res.status(400).json({
        ok: false,
        error: "ticketId kerak"
      });
    }

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

        return res.status(404).json({
          ok: false,
          error: "Ticket topilmadi"
        });

      }

      const ticket = t.rows[0];

      if (ticket.status === "served") {

        await client.query("COMMIT");

        return res.json({
          ok: true,
          message: "Already served"
        });

      }

      await client.query(
        `UPDATE tickets
         SET status='served',
             served_at=now(),
             updated_at=now()
         WHERE id=$1`,
        [ticketId]
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

      if (ticket.number === nowServing) {

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
        lastNumber: Math.max(0, nextNumber - 1)
      });

    }
    catch (e) {

      await client.query("ROLLBACK");

      throw e;

    }
    finally {

      client.release();

    }

  }
  catch (e) {

    console.error("POST /api/ticket/served error:", e);

    res.status(500).json({
      ok: false,
      error: e.message
    });

  }
});

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
      const servingNow = currentNumber + 1;

      if (servingNow < nextNumber) {
        await client.query(
          `UPDATE tickets
           SET status='served', served_at=now(), updated_at=now()
           WHERE org_id=$1 AND number=$2 AND status IN ('waiting','missed')`,
          [org, servingNow]
        );

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

        return res.json({ ok: true, currentNumber: newCurrent, nowServing, lastNumber, avgServiceSec: avgServiceSec ?? null });
      } else {
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
    console.error("POST /api/admin/next error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

