import express from "express";
import cors from "cors";
import pg from "pg";
import { initDb } from "./initDb.js";
import { generateTicketCode, hashTicketCode } from "./tickets.js";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const SIGNUP_BONUS_DOS = parseInt(process.env.SIGNUP_BONUS_DOS || "50", 10);

// Timing
let roundSeconds = parseInt(process.env.ROUND_SECONDS || "300", 10);
let closeBetsAt = parseInt(process.env.CLOSE_BETS_AT || "30", 10);
let anchorMs = parseInt(process.env.ANCHOR_MS || String(Date.now()), 10);

// ====== DB ======
if (!DATABASE_URL) console.error("❌ DATABASE_URL manquant (Render env var).");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
});

// Init DB au démarrage
initDb().catch((e) => {
  console.error("❌ initDb error:", e);
  process.exit(1);
});

// ====== HELPERS ======
function requireAdmin(req, res, next) {
  const k = String(req.header("x-admin-key") || "");
  if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}
// ===========================
// Anti-fraude: Rate limit redeem
// ===========================
const redeemLimiter = new Map();
// clé = ip, valeur = { count, resetAtMs }

function getClientIp(req) {
  // Render/proxy: X-Forwarded-For peut contenir "ip, proxy, proxy"
  const xf = String(req.headers["x-forwarded-for"] || "");
  if (xf) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function redeemRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const windowMs = 60_000; // 1 minute
  const max = 5;

  const cur = redeemLimiter.get(ip);

  if (!cur || now > cur.resetAtMs) {
    redeemLimiter.set(ip, { count: 1, resetAtMs: now + windowMs });
    return next();
  }

  if (cur.count >= max) {
    const retryAfterSec = Math.ceil((cur.resetAtMs - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      error: "Too many attempts",
      retryAfterSec,
    });
  }

  cur.count += 1;
  redeemLimiter.set(ip, cur);
  next();
}

