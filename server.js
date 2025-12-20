import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- CONFIG (avec fallback env + fichier local) ----------
const CONFIG_FILE = "./ddj-config.json";

function loadConfig() {
  // base depuis env
  const base = {
    roundSeconds: Number(process.env.ROUND_SECONDS || 300), // 5 min par défaut
    closeBetsAt: Number(process.env.CLOSE_BETS_AT || 30),   // fermeture à 30s de la fin
    anchorMs: Number(
      process.env.ANCHOR_MS || Date.UTC(2025, 0, 1, 0, 0, 0) // point d’ancrage
    ),
  };

  // si fichier local existe, il override (utile hors Render)
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const saved = JSON.parse(raw);
      return { ...base, ...saved };
    }
  } catch (e) {
    console.log("Config file load failed:", e?.message || e);
  }
  return base;
}

function saveConfig(cfg) {
  // ⚠️ Sur Render Free, le disque peut être éphémère (reset au redémarrage).
  // Mais ça marche bien pour dev/test.
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (e) {
    console.log("Config file save failed:", e?.message || e);
  }
}

let CONFIG = loadConfig();

// ---------- AUTH ADMIN ----------
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // mets-le dans Render

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_KEY) {
    return res.status(500).json({
      error: "ADMIN_KEY manquant côté serveur. Ajoute-le dans Render (Environment).",
    });
  }
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------- STATE CALC ----------
function getState(nowMs = Date.now()) {
  const { roundSeconds, closeBetsAt, anchorMs } = CONFIG;

  const elapsedSec = Math.floor((nowMs - anchorMs) / 1000);
  const inRound = ((elapsedSec % roundSeconds) + roundSeconds) % roundSeconds;
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

// ---------- ROUTES ----------
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", service: "ddj-api" })
);

app.get("/api/state", (req, res) => res.json(getState()));

// (optionnel) Voir la config publique (sans la clé)
app.get("/api/config", (req, res) => {
  res.json({
    roundSeconds: CONFIG.roundSeconds,
    closeBetsAt: CONFIG.closeBetsAt,
    anchorMs: CONFIG.anchorMs,
  });
});

// ADMIN: modifier le timer sans redéveloppement
app.post("/api/admin/config", requireAdmin, (req, res) => {
  const { roundSeconds, closeBetsAt, anchorMs, anchorNow } = req.body || {};

  // validations pro
  if (roundSeconds !== undefined) {
    const v = Number(roundSeconds);
    if (!Number.isFinite(v) || v < 10 || v > 24 * 3600) {
      return res.status(400).json({ error: "roundSeconds invalide (10..86400)" });
    }
    CONFIG.roundSeconds = Math.floor(v);
  }

  if (closeBetsAt !== undefined) {
    const v = Number(closeBetsAt);
    if (!Number.isFinite(v) || v < 0 || v > CONFIG.roundSeconds) {
      return res.status(400).json({ error: "closeBetsAt invalide" });
    }
    CONFIG.closeBetsAt = Math.floor(v);
  }

  // anchorNow=true => aligne le début de round maintenant (pratique)
  if (anchorNow === true) {
    CONFIG.anchorMs = Date.now();
  }

  if (anchorMs !== undefined) {
    const v = Number(anchorMs);
    if (!Number.isFinite(v) || v < 0) {
      return res.status(400).json({ error: "anchorMs invalide" });
    }
    CONFIG.anchorMs = Math.floor(v);
  }

  saveConfig(CONFIG);
  res.json({ ok: true, config: CONFIG, state: getState() });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`DDJ API running on port ${PORT}`));