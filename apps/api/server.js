// server.js
import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { Pool } from "pg";

import { pool } from "./db.js";
import { initDb } from "./initDb.js";
import { generateTicketCode, hashTicketCode } from "./tickets.js";

const app = express();
app.get("/health", (req, res) => res.json({ status: "ok", service: "ddj-api", ts: new Date().toISOString() }));
app.get("/api/v1/health", (req, res) => res.json({ status: "ok", service: "ddj-api", ts: new Date().toISOString() }));
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const SIGNUP_BONUS_DOS = parseInt(process.env.SIGNUP_BONUS_DOS || "50", 10);
const SECRET_SEED = process.env.SECRET_SEED || ""; // pour RNG déterministe

// ====== TIMING (UNE SEULE FOIS) ======
let roundSeconds = parseInt(process.env.ROUND_SECONDS || "300", 10); // durée d’un round en secondes
let closeBetsAt = parseInt(process.env.CLOSE_BETS_AT || "30", 10); // fermeture X secondes AVANT la fin
let anchorMs = parseInt(process.env.ANCHOR_MS || String(Date.now()), 10);

// ----- Timing guardrails (anti-bug) -----
if (!Number.isFinite(roundSeconds) || roundSeconds < 30) roundSeconds = 300;
if (!Number.isFinite(closeBetsAt) || closeBetsAt < 1) closeBetsAt = 30;
if (closeBetsAt >= roundSeconds) closeBetsAt = Math.max(1, roundSeconds - 1);
if (!Number.isFinite(anchorMs)) anchorMs = Date.now();

// ----- Round engine (single source of truth) -----
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

// pour /api/settle: recalculer roundStart/End depuis roundId
function getRoundById(roundId) {
  const roundMs = roundSeconds * 1000;
  const roundStartMs = anchorMs + roundId * roundMs;
  const roundEndMs = roundStartMs + roundMs;
  const closeAtMs = roundEndMs - closeBetsAt * 1000;
  return { roundId, roundStartMs, roundEndMs, closeAtMs };
}

// ====== DB (Pool local si besoin) ======
if (!DATABASE_URL) console.error("❌ DATABASE_URL manquant (Render env var).");

const pool2 = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
});

// ====== Helpers ======
function requireAdmin(req) {
  const k = req.header("x-admin-key") || "";
  if (!ADMIN_KEY || k !== ADMIN_KEY) return false;
  return true;
}

function hashSeed(...parts) {
  const h = crypto.createHash("sha256");
  h.update(SECRET_SEED || "dev-seed");
  for (const p of parts) h.update(String(p));
  return h.digest("hex");
}

function pickOutcomeForRound(roundId) {
  // RNG déterministe (même roundId => même outcome)
  // outcome = 4 numéros (1..20) + chance (1..5)
  const hex = hashSeed("round", roundId);
  // on génère une suite pseudo-aléatoire à partir du hash
  let idx = 0;
  const nextInt = (mod) => {
    const slice = hex.slice(idx, idx + 8);
    idx = (idx + 8) % hex.length;
    const n = parseInt(slice, 16);
    return n % mod;
  };

  const nums = new Set();
  while (nums.size < 4) nums.add(1 + nextInt(20));
  const main = Array.from(nums).sort((a, b) => a - b);
  const chance = 1 + nextInt(5);

  return { main, chance };
}

function normalizeNums(nums) {
  // unique + tri
  const s = new Set(nums.map((n) => Number(n)));
  const arr = Array.from(s).filter((n) => Number.isFinite(n));
  arr.sort((a, b) => a - b);
  return arr;
}

function choiceKey(nums, chance) {
  // ex: "1-7-12-20#3"
  return `${nums.join("-")}#${chance}`;
}

function countMatches(aNums, bNums) {
  const setB = new Set(bNums);
  let m = 0;
  for (const n of aNums) if (setB.has(n)) m++;
  return m;
}

