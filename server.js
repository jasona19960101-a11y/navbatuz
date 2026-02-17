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

// --- DB init ---
async function initDb() {
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
      status TEXT NOT NULL DEFAULT 'waiting', -- waiting|served|cancelled
      platform TEXT,
      user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // gen_random_uuid() uchun extension:
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
}

function safeInt(n, def = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : def;
}

// --- API: geo ---
app.get("/api/geo", (req, res) => {
  try {
    const geo = loadGeo();
    // Har doim aynan shu geo.json qaytadi
    res.json(geo);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Helper: org validation ---
function validateOrgId(geo, orgId) {
  if (!orgId || typeof orgId !== "string") return false;

  // geo.json format: orgsByUnitId { "160": [ {id, name, ...} ] }
  // orgId ni biz "unitId:orgIndex" yoki "org.id" kabi saqlashimiz mumkin.
  // Eng ishonchli: geo.json ichidagi org obyektida id bo‘lsa, shuni ishlatamiz.
  // Bo‘lmasa, fallback: "unitId|name" kabi.
  const orgsByUnitId = geo.orgsByUnitId || {};
  for (const unitId of Object.keys(orgsByUnitId)) {
    const arr = orgsByUnitId[unitId] || [];
    for (const org of arr) {
      const oid = String(org.id ?? `${unitId}:${org.name}`);
      if (oid === orgId) return true;
    }
  }
  return false;
}

// --- API: take ticket (single command for site/app/bot) ---
// POST /api/take
// body: { orgId: "....", platform?: "web|bot|app", userId?: "..." }
app.post("/api/take", async (req, res) => {
  try {
    const { orgId, platform = "web", userId = null } = req.body || {};
    const geo = loadGeo();

    if (!validateOrgId(geo, String(orgId || ""))) {
      return res.status(400).json({ ok: false, error: "Noto‘g‘ri orgId (geo.json’dan topilmadi)" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // org_state bor-yo‘qligini tekshirib, yo‘q bo‘lsa yaratamiz
      await client.query(
        `INSERT INTO org_state (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO NOTHING`,
        [orgId]
      );

      const st = await client.query(
        `SELECT next_number, current_number FROM org_state WHERE org_id=$1 FOR UPDATE`,
        [orgId]
      );

      const nextNumber = safeInt(st.rows[0]?.next_number, 1);
      const currentNumber = safeInt(st.rows[0]?.current_number, 0);

      // Ticket yaratamiz
      const t = await client.query(
        `INSERT INTO tickets (org_id, number, platform, user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, org_id, number, status, created_at`,
        [orgId, nextNumber, platform, userId]
      );

      // next_number++
      await client.query(
        `UPDATE org_state SET next_number = next_number + 1, updated_at=now()
         WHERE org_id=$1`,
        [orgId]
      );

      await client.query("COMMIT");

      const ticket = t.rows[0];
      const remaining = Math.max(0, ticket.number - currentNumber);
      const etaMinutes = remaining * 5; // oddiy formula (xohlasangiz keyin sozlaymiz)

      // QR: ticket link
      const publicBase = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
      const qrData = `${publicBase}/ticket.html?id=${ticket.id}`;
      const qrPngBase64 = await QRCode.toDataURL(qrData);

      return res.json({
        ok: true,
        ticket: {
          id: ticket.id,
          orgId: ticket.org_id,
          number: ticket.number,
          status: ticket.status,
          createdAt: ticket.created_at,
          remaining,
          etaMinutes,
          qrData,
          qrPngBase64,
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

// --- API: ticket status ---
// GET /api/ticket/:id
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
    const remaining = Math.max(0, ticket.number - currentNumber);
    const etaMinutes = remaining * 5;

    res.json({
      ok: true,
      ticket: {
        id: ticket.id,
        orgId: ticket.org_id,
        number: ticket.number,
        status: ticket.status,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
        currentNumber,
        remaining,
        etaMinutes,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- (ixtiyoriy) Admin: navbatni oldinga surish ---
// POST /api/admin/next  body: { orgId }
app.post("/api/admin/next", async (req, res) => {
  try {
    const { orgId } = req.body || {};
    if (!orgId) return res.status(400).json({ ok: false, error: "orgId kerak" });

    const r = await pool.query(
      `UPDATE org_state
       SET current_number = current_number + 1, updated_at=now()
       WHERE org_id=$1
       RETURNING current_number`,
      [orgId]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "org_state topilmadi" });

    res.json({ ok: true, currentNumber: r.rows[0].current_number });
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
