const path = require("path");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// 1 odamga o‘rtacha necha minut ketadi (ETA shundan hisoblanadi)
const AVG_MIN_PER_PERSON = Number(process.env.AVG_MIN_PER_PERSON || 5);

// DB fayl (sizda navbatuz.db bor)
const DB_PATH = path.join(__dirname, "navbatuz.db");

// --- MIDDLEWARE
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static: public papka
app.use(express.static(path.join(__dirname, "public")));

// --- DB INIT
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'WAITING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // bitta "current" jadval - hozirgi navbat raqami
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(
    `INSERT OR IGNORE INTO meta (key, value) VALUES ('current_serving', '0')`
  );
});

// --- HELPERS
function makeTicketNumber(n) {
  return `N-${String(n).padStart(5, "0")}`;
}

function getCurrentServing() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT value FROM meta WHERE key='current_serving'`,
      (err, row) => {
        if (err) return reject(err);
        resolve(Number(row?.value || 0));
      }
    );
  });
}

function setCurrentServing(val) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE meta SET value=? WHERE key='current_serving'`,
      [String(val)],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function getLastTicketId() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT MAX(id) as maxId FROM queue`, (err, row) => {
      if (err) return reject(err);
      resolve(Number(row?.maxId || 0));
    });
  });
}

function countWaitingBefore(ticketId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as cnt FROM queue
       WHERE status='WAITING' AND id < ?`,
      [ticketId],
      (err, row) => {
        if (err) return reject(err);
        resolve(Number(row?.cnt || 0));
      }
    );
  });
}

function getTicketRow(ticket) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM queue WHERE ticket=?`, [ticket], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function calcEta(position) {
  // position = 1 bo‘lsa 0 min
  return Math.max(0, (Number(position) - 1) * AVG_MIN_PER_PERSON);
}

// --- API

// STATUS: ticket bo‘yicha holat
// GET /api/status?ticket=N-00001
app.get("/api/status", async (req, res) => {
  try {
    const { ticket } = req.query;
    if (!ticket) {
      return res.status(400).json({ ok: false, error: "ticket required" });
    }

    const row = await getTicketRow(ticket);
    if (!row) {
      return res.status(404).json({ ok: false, error: "ticket not found" });
    }

    if (row.status !== "WAITING") {
      return res.json({
        ok: true,
        ticket: row.ticket,
        status: row.status,
        position: 0,
        eta: 0,
      });
    }

    const before = await countWaitingBefore(row.id);
    const position = before + 1;
    const eta = calcEta(position);

    return res.json({
      ok: true,
      ticket: row.ticket,
      status: "WAITING",
      position,
      eta,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// TAKE: yangi navbat olish
// POST /api/take
app.post("/api/take", async (req, res) => {
  try {
    const lastId = await getLastTicketId();
    const newId = lastId + 1;
    const ticket = makeTicketNumber(newId);

    db.run(
      `INSERT INTO queue (ticket, status) VALUES (?, 'WAITING')`,
      [ticket],
      async (err) => {
        if (err) {
          return res
            .status(500)
            .json({ ok: false, error: String(err.message || err) });
        }

        // yangi ticket uchun position/eta
        const row = await getTicketRow(ticket);
        const before = await countWaitingBefore(row.id);
        const position = before + 1;
        const eta = calcEta(position);

        return res.json({
          ok: true,
          ticket,
          status: "WAITING",
          position,
          eta,
        });
      }
    );
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// NEXT: navbatni oldinga surish (admin uchun)
// POST /api/next
app.post("/api/next", async (req, res) => {
  try {
    // current_serving +1
    const current = await getCurrentServing();
    const next = current + 1;
    await setCurrentServing(next);

    // eng eski WAITING ni SERVED qilish
    db.get(
      `SELECT * FROM queue WHERE status='WAITING' ORDER BY id ASC LIMIT 1`,
      (err, row) => {
        if (err) {
          return res
            .status(500)
            .json({ ok: false, error: String(err.message || err) });
        }

        if (!row) {
          return res.json({
            ok: true,
            message: "No waiting tickets",
            current_serving: next,
          });
        }

        db.run(
          `UPDATE queue SET status='SERVED' WHERE id=?`,
          [row.id],
          (err2) => {
            if (err2) {
              return res.status(500).json({
                ok: false,
                error: String(err2.message || err2),
              });
            }
            return res.json({
              ok: true,
              served: row.ticket,
              current_serving: next,
            });
          }
        );
      }
    );
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Default route: public/index.html ni beradi
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
  console.log("Mini App server running: http://localhost:" + PORT);
});
