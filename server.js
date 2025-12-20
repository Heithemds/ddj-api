import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// --------------------
// Helpers / validation
// --------------------
function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseIsoToMs(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// --------------------
// Config (env + runtime overrides)
// --------------------
const ENV_DEFAULTS = {
  ROUND_SECONDS: clamp(toInt(process.env.ROUND_SECONDS, 300), 10, 86400),
  CLOSE_BETS_AT: clamp(toInt(process.env.CLOSE_BETS_AT, 30), 1, 3600),
  ANCHOR_MS: toInt(process.env.ANCHOR_MS, Date.UTC(2025, 0, 1, 0, 0, 0)),
};

// runtime overrides (⚠️ non persistants sur Render Free si redémarrage)
let RUNTIME = {
  roundSeconds: ENV_DEFAULTS.ROUND_SECONDS,
  closeBetsAt: ENV_DEFAULTS.CLOSE_BETS_AT,
  anchorMs: ENV_DEFAULTS.ANCHOR_MS,
};

function getConfig() {
  // sécurité : closeBetsAt doit rester < roundSeconds
  const roundSeconds = clamp(toInt(RUNTIME.roundSeconds, ENV_DEFAULTS.ROUND_SECONDS), 10, 86400);
  const closeBetsAt = clamp(
    toInt(RUNTIME.closeBetsAt, ENV_DEFAULTS.CLOSE_BETS_AT),
    1,
    Math.max(1, roundSeconds - 1)
  );
  const anchorMs = toInt(RUNTIME.anchorMs, ENV_DEFAULTS.ANCHOR_MS);

  return { roundSeconds, closeBetsAt, anchorMs };
}

function getState(nowMs = Date.now()) {
  const { roundSeconds, closeBetsAt, anchorMs } = getConfig();

  const elapsedSec = Math.floor((nowMs - anchorMs) / 1000);
  const inRound = ((elapsedSec % roundSeconds) + roundSeconds) % roundSeconds; // safe modulo
  const remaining = roundSeconds - inRound;
  const roundIndex = Math.floor(elapsedSec / roundSeconds) + 1;
  const phase = remaining <= closeBetsAt ? "CLOSED" : "OPEN";

  return {
    round: roundIndex,
    phase,
    remaining,
    roundSeconds,
    closeBetsAt,
    anchorMs,
    serverTime: new Date(nowMs).toISOString(),
  };
}

// --------------------
// Admin auth
// --------------------
function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;

  if (!adminKey) {
    return res.status(500).json({
      error: "ADMIN_KEY manquant côté Render (Environment Variables)",
    });
  }

  // ✅ Header recommandé (depuis ton app admin)
  const fromHeader = req.header("x-admin-key");

  // ✅ Option pratique pour test rapide dans le navigateur (évite en prod)
  const fromQuery = req.query.key;

  const provided = String(fromHeader || fromQuery || "");

  if (!provided || provided !== adminKey) {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}

// --------------------
// Routes
// --------------------
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", service: "ddj-api", version: "v1" })
);

app.get("/api/state", (req, res) => res.json(getState()));

// public (safe)
app.get("/api/config", (req, res) => {
  const cfg = getConfig();
  res.json({
    roundSeconds: cfg.roundSeconds,
    closeBetsAt: cfg.closeBetsAt,
    anchorMs: cfg.anchorMs,
    anchorIso: new Date(cfg.anchorMs).toISOString(),
  });
});

// admin (protected)
app.get("/api/admin/config", requireAdmin, (req, res) => {
  const cfg = getConfig();
  res.json({
    ...cfg,
    anchorIso: new Date(cfg.anchorMs).toISOString(),
    serverTime: new Date().toISOString(),
  });
});

/**
 * PUT /api/admin/config
 * Body JSON (au choix) :
 * {
 *   "roundSeconds": 300,
 *   "closeBetsAt": 30,
 *   "anchorMs": 1735689600000,
 *   "anchorIso": "2026-01-01T00:00:00.000Z"
 * }
 */
app.put("/api/admin/config", requireAdmin, (req, res) => {
  const body = req.body || {};

  if (body.roundSeconds !== undefined) {
    RUNTIME.roundSeconds = clamp(toInt(body.roundSeconds, RUNTIME.roundSeconds), 10, 86400);
  }

  if (body.closeBetsAt !== undefined) {
    // sera re-clampé par getConfig()
    RUNTIME.closeBetsAt = clamp(toInt(body.closeBetsAt, RUNTIME.closeBetsAt), 1, 3600);
  }

  if (body.anchorMs !== undefined) {
    RUNTIME.anchorMs = toInt(body.anchorMs, RUNTIME.anchorMs);
  }

  if (body.anchorIso !== undefined) {
    const ms = parseIsoToMs(String(body.anchorIso));
    if (ms === null) {
      return res.status(400).json({ error: "anchorIso invalide (ISO attendu)" });
    }
    RUNTIME.anchorMs = ms;
  }

  const cfg = getConfig();
  res.json({
    ok: true,
    config: {
      ...cfg,
      anchorIso: new Date(cfg.anchorMs).toISOString(),
    },
    state: getState(),
  });
});

// Option : reset anchor à "maintenant" pour démarrer un nouveau cycle
app.post("/api/admin/anchor/now", requireAdmin, (req, res) => {
  RUNTIME.anchorMs = Date.now();
  res.json({ ok: true, state: getState() });
});

// --------------------
const PORT = toInt(process.env.PORT, 3000);
app.listen(PORT, () => console.log(`DDJ API running on port ${PORT}`));