// Nettoyage mémoire (option pro)
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of redeemLimiter.entries()) {
    if (now > v.resetAtMs) redeemLimiter.delete(ip);
  }
}, 60_000);
// ====== ROUTES ======
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "ddj-api" });
});
// ====== ROUTES PUBLIC ======
// GET  /api/leaderboard
// GET /api/leaderboard?limit=20
app.get("/api/leaderboard", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 20)));

    const r = await pool.query(
      `SELECT id, username, balance_dos, status, created_at
       FROM players
       WHERE status = 'ACTIVE'
       ORDER BY balance_dos DESC, id ASC
       LIMIT $1`,
      [limit]
    );

    res.json({ ok: true, limit, rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// ====== ROUTES PLAYER ======
// GET /api/player/:playerId/ledger?limit=50
app.get("/api/player/:playerId/ledger", async (req, res) => {
  try {
    const playerId = Number(req.params.playerId);
    if (!playerId) return res.status(400).json({ error: "playerId invalide" });

    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));

    // Vérifie joueur
    const p = await pool.query(
      `SELECT id, username, balance_dos, status, created_at
       FROM players
       WHERE id = $1`,
      [playerId]
    );
    if (p.rowCount === 0) return res.status(404).json({ error: "player not found" });

    // Ledger
    const l = await pool.query(
      `SELECT id, type, amount, meta, created_at
       FROM dos_ledger
       WHERE player_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [playerId, limit]
    );

    res.json({ ok: true, player: p.rows[0], limit, ledger: l.rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// POST /api/player/signup
// POST /api/player/redeem
// GET /api/player/:playerId/ledger
app.get("/api/player/:playerId/ledger", async (req, res) => {
  try {
    const playerId = Number(req.params.playerId);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    if (!playerId) return res.status(400).json({ error: "playerId invalid" });

    const p = await pool.query(
      `SELECT id, username, balance_dos, status, created_at
       FROM players
       WHERE id = $1`,
      [playerId]
    );
    if (p.rowCount === 0) return res.status(404).json({ error: "player not found" });

    const led = await pool.query(
      `SELECT id, type, amount, meta, created_at
       FROM dos_ledger
       WHERE player_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [playerId, limit]
    );

    res.json({
  ok: true,
  player: p.rows[0],
  limit,
  count: led.rowCount,
  ledger: led.rows
});
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// ====== ROUTES ADMIN ======
// GET /api/admin/stats
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const playersTotal = await pool.query(`SELECT COUNT(*)::bigint AS n FROM players`);
    const playersActive = await pool.query(`SELECT COUNT(*)::bigint AS n FROM players WHERE status='ACTIVE'`);
    const playersSuspended = await pool.query(`SELECT COUNT(*)::bigint AS n FROM players WHERE status='SUSPENDED'`);

    const dosTotal = await pool.query(`SELECT COALESCE(SUM(balance_dos),0)::bigint AS n FROM players`);
    const ledgerCount = await pool.query(`SELECT COUNT(*)::bigint AS n FROM dos_ledger`);

    const redeemedCount = await pool.query(
      `SELECT COUNT(*)::bigint AS n
       FROM dos_ledger
       WHERE type='REDEEM'`
    );

    res.json({
      ok: true,
      players: {
        total: playersTotal.rows[0].n,
        active: playersActive.rows[0].n,
        suspended: playersSuspended.rows[0].n,
      },
      dos: {
        totalInPlayers: dosTotal.rows[0].n,
      },
      ledger: {
        totalRows: ledgerCount.rows[0].n,
        redeemRows: redeemedCount.rows[0].n,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// POST /api/admin/gift-codes
// GET  /api/admin/stats
// POST /api/admin/player/status

app.get("/api/admin/config", requireAdmin, (req, res) => {
  res.json({ roundSeconds, closeBetsAt, anchorMs, signupBonusDos: SIGNUP_BONUS_DOS });
});

app.put("/api/admin/config", requireAdmin, (req, res) => {
  const { roundSeconds: rs, closeBetsAt: cb, anchorMs: am } = req.body || {};
  if (Number.isFinite(rs)) roundSeconds = Math.max(30, Math.floor(rs));
  if (Number.isFinite(cb)) closeBetsAt = Math.max(1, Math.floor(cb));
  if (Number.isFinite(am)) anchorMs = Math.floor(am);
  res.json({ ok: true, config: { roundSeconds, closeBetsAt, anchorMs } });
});

// Signup joueur (bonus 50 DOS)
app.post("/api/player/signup", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    if (!username || username.length < 3) {
      return res.status(400).json({ error: "username invalide (min 3 caractères)" });
    }

    const created = await pool.query(
      `INSERT INTO players (username, balance_dos)
       VALUES ($1, $2)
       RETURNING id, username, balance_dos, created_at`,
      [username, SIGNUP_BONUS_DOS]
    );

    const player = created.rows[0];

    if (SIGNUP_BONUS_DOS > 0) {
      await pool.query(
        `INSERT INTO dos_ledger (player_id, type, amount, meta)
         VALUES ($1, 'BONUS_SIGNUP', $2, $3::jsonb)`,
        [player.id, SIGNUP_BONUS_DOS, JSON.stringify({ source: "signup" })]
      );
    }

    res.json({ ok: true, player });
  } catch (e) {
    if (String(e?.message || "").includes("duplicate key")) {
      return res.status(409).json({ error: "username déjà utilisé" });
    }
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ADMIN: générer des codes cadeaux (12 chars)
app.post("/api/admin/gift-codes", requireAdmin, async (req, res) => {
  try {
    const count = Math.max(1, Math.min(200, Number(req.body?.count || 1)));
    const valueDos = Math.max(1, Number(req.body?.valueDos || 50));
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;

    const codes = [];

    for (let i = 0; i < count; i++) {
      // anti-collision : on retente si conflit
      for (let t = 0; t < 5; t++) {
        const code = generateTicketCode(12);
        const codeHash = hashTicketCode(code);

        try {
          await pool.query(
            `INSERT INTO gift_codes (code_hash, value_dos, expires_at)
             VALUES ($1, $2, $3)`,
            [codeHash, valueDos, expiresAt ? expiresAt.toISOString() : null]
          );
          codes.push(code);
          break;
        } catch (e) {
          if (String(e?.message || "").includes("duplicate")) continue;
          throw e;
        }
      }
    }

    res.json({ ok: true, count: codes.length, valueDos, expiresAt, codes });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// PLAYER: redeem un code cadeau
app.post("/api/player/redeem", redeemRateLimit, async (req, res) => {
  const playerId = Number(req.body?.playerId);
  const code = String(req.body?.code || "").trim().toUpperCase();

  if (!playerId) return res.status(400).json({ error: "playerId requis" });
  if (!/^[A-Z0-9]{12}$/.test(code)) return res.status(400).json({ error: "code invalide (12)" });

  const client = await pool.connect();
// ====== PLAYER STATUS CHECK ======
    const p = await client.query(
      "SELECT status FROM players WHERE id = $1",
      [playerId]
    );

    if (p.rowCount === 0) {
      client.release();
      return res.status(404).json({ error: "player not found" });
    }

    if (p.rows[0].status !== "ACTIVE") {
      client.release();
      return res.status(403).json({ error: "player not active", status: p.rows[0].status });
    }
    // ====== END PLAYER STATUS CHECK ======
  try {
    await client.query("BEGIN");

    const codeHash = hashTicketCode(code);

    const c = await client.query(
      `SELECT id, value_dos, status, expires_at
       FROM gift_codes
       WHERE code_hash=$1
       FOR UPDATE`,
      [codeHash]
    );

    if (c.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "code inexistant" });
    }

    const row = c.rows[0];

    if (row.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "code déjà utilisé/désactivé" });
    }

    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "code expiré" });
    }

    const up = await client.query(
      `UPDATE players
       SET balance_dos = balance_dos + $2
       WHERE id=$1
       RETURNING id, username, balance_dos`,
      [playerId, row.value_dos]
    );

    if (up.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "player introuvable" });
    }

    await client.query(
      `UPDATE gift_codes
       SET status='REDEEMED', redeemed_by=$1, redeemed_at=NOW()
       WHERE id=$2`,
      [playerId, row.id]
    );

    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1, 'REDEEM', $2, $3::jsonb)`,
      [playerId, row.value_dos, JSON.stringify({ giftCodeId: row.id })]
    );

    await client.query("COMMIT");
    res.json({ ok: true, added_dos: String(row.value_dos), player: up.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});
// ===========================
// ADMIN DASHBOARD (DOS KPIs)
// ===========================
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const [playersCount, balancesSum, distributed, redeemed, codes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::bigint AS players_count FROM players`),
      pool.query(`SELECT COALESCE(SUM(balance_dos),0)::bigint AS dos_in_players FROM players`),
      pool.query(`
        SELECT COALESCE(SUM(amount),0)::bigint AS dos_distributed
        FROM dos_ledger
        WHERE type IN ('BONUS_SIGNUP','REDEEM')
      `),
      pool.query(`
        SELECT COALESCE(SUM(value_dos),0)::bigint AS dos_redeemed
        FROM gift_codes
        WHERE status='REDEEMED'
      `),
      pool.query(`
        SELECT
          COUNT(*)::bigint AS total_codes,
          COALESCE(SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END),0)::bigint AS active_codes,
          COALESCE(SUM(CASE WHEN status='REDEEMED' THEN 1 ELSE 0 END),0)::bigint AS redeemed_codes
        FROM gift_codes
      `),
    ]);

    res.json({
      ok: true,
      stats: {
        playersCount: playersCount.rows[0].players_count,
        dosInPlayers: balancesSum.rows[0].dos_in_players,
        dosDistributed: distributed.rows[0].dos_distributed,
        dosRedeemed: redeemed.rows[0].dos_redeemed,
        codes: codes.rows[0],
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ===========================
// ADMIN: LISTE JOUEURS
// - pagination + recherche
// ===========================
app.get("/api/admin/players", requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const q = String(req.query.q || "").trim();

    const params = [];
    let where = "";
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE username ILIKE $${params.length}`;
    }

    params.push(limit);
    params.push(offset);

    const sql = `
      SELECT id, username, balance_dos, created_at
      FROM players
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const r = await pool.query(sql, params);

    // total (pour pagination)
    const total = await pool.query(
      `SELECT COUNT(*)::bigint AS total FROM players ${where}`,
      q ? [`%${q}%`] : []
    );

    res.json({
      ok: true,
      total: total.rows[0].total,
      limit,
      offset,
      players: r.rows,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// ===========================
// ADMIN: ACTIONS JOUEURS
// ===========================

// Helper: fetch player (admin)
async function getPlayerById(id) {
  const r = await pool.query(
    `SELECT id, username, balance_dos, status, created_at
     FROM players WHERE id=$1`,
    [id]
  );
  return r.rowCount ? r.rows[0] : null;
}

// 1) Ajouter des DOS
app.post("/api/admin/players/:id/add-dos", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || "").trim();

  if (!id) return res.status(400).json({ error: "id invalide" });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "amount > 0 requis" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(`SELECT id, balance_dos, status FROM players WHERE id=$1 FOR UPDATE`, [id]);
    if (p.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "joueur introuvable" });
    }
    if (p.rows[0].status === "SUSPENDED") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "joueur suspendu" });
    }

    const up = await client.query(
      `UPDATE players SET balance_dos = balance_dos + $2 WHERE id=$1
       RETURNING id, username, balance_dos, status, created_at`,
      [id, amount]
    );

    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1, 'ADMIN_ADD', $2, $3::jsonb)`,
      [id, amount, JSON.stringify({ note })]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: up.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// 2) Fixer le solde (set)
app.post("/api/admin/players/:id/set-dos", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const balance = Number(req.body?.balance);
  const note = String(req.body?.note || "").trim();

  if (!id) return res.status(400).json({ error: "id invalide" });
  if (!Number.isFinite(balance) || balance < 0) return res.status(400).json({ error: "balance >= 0 requis" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(`SELECT id, balance_dos FROM players WHERE id=$1 FOR UPDATE`, [id]);
    if (p.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "joueur introuvable" });
    }

    const oldBal = Number(p.rows[0].balance_dos);
    const delta = balance - oldBal;

    const up = await client.query(
      `UPDATE players SET balance_dos=$2 WHERE id=$1
       RETURNING id, username, balance_dos, status, created_at`,
      [id, balance]
    );

    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1, 'ADMIN_SET', $2, $3::jsonb)`,
      [id, delta, JSON.stringify({ note, oldBal, newBal: balance })]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: up.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// 3) Suspendre / Réactiver
