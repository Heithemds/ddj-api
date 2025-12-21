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

// ====== ROUTES ======
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "ddj-api" });
});

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
app.post("/api/player/redeem", async (req, res) => {
  const playerId = Number(req.body?.playerId);
  const code = String(req.body?.code || "").trim().toUpperCase();

  if (!playerId) return res.status(400).json({ error: "playerId requis" });
  if (!/^[A-Z0-9]{12}$/.test(code)) return res.status(400).json({ error: "code invalide (12)" });

  const client = await pool.connect();
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
// ====== START ======
app.listen(PORT, () => console.log(`✅ ddj-api listening on ${PORT}`));