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

// ====== TIMING (single source of truth) ======
let roundSeconds = parseInt(process.env.ROUND_SECONDS || "300", 10); // durée d'un round
let closeBetsAt = parseInt(process.env.CLOSE_BETS_AT || "30", 10); // fermeture X sec AVANT fin
let anchorMs = parseInt(
  process.env.ANCHOR_MS || String(Date.UTC(2025, 0, 1, 0, 0, 0)),
  10
);

// Guardrails (anti-bug)
if (!Number.isFinite(roundSeconds) || roundSeconds < 30) roundSeconds = 300;
if (!Number.isFinite(closeBetsAt) || closeBetsAt < 1) closeBetsAt = 30;
if (closeBetsAt >= roundSeconds) closeBetsAt = Math.max(1, roundSeconds - 1);
if (!Number.isFinite(anchorMs)) anchorMs = Date.now();

/**
 * Calcule l’état du round à un instant donné.
 * - roundSeconds = durée du round
 * - closeBetsAt  = fermeture des mises X secondes AVANT la fin
 */
function getRoundInfo(nowMs = Date.now()) {
  const roundMs = roundSeconds * 1000;

  const roundId = Math.floor((nowMs - anchorMs) / roundMs);
  const roundStartMs = anchorMs + roundId * roundMs;
  const roundEndMs = roundStartMs + roundMs;

  // fermeture des mises = X secondes AVANT la fin
  const closeAtMs = roundEndMs - closeBetsAt * 1000;

  const betsOpen = nowMs < closeAtMs;
  const secondsLeft = Math.max(0, Math.ceil((roundEndMs - nowMs) / 1000));
  const secondsToClose = Math.max(0, Math.ceil((closeAtMs - nowMs) / 1000));

  return {
    roundId,
    roundStartMs,
    roundEndMs,
    closeAtMs,
    betsOpen,
    secondsLeft,
    secondsToClose,
  };
}

// ====== HELPERS ======
function requireAdmin(req, res, next) {
  const k = String(req.header("x-admin-key") || "");
  if (!ADMIN_KEY || k !== ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });
  next();
}

// ===========================
// Anti-fraude: Rate limit redeem
// ===========================
const redeemLimiter = new Map();

function getClientIp(req) {
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
    return res.status(429).json({ error: "Too many attempts", retryAfterSec });
  }

  cur.count += 1;
  redeemLimiter.set(ip, cur);
  next();
}

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

// PUBLIC: current round (time engine)
app.get("/api/round", (req, res) => {
  const nowMs = Date.now();
  const round = getRoundInfo(nowMs);

  res.json({
    ok: true,
    nowMs,
    roundSeconds,
    closeBetsAt,
    anchorMs,
    round,
  });
});

// PUBLIC: leaderboard
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