function prizeCategory(matches, chanceOk) {
  // Tes catégories (avec ton ajout 1 juste + 1 chance)
  // Format "X+Y" (X matches, Y = 1 si chance ok)
  const c = chanceOk ? 1 : 0;

  if (matches >= 4 && c === 1) return "4+1";
  if (matches >= 4 && c === 0) return "4+0";
  if (matches === 3 && c === 1) return "3+1";
  if (matches === 3 && c === 0) return "3+0";
  if (matches === 2 && c === 1) return "2+1";
  if (matches === 2 && c === 0) return "2+0";
  if (matches === 1 && c === 1) return "1+1";
  return null;
}

// ====== Config gains (tes règles) ======
const WIN_POOL_PERCENT = 0.65; // 65% du total des mises du round
const CARRY_PERCENT = 0.10; // 10% report au prochain round
const ADMIN_PERCENT = 0.25; // 25% admin (solde admin)

// Répartition interne du "win pool" par catégories
// (tu peux ajuster, mais on garde une base cohérente)
const POT_SHARES = {
  "4+1": 0.35,
  "4+0": 0.15,
  "3+1": 0.18,
  "3+0": 0.10,
  "2+1": 0.10,
  "2+0": 0.07,
  "1+1": 0.05,
};

// ====== ROUTES ======
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ddj-api", api_version: "v1" });
});

// GET /api/round
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

// ====== PLAYER ======

