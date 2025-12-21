import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// Bonus d'inscription (DOS)
const SIGNUP_BONUS_DOS = parseInt(process.env.SIGNUP_BONUS_DOS || "50", 10);

// Timing (en secondes) pour ton jeu (déjà existant chez toi)
let roundSeconds = parseInt(process.env.ROUND_SECONDS || "300", 10);
let closeBetsAt = parseInt(process.env.CLOSE_BETS_AT || "30", 10);
let anchorMs = parseInt(process.env.ANCHOR_MS || String(Date.now()), 10);

// ====== DB ======
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL manquant (Render env var).");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function initDb() {
  // Tables simples : players + ledger (journal des mouvements DOS)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      balance_dos BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dos_ledger (
      id BIGSERIAL PRIMARY KEY,
      player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- BONUS_SIGNUP, WIN, PURCHASE, BET, ADJUST...
      amount BIGINT NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("✅ DB ready");
}

initDb().catch((e) => console.error("DB init error:", e));

// ====== HELPERS ======
function requireAdmin(req, res, next) {
  const k = req.headers["x-admin-key"];
  if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}

// ====== ROUTES ======
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "ddj-api" });
});

app.get("/api/admin/config", requireAdmin, (req, res) => {
  res.json({
    roundSeconds,
    closeBetsAt,
    anchorMs,
    signupBonusDos: SIGNUP_BONUS_DOS,
  });
});

app.put("/api/admin/config", requireAdmin, (req, res) => {
  const { roundSeconds: rs, closeBetsAt: cb, anchorMs: am } = req.body || {};

  if (Number.isFinite(rs)) roundSeconds = Math.max(30, Math.floor(rs));
  if (Number.isFinite(cb)) closeBetsAt = Math.max(1, Math.floor(cb));
  if (Number.isFinite(am)) anchorMs = Math.floor(am);

  res.json({ ok: true, config: { roundSeconds, closeBetsAt, anchorMs } });
});

// ✅ ICI : signup joueur
app.post("/api/player/signup", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();

    if (!username || username.length < 3) {
      return res.status(400).json({ error: "username invalide (min 3 caractères)" });
    }

    // Crée le joueur
    const created = await pool.query(
      `INSERT INTO players (username, balance_dos)
       VALUES ($1, $2)
       RETURNING id, username, balance_dos, created_at`,
      [username, SIGNUP_BONUS_DOS]
    );

    const player = created.rows[0];

    // Enregistre le bonus dans le ledger
    if (SIGNUP_BONUS_DOS > 0) {
      await pool.query(
        `INSERT INTO dos_ledger (player_id, type, amount, meta)
         VALUES ($1, 'BONUS_SIGNUP', $2, $3)`,
        [player.id, SIGNUP_BONUS_DOS, JSON.stringify({ source: "signup" })]
      );
    }

    res.json({ ok: true, player });
  } catch (e) {
    // username déjà pris
    if (String(e?.message || "").includes("duplicate key")) {
      return res.status(409).json({ error: "username déjà utilisé" });
    }
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ====== START ======
app.listen(PORT, () => console.log(`✅ ddj-api listening on ${PORT}`));