// PLAYER: ledger
app.get("/api/player/:playerId/ledger", async (req, res) => {
  try {
    const playerId = Number(req.params.playerId);
    if (!playerId) return res.status(400).json({ error: "playerId invalide" });

    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));

    const p = await pool.query(
      `SELECT id, username, balance_dos, status, created_at
       FROM players
       WHERE id = $1`,
      [playerId]
    );
    if (p.rowCount === 0)
      return res.status(404).json({ error: "player not found" });

    const l = await pool.query(
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
      count: l.rowCount,
      ledger: l.rows,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// PLAYER: signup
app.post("/api/player/signup", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    if (!username || username.length < 3) {
      return res
        .status(400)
        .json({ error: "username invalide (min 3 caractères)" });
    }

    const created = await pool.query(
      `INSERT INTO players (username, balance_dos)
       VALUES ($1, $2)
       RETURNING id, username, balance_dos, status, created_at`,
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
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// PLAYER: redeem code
app.post("/api/player/redeem", redeemRateLimit, async (req, res) => {
  const playerId = Number(req.body?.playerId);
  const code = String(req.body?.code || "").trim().toUpperCase();

  if (!playerId) return res.status(400).json({ error: "playerId requis" });
  if (!/^[A-Z0-9]{12}$/.test(code))
    return res.status(400).json({ error: "code invalide (12)" });

  const client = await pool.connect();
  try {
    // status check
    const p = await client.query("SELECT status FROM players WHERE id=$1", [
      playerId,
    ]);
    if (p.rowCount === 0) return res.status(404).json({ error: "player not found" });
    if (p.rows[0].status !== "ACTIVE")
      return res
        .status(403)
        .json({ error: "player not active", status: p.rows[0].status });

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
       RETURNING id, username, balance_dos, status, created_at`,
      [playerId, row.value_dos]
    );

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
    try {
      await client.query("ROLLBACK");
    } catch {}
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// PLAYER: place bet (uses DOS)  ✅ utilise UNIQUEMENT getRoundInfo()
// PLAYER: place a bet (uses DOS)
// - unlimited bets per round (as long as balance allows)
// - timing source of truth = getRoundInfo()
app.post("/api/bet", async (req, res) => {
  const nowMs = Date.now();
  const round = getRoundInfo(nowMs);
  
  // Timing: source de vérité = getRoundInfo()
  if (!round.betsOpen) {
    return res.status(409).json({
      error: "bets closed",
      roundId: round.roundId,
      secToClose: round.secondsToClose,
    });
  }
  
  const playerId = Number(req.body?.playerId);
  const amount = Number(req.body?.amount);
  
  if (!Number.isFinite(playerId) || playerId <= 0) {
    return res.status(400).json({ error: "playerId invalid" });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "amount invalid" });
  }
  
  // --- Nouveau format: combinaison nums+chance ---
  const numsRaw = Array.isArray(req.body?.nums) ? req.body.nums : null;
  const chanceRaw = req.body?.chance;
  
  // (compat) Ancien format "choice" si besoin (optionnel)
  const choice = String(req.body?.choice || "").trim().toUpperCase();
  
  let nums = null;
  let chance = null;
  let choiceKey = null;
  
  if (numsRaw) {
    const parsed = numsRaw.map(Number).filter(Number.isFinite);
    const unique = [...new Set(parsed)];
    
    if (unique.length !== 4) {
      return res.status(400).json({ error: "nums must contain 4 distinct numbers" });
    }
    for (const n of unique) {
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return res.status(400).json({ error: "nums must be integers 1..20" });
      }
    }
    
    chance = Number(chanceRaw);
    if (!Number.isInteger(chance) || chance < 1 || chance > 5) {
      return res.status(400).json({ error: "chance must be integer 1..5" });
    }
    
    unique.sort((a, b) => a - b);
    nums = unique;
    choiceKey = `${nums.join("-")}#${chance}`; // juste pour debug/lecture (si tu veux)
  } else {
    // si tu veux garder l'ancien mode A/B temporairement
    if (!choice) return res.status(400).json({ error: "nums+chance required (or choice)" });
    if (!["A", "B"].includes(choice)) return res.status(400).json({ error: "choice must be A or B" });
    choiceKey = choice;
  }
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Lock joueur
    const p = await client.query(
      `SELECT id, balance_dos, status
       FROM players
       WHERE id=$1
       FOR UPDATE`,
      [playerId]
    );
    
    if (p.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "player not found" });
    }
    if (p.rows[0].status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "player not active", status: p.rows[0].status });
    }
    
    const balanceBefore = Number(p.rows[0].balance_dos);
    const cost = Math.floor(amount);
    
    if (balanceBefore < cost) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "insufficient balance", balance: balanceBefore, cost });
    }
    
    // ✅ Insert bet (combinaison) — illimité, aucune règle "already bet"
    const b = await client.query(
      `INSERT INTO bets (player_id, round_id, nums, chance, choice, amount, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       RETURNING id, player_id, round_id, nums, chance, choice, amount, created_at`,
      [playerId, round.roundId, nums, chance, choiceKey, cost]
    );
    
    // Débit solde
    const balanceAfter = balanceBefore - cost;
    await client.query(`UPDATE players SET balance_dos=$1 WHERE id=$2`, [balanceAfter, playerId]);
    
    // Ledger
    await client.query(
      `INSERT INTO dos_ledger (player_id, type, amount, meta)
       VALUES ($1,'BET',$2,$3::jsonb)`,
      [
        playerId,
        -cost,
        JSON.stringify({
          betId: String(b.rows[0].id),
          roundId: String(round.roundId),
          nums,
          chance,
          choice: choiceKey,
        }),
      ]
    );
    
    await client.query("COMMIT");
    
    return res.json({
      ok: true,
      roundId: round.roundId,
      bet: b.rows[0],
      balanceBefore,
      balanceAfter,
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("❌ /api/bet ERROR:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  } finally {
    client.release();
  }
});
// ====== ADMIN ======
app.get("/api/admin/config", requireAdmin, (req, res) => {
  res.json({ roundSeconds, closeBetsAt, anchorMs, signupBonusDos: SIGNUP_BONUS_DOS });
});

app.put("/api/admin/config", requireAdmin, (req, res) => {
  // Coercition robuste (accepte number ET string)
  const rs = Number(req.body?.roundSeconds);
  const cb = Number(req.body?.closeBetsAt);
  const am = Number(req.body?.anchorMs);

  if (Number.isFinite(rs)) roundSeconds = Math.max(30, Math.floor(rs));
  if (Number.isFinite(cb)) closeBetsAt  = Math.max(1, Math.floor(cb));
  if (Number.isFinite(am)) anchorMs     = Math.floor(am);

  // garde-fou: closeBetsAt doit être < roundSeconds
  if (closeBetsAt >= roundSeconds) closeBetsAt = Math.max(1, roundSeconds - 1);

  return res.json({ ok: true, config: { roundSeconds, closeBetsAt, anchorMs } });
});

// ADMIN: générer des codes cadeaux
app.post("/api/admin/gift-codes", requireAdmin, async (req, res) => {
  try {
    const count = Math.max(1, Math.min(200, Number(req.body?.count || 1)));
    const valueDos = Math.max(1, Number(req.body?.valueDos || 50));
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;

    const codes = [];

    for (let i = 0; i < count; i++) {
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

// ADMIN: stats (simple)
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const playersTotal = await pool.query(`SELECT COUNT(*)::bigint AS n FROM players`);
    const playersActive = await pool.query(
      `SELECT COUNT(*)::bigint AS n FROM players WHERE status='ACTIVE'`
    );
    const playersSuspended = await pool.query(
      `SELECT COUNT(*)::bigint AS n FROM players WHERE status='SUSPENDED'`
    );

    const dosTotal = await pool.query(
      `SELECT COALESCE(SUM(balance_dos),0)::bigint AS n FROM players`
    );

    res.json({
      ok: true,
      players: {
        total: playersTotal.rows[0].n,
        active: playersActive.rows[0].n,
        suspended: playersSuspended.rows[0].n,
      },
      dos: { totalInPlayers: dosTotal.rows[0].n },
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== START ======
app.listen(PORT, () => console.log(`✅ ddj-api listening on ${PORT}`));