// POST /api/player/signup { username }
app.post("/api/player/signup", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    if (!username) return res.status(400).json({ error: "username required" });

    const c = await pool.connect();
    try {
      await c.query("BEGIN");

      // insert player
      const r = await c.query(
        `INSERT INTO players (username, balance_dos)
         VALUES ($1, 0)
         ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
         RETURNING id, username, balance_dos, status, created_at`,
        [username]
      );

      const player = r.rows[0];

      // bonus signup
      if (SIGNUP_BONUS_DOS > 0) {
        await c.query(
          `UPDATE players SET balance_dos = balance_dos + $1 WHERE id = $2`,
          [SIGNUP_BONUS_DOS, player.id]
        );
        await c.query(
          `INSERT INTO dos_ledger (player_id, type, amount, meta)
           VALUES ($1, 'BONUS_SIGNUP', $2, $3::jsonb)`,
          [player.id, SIGNUP_BONUS_DOS, JSON.stringify({ source: "signup" })]
        );
      }

      const r2 = await c.query(
        `SELECT id, username, balance_dos, status, created_at
         FROM players WHERE id = $1`,
        [player.id]
      );

      await c.query("COMMIT");
      res.json({ ok: true, player: r2.rows[0] });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/player/redeem { playerId, code }
app.post("/api/player/redeem", async (req, res) => {
  try {
    const playerId = Number(req.body?.playerId);
    const code = String(req.body?.code || "").trim();
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    if (!code) return res.status(400).json({ error: "code required" });

    const codeHash = hashTicketCode(code);

    const c = await pool.connect();
    try {
      await c.query("BEGIN");

      // lock gift code
      const g = await c.query(
        `SELECT id, value_dos, status, expires_at
         FROM gift_codes
         WHERE code_hash = $1
         FOR UPDATE`,
        [codeHash]
      );
      if (g.rowCount === 0)
        return res.status(404).json({ error: "code not found" });

      const gc = g.rows[0];
      if (gc.status !== "ACTIVE")
        return res.status(409).json({ error: "code not active" });
      if (gc.expires_at && Date.now() > new Date(gc.expires_at).getTime())
        return res.status(409).json({ error: "code expired" });

      // credit player
      const p = await c.query(
        `SELECT id, balance_dos, status
         FROM players
         WHERE id = $1
         FOR UPDATE`,
        [playerId]
      );
      if (p.rowCount === 0)
        return res.status(404).json({ error: "player not found" });
      if (p.rows[0].status !== "ACTIVE")
        return res.status(403).json({ error: "player not active" });

      const balanceBefore = Number(p.rows[0].balance_dos);
      const value = Number(gc.value_dos);

      await c.query(
        `UPDATE players SET balance_dos = balance_dos + $1 WHERE id = $2`,
        [value, playerId]
      );

      await c.query(
        `UPDATE gift_codes
         SET status='REDEEMED', redeemed_by=$1, redeemed_at=NOW()
         WHERE id=$2`,
        [playerId, gc.id]
      );

      await c.query(
        `INSERT INTO dos_ledger (player_id, type, amount, meta)
         VALUES ($1, 'REDEEM', $2, $3::jsonb)`,
        [playerId, value, JSON.stringify({ giftCodeId: gc.id })]
      );

      const p2 = await c.query(
        `SELECT id, username, balance_dos, status, created_at
         FROM players WHERE id=$1`,
        [playerId]
      );

      await c.query("COMMIT");
      res.json({
        ok: true,
        player: p2.rows[0],
        balanceBefore,
        balanceAfter: Number(p2.rows[0].balance_dos),
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/player/:id/ledger?limit=10
app.get("/api/player/:id/ledger", async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 10)));

    const p = await pool.query(
      `SELECT id, username, balance_dos, status, created_at
       FROM players WHERE id=$1`,
      [playerId]
    );
    if (p.rowCount === 0)
      return res.status(404).json({ error: "player not found" });

    const r = await pool.query(
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
      ledger: r.rows,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== BET (mises illimitées par round, tant que solde OK) ======
// POST /api/bet { playerId, nums:[..], chance, amount }
app.post("/api/bet", async (req, res) => {
  try {
    const nowMs = Date.now();
    const round = getRoundInfo(nowMs);

    if (!round.betsOpen) {
      return res.status(409).json({
        error: "bets closed",
        roundId: round.roundId,
        secToClose: round.secondsToClose,
      });
    }

    const playerId = Number(req.body?.playerId);
    const amount = Number(req.body?.amount);
    const nums = Array.isArray(req.body?.nums) ? req.body.nums.map(Number) : [];
    const chance = Number(req.body?.chance);

    if (!Number.isFinite(playerId) || playerId <= 0)
      return res.status(400).json({ error: "playerId required" });
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: "amount invalid" });

    // validation nums 4..8 (ton UI montre max 8)
    const nn = normalizeNums(nums);
    if (nn.length < 4 || nn.length > 8)
      return res.status(400).json({ error: "nums length must be 4..8 unique" });
    if (nn.some((n) => n < 1 || n > 20))
      return res.status(400).json({ error: "nums must be 1..20" });

    // chance 1..5 (mais ta règle “min 1 max 3” côté UI, serveur accepte 1..5)
    if (!Number.isFinite(chance) || chance < 1 || chance > 5)
      return res.status(400).json({ error: "chance must be 1..5" });

    const choice = choiceKey(nn, chance);

    const c = await pool.connect();
    try {
      await c.query("BEGIN");

      // lock player
      const p = await c.query(
        `SELECT id, balance_dos, status
         FROM players
         WHERE id=$1
         FOR UPDATE`,
        [playerId]
      );
      if (p.rowCount === 0)
        return res.status(404).json({ error: "player not found" });
      if (p.rows[0].status !== "ACTIVE")
        return res.status(403).json({ error: "player not active" });

      const balanceBefore = Number(p.rows[0].balance_dos);
      if (balanceBefore < amount)
        return res.status(409).json({
          error: "insufficient balance",
          balance: balanceBefore,
        });

      // debit
      await c.query(
        `UPDATE players SET balance_dos = balance_dos - $1 WHERE id=$2`,
        [amount, playerId]
      );

      // insert bet (illimité, pas de blocage par round)
      const b = await c.query(
        `INSERT INTO bets (player_id, round_id, nums, chance, choice, amount)
         VALUES ($1, $2, $3::int[], $4, $5, $6)
         RETURNING id, player_id, round_id, nums, chance, choice, amount, created_at`,
        [playerId, round.roundId, nn, chance, choice, amount]
      );

      // ledger
      await c.query(
        `INSERT INTO dos_ledger (player_id, type, amount, meta)
         VALUES ($1, 'BET', $2, $3::jsonb)`,
        [
          playerId,
          -amount,
          JSON.stringify({ betId: b.rows[0].id, choice, roundId: round.roundId }),
        ]
      );

      const p2 = await c.query(
        `SELECT balance_dos FROM players WHERE id=$1`,
        [playerId]
      );

      await c.query("COMMIT");
      res.json({
        ok: true,
        roundId: round.roundId,
        bet: b.rows[0],
        balanceBefore,
        balanceAfter: Number(p2.rows[0].balance_dos),
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== ADMIN ======

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

// POST /api/admin/gift-codes { value, count=1, expiresAt=null }
app.post("/api/admin/gift-codes", async (req, res) => {
  try {
    if (!requireAdmin(req))
      return res.status(401).json({ error: "unauthorized" });

    const value = Number(req.body?.value);
    const count = Math.max(1, Math.min(100, Number(req.body?.count || 1)));
    const expiresAt = req.body?.expiresAt ? String(req.body.expiresAt) : null;

    if (!Number.isFinite(value) || value <= 0)
      return res.status(400).json({ error: "value invalid" });

    const codes = [];

    const c = await pool.connect();
    try {
      await c.query("BEGIN");

      for (let i = 0; i < count; i++) {
        const code = generateTicketCode(); // ex: DDJ-XXXX-XXXX
        const codeHash = hashTicketCode(code);

        const r = await c.query(
          `INSERT INTO gift_codes (code_hash, value_dos, expires_at)
           VALUES ($1, $2, $3)
           RETURNING id, value_dos, status, expires_at, created_at`,
          [codeHash, value, expiresAt]
        );

        codes.push({ code, ...r.rows[0] });
      }

      await c.query("COMMIT");
      res.json({ ok: true, count, codes });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/admin/config
app.get("/api/admin/config", (req, res) => {
  if (!requireAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  res.json({ ok: true, roundSeconds, closeBetsAt, anchorMs });
});

// PUT /api/admin/config { roundSeconds, closeBetsAt, anchorMs }
app.put("/api/admin/config", (req, res) => {
  if (!requireAdmin(req)) return res.status(401).json({ error: "unauthorized" });

  const rs = Number(req.body?.roundSeconds);
  const cb = Number(req.body?.closeBetsAt);
  const am = Number(req.body?.anchorMs);

  if (Number.isFinite(rs)) roundSeconds = rs;
  if (Number.isFinite(cb)) closeBetsAt = cb;
  if (Number.isFinite(am)) anchorMs = am;

  // guardrails
  if (!Number.isFinite(roundSeconds) || roundSeconds < 30) roundSeconds = 300;
  if (!Number.isFinite(closeBetsAt) || closeBetsAt < 1) closeBetsAt = 30;
  if (closeBetsAt >= roundSeconds) closeBetsAt = Math.max(1, roundSeconds - 1);
  if (!Number.isFinite(anchorMs)) anchorMs = Date.now();

  res.json({
    ok: true,
    roundSeconds,
    closeBetsAt,
    anchorMs,
  });
});

// ====== SETTLE ======
// POST /api/settle { roundId } (admin only)
app.post("/api/settle", async (req, res) => {
  try {
    if (!requireAdmin(req))
      return res.status(401).json({ error: "unauthorized" });

    const roundId = Number(req.body?.roundId);
    if (!Number.isFinite(roundId))
      return res.status(400).json({ error: "roundId required" });

    const round = getRoundById(roundId);

    const c = await pool.connect();
    try {
      await c.query("BEGIN");

      // anti double-settle
      const already = await c.query(
        `SELECT round_id, outcome, settled_at
         FROM round_results
         WHERE round_id=$1
         FOR UPDATE`,
        [roundId]
      );
      if (already.rowCount > 0) {
        await c.query("ROLLBACK");
        return res.status(409).json({
          error: "already settled",
          roundId,
          outcome: already.rows[0].outcome,
          settledAt: already.rows[0].settled_at,
        });
      }

      // outcome
      const outcome = pickOutcomeForRound(roundId);

      // total pot = somme des mises du round
      const potR = await c.query(
        `SELECT COALESCE(SUM(amount), 0) AS pot
         FROM bets
         WHERE round_id=$1`,
        [roundId]
      );
      const pot = Number(potR.rows[0].pot || 0);

      // split
      const winPool = Math.floor(pot * WIN_POOL_PERCENT);
      const carry = Math.floor(pot * CARRY_PERCENT);
      const adminTake = pot - winPool - carry; // le reste

      // store result
      await c.query(
        `INSERT INTO round_results (round_id, outcome)
         VALUES ($1, $2)`,
        [roundId, JSON.stringify(outcome)]
      );

      // collect bets
      const betsR = await c.query(
        `SELECT id, player_id, nums, chance, amount, settled, payout_dos
         FROM bets
         WHERE round_id=$1
         ORDER BY id ASC
         FOR UPDATE`,
        [roundId]
      );
      const bets = betsR.rows;

      // bucket winners by category
      const winnersByCat = {};
      for (const cat of Object.keys(POT_SHARES)) winnersByCat[cat] = [];

      for (const b of bets) {
        if (b.settled) continue;
        const nums = b.nums || [];
        const chanceOk = Number(b.chance) === Number(outcome.chance);
        const matches = countMatches(nums, outcome.main);
        const cat = prizeCategory(matches, chanceOk);
        if (cat) winnersByCat[cat].push(b);
      }

      // calc payouts per category
      const payouts = [];
      for (const [cat, winners] of Object.entries(winnersByCat)) {
        if (!winners.length) continue;

        const share = POT_SHARES[cat] || 0;
        const catPool = Math.floor(winPool * share);

        // distrib = proportionnel au montant des mises gagnantes (simple et robuste)
        const totalStake = winners.reduce((s, b) => s + Number(b.amount), 0) || 1;

        for (const b of winners) {
          const stake = Number(b.amount);
          const payout = Math.floor((catPool * stake) / totalStake);
          payouts.push({ betId: b.id, playerId: b.player_id, cat, payout });
        }
      }

      // apply payouts
      // agrégation par player
      const byPlayer = new Map();
      for (const p of payouts) {
        byPlayer.set(p.playerId, (byPlayer.get(p.playerId) || 0) + p.payout);
      }

      for (const [playerId, amount] of byPlayer.entries()) {
        if (amount <= 0) continue;

        // lock player + credit
        await c.query(
          `UPDATE players SET balance_dos = balance_dos + $1 WHERE id=$2`,
          [amount, playerId]
        );

        await c.query(
          `INSERT INTO dos_ledger (player_id, type, amount, meta)
           VALUES ($1, 'WIN', $2, $3::jsonb)`,
          [
            playerId,
            amount,
            JSON.stringify({ roundId, note: "payout by categories" }),
          ]
        );
      }

      // mark bets settled + payout_dos
      for (const b of bets) {
        const p = payouts.find((x) => x.betId === b.id);
        const payout = p ? p.payout : 0;
        await c.query(
          `UPDATE bets
           SET settled = TRUE, payout_dos = $1
           WHERE id=$2`,
          [payout, b.id]
        );
      }

      // carry over (on l’enregistre dans une table admin_balance ou ledger spécial)
      // Ici: on crédite un “admin player” virtuel via dos_ledger (player_id NULL)
      // => si tu veux un vrai compte admin, on le fera proprement.
      await c.query(
        `INSERT INTO admin_ledger (type, amount, meta)
         VALUES ('CARRY', $1, $2::jsonb)`,
        [carry, JSON.stringify({ roundId })]
      );
      await c.query(
        `INSERT INTO admin_ledger (type, amount, meta)
         VALUES ('ADMIN_TAKE', $1, $2::jsonb)`,
        [adminTake, JSON.stringify({ roundId })]
      );

      await c.query("COMMIT");

      res.json({
        ok: true,
        roundId,
        outcome,
        pot,
        winPool,
        carry,
        adminTake,
        winnersCount: payouts.filter((x) => x.payout > 0).length,
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== START ======
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`✅ ddj-api listening on :${PORT}`);
    });
  } catch (e) {
    console.error("❌ boot error:", e);
    process.exit(1);
  }
})();