app.post("/api/admin/players/:id/status", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "").toUpperCase();

  if (!id) return res.status(400).json({ error: "id invalide" });
  if (!["ACTIVE", "SUSPENDED"].includes(status)) {
    return res.status(400).json({ error: "status doit être ACTIVE ou SUSPENDED" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(`SELECT id, status FROM players WHERE id=$1 FOR UPDATE`, [id]);
    if (p.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "joueur introuvable" });
    }

    const up = await client.query(
      `UPDATE players SET status=$2 WHERE id=$1
       RETURNING id, username, balance_dos, status, created_at`,
      [id, status]
    );

    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1, 'ADMIN_STATUS', 0, $2::jsonb)`,
      [id, JSON.stringify({ status })]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: up.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});
// ===========================
// ADMIN: ACTIONS JOUEURS
// ===========================

// 1) Ajouter des DOS à un joueur
app.post("/api/admin/players/:id/add-dos", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || "").trim();

  if (!id) return res.status(400).json({ error: "id invalide" });
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "amount > 0 requis" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(
      `SELECT id, status FROM players WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (p.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "joueur introuvable" });
    }
    if (p.rows[0].status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "player not active", status: p.rows[0].status });
    }

    const up = await client.query(
      `UPDATE players
       SET balance_dos = balance_dos + $2
       WHERE id=$1
       RETURNING id, username, balance_dos, status, created_at`,
      [id, amount]
    );

    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1, 'ADMIN_ADD', $2, $3::jsonb)`,
      [id, amount, JSON.stringify({ note })]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: up.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// 2) Fixer le solde (set)
app.post("/api/admin/players/:id/set-dos", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const balance = Number(req.body?.balance);
  const note = String(req.body?.note || "").trim();

  if (!id) return res.status(400).json({ error: "id invalide" });
  if (!Number.isFinite(balance) || balance < 0) {
    return res.status(400).json({ error: "balance >= 0 requis" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(
      `SELECT id, balance_dos FROM players WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (p.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "joueur introuvable" });
    }

    const oldBal = Number(p.rows[0].balance_dos);
    const delta = balance - oldBal;

    const up = await client.query(
      `UPDATE players
       SET balance_dos=$2
       WHERE id=$1
       RETURNING id, username, balance_dos, status, created_at`,
      [id, balance]
    );

    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1, 'ADMIN_SET', $2, $3::jsonb)`,
      [id, delta, JSON.stringify({ note, oldBal, newBal: balance })]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: up.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// 3) Suspendre / Réactiver (status)
app.post("/api/admin/players/:id/status", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "").toUpperCase();

  if (!id) return res.status(400).json({ error: "id invalide" });
  if (!["ACTIVE", "SUSPENDED"].includes(status)) {
    return res.status(400).json({ error: "status doit être ACTIVE ou SUSPENDED" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(
      `SELECT id, status FROM players WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (p.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "joueur introuvable" });
    }

    const up = await client.query(
      `UPDATE players
       SET status=$2
       WHERE id=$1
       RETURNING id, username, balance_dos, status, created_at`,
      [id, status]
    );

    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1, 'ADMIN_STATUS', 0, $2::jsonb)`,
      [id, JSON.stringify({ status })]
    );

    await client.query("COMMIT");
    res.json({ ok: true, player: up.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});
// ===================== ADMIN: PLAYER STATUS =====================
// POST /api/admin/player/status
// body: { "playerId": 1, "status": "ACTIVE" | "SUSPENDED" }
app.post("/api/admin/player/status", requireAdmin, async (req, res) => {
  try {
    const playerId = Number(req.body?.playerId);
    const status = String(req.body?.status || "").trim().toUpperCase();

    if (!playerId) {
      return res.status(400).json({ error: "playerId requis" });
    }

    const ALLOWED = new Set(["ACTIVE", "SUSPENDED"]);
    if (!ALLOWED.has(status)) {
      return res.status(400).json({
        error: "status invalide",
        allowed: Array.from(ALLOWED),
      });
    }

    const up = await pool.query(
      `UPDATE players
       SET status = $1
       WHERE id = $2
       RETURNING id, username, balance_dos, status, created_at`,
      [status, playerId]
    );

    if (up.rowCount === 0) {
      return res.status(404).json({ error: "player not found" });
    }

    return res.json({ ok: true, player: up.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
// ====== START ======
app.listen(PORT, () => console.log(`✅ ddj-api listening on ${PORT}`));