import express from "express";
import cors from "cors";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// -------------------- CONFIG --------------------
const CONFIG_FILE = "./ddj-config.json";
const DATA_FILE = "./ddj-data.json";

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function loadConfig() {
  const base = {
    roundSeconds: num(process.env.ROUND_SECONDS, 300),     // 5 min
    closeBetsLastSeconds: num(process.env.CLOSE_BETS_AT, 30), // fermeture à 30s de la fin (compat)
    drawSeconds: num(process.env.DRAW_SECONDS, 15),        // phase DRAWING
    revealEverySeconds: num(process.env.REVEAL_EVERY, 3),  // 1 numéro toutes 3s
    anchorMs: num(process.env.ANCHOR_MS, Date.UTC(2025, 0, 1, 0, 0, 0)),
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return { ...base, ...saved };
    }
  } catch {}
  return base;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  } catch {}
}

let CONFIG = loadConfig();

// IMPORTANT: clé admin et seed (met-les sur Render)
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SECRET_SEED = process.env.SECRET_SEED || "ddj-seed-dev-only";

// -------------------- DATA --------------------
function loadData() {
  const base = {
    players: {},         // playerId -> {id, firstName, lastName, pinHash, balance, createdAt}
    sessions: {},        // token -> {playerId, expMs}
    serials: {},         // serial -> {amount, used, usedBy, usedAt}
    betsByRound: {},     // round -> [ {playerId, numbers, chances, cost, createdAt} ]
    history: [],         // last results
    reserves: { next: 0, tenth: 0 },
    lastFinalizedRound: 0
  };
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      return { ...base, ...saved };
    }
  } catch {}
  return base;
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DATA, null, 2), "utf-8");
  } catch {}
}

let DATA = loadData();

// -------------------- HELPERS --------------------
function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function requireAdmin(req, res, next) {
  const k = req.headers["x-admin-key"];
  if (!ADMIN_KEY) return res.status(500).json({ error: "ADMIN_KEY manquant sur Render" });
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const sess = token ? DATA.sessions[token] : null;
  if (!sess) return res.status(401).json({ error: "Unauthorized" });
  if (Date.now() > sess.expMs) {
    delete DATA.sessions[token];
    saveData();
    return res.status(401).json({ error: "Session expired" });
  }
  req.playerId = sess.playerId;
  req.token = token;
  next();
}

function combinations(n, k) {
  if (n < k) return 0;
  let res = 1;
  for (let i = 1; i <= k; i++) res = (res * (n - (k - i))) / i;
  return Math.round(res);
}

function betCostDOS(numbersCount, chancesCount) {
  // Règle FDJ-like: multi = combinaisons de 4 num * nb chances
  // Prix base (1 grille) : 2.20 DOS
  const grids = combinations(numbersCount, 4) * chancesCount;
  return Math.round(grids * 2.2 * 100) / 100;
}

function stateNow(nowMs = Date.now()) {
  const roundSeconds = CONFIG.roundSeconds;
  const elapsedSec = Math.floor((nowMs - CONFIG.anchorMs) / 1000);
  const inRound = ((elapsedSec % roundSeconds) + roundSeconds) % roundSeconds;
  const remaining = roundSeconds - inRound;
  const round = Math.floor(elapsedSec / roundSeconds) + 1;

  // Phases: OPEN -> CLOSED -> DRAWING -> RESULTS (jusqu’au prochain round)
  const closeStart = CONFIG.drawSeconds + CONFIG.closeBetsLastSeconds;
  let phase = "OPEN";
  if (remaining <= CONFIG.drawSeconds) phase = "DRAWING";
  else if (remaining <= closeStart) phase = "CLOSED";
  else phase = "OPEN";

  // reveal progressive pendant DRAWING
  let revealIndex = 0;
  if (phase === "DRAWING") {
    const spentInDrawing = CONFIG.drawSeconds - remaining; // de 0 à drawSeconds
    revealIndex = Math.min(5, Math.floor(spentInDrawing / CONFIG.revealEverySeconds) + 1);
  }
  if (phase !== "DRAWING") revealIndex = 0;

  return { round, phase, remaining, roundSeconds, revealIndex };
}

// Tirage déterministe par round (stable pour tous)
function drawForRound(round) {
  const seed = sha256(`${SECRET_SEED}|round:${round}`);
  // mini PRNG
  let x = parseInt(seed.slice(0, 12), 16) || 123456;
  function rnd() {
    // xorshift-ish
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return (Math.abs(x) % 1_000_000) / 1_000_000;
  }

  const pool = [];
  for (let i = 1; i <= 20; i++) pool.push(i);

  function pickOne(arr) {
    const idx = Math.floor(rnd() * arr.length);
    return arr.splice(idx, 1)[0];
  }

  // 4 num uniques
  const nums = [];
  const tmp = [...pool];
  while (nums.length < 4) nums.push(pickOne(tmp));
  nums.sort((a, b) => a - b);

  // chance: 1..20, différent des 4 num (plus clean)
  const chancePool = pool.filter(n => !nums.includes(n));
  const chance = chancePool[Math.floor(rnd() * chancePool.length)];

  return { nums, chance };
}

function summarizeHistoryItem(item) {
  return {
    round: item.round,
    winning: item.winning,
    potDOS: item.potDOS,
    winners: item.winners,
    carriedDOS: item.carriedDOS,
    createdAt: item.createdAt
  };
}

// Finalisation des rounds manqués (quand quelqu’un appelle l’API)
function ensureFinalizedUpTo(currentRound) {
  // On finalize tous les rounds < currentRound, si pas déjà fait
  for (let r = DATA.lastFinalizedRound + 1; r < currentRound; r++) {
    finalizeRound(r);
    DATA.lastFinalizedRound = r;
  }
  saveData();
}

function finalizeRound(round) {
  const bets = DATA.betsByRound[String(round)] || [];
  const winning = drawForRound(round);

  const potDOS = Math.round(bets.reduce((s, b) => s + (b.cost || 0), 0) * 100) / 100;

  // Réserves fixes : 15% next + 15% 10th
  const toNext = Math.round(potDOS * 0.15 * 100) / 100;
  const toTenth = Math.round(potDOS * 0.15 * 100) / 100;

  DATA.reserves.next = Math.round((DATA.reserves.next + toNext) * 100) / 100;
  DATA.reserves.tenth = Math.round((DATA.reserves.tenth + toTenth) * 100) / 100;

  // Pool de paiement immédiat = 70% + bonus tenth si round % 10 == 0
  let payoutPool = Math.round(potDOS * 0.70 * 100) / 100;
  if (round % 10 === 0) {
    payoutPool = Math.round((payoutPool + DATA.reserves.tenth) * 100) / 100;
    DATA.reserves.tenth = 0;
  }

  // Catégories (ajustables)
  const catShare = {
    A: 0.50, // 4 + chance
    B: 0.30, // 4
    C: 0.20  // 3 + chance
  };

  // On considère un ticket multi comme plusieurs grilles.
  // On compte les "grilles gagnantes" par joueur pour répartir proportionnellement.
  const winnersGrids = { A: {}, B: {}, C: {} }; // cat -> playerId -> countGrids

  function evalGrid(main4, chance1) {
    const mainMatches = main4.filter(n => winning.nums.includes(n)).length;
    const chanceMatch = (chance1 === winning.chance);
    if (mainMatches === 4 && chanceMatch) return "A";
    if (mainMatches === 4 && !chanceMatch) return "B";
    if (mainMatches === 3 && chanceMatch) return "C";
    return null;
  }

  function expandAndCount(bet) {
    const nums = bet.numbers.slice().sort((a,b)=>a-b);
    const chs = bet.chances.slice().sort((a,b)=>a-b);

    // combinaisons de 4 num sur nums, et 1 chance sur chs
    const comb4 = [];
    const n = nums.length;
    for (let i=0;i<n-3;i++){
      for (let j=i+1;j<n-2;j++){
        for (let k=j+1;k<n-1;k++){
          for (let l=k+1;l<n;l++){
            comb4.push([nums[i],nums[j],nums[k],nums[l]]);
          }
        }
      }
    }
    for (const main4 of comb4) {
      for (const c of chs) {
        const cat = evalGrid(main4, c);
        if (!cat) continue;
        winnersGrids[cat][bet.playerId] = (winnersGrids[cat][bet.playerId] || 0) + 1;
      }
    }
  }

  for (const b of bets) expandAndCount(b);

  const winners = {
    A: Object.keys(winnersGrids.A).length,
    B: Object.keys(winnersGrids.B).length,
    C: Object.keys(winnersGrids.C).length
  };

  // Allocation par catégorie
  const alloc = {
    A: Math.round(payoutPool * catShare.A * 100) / 100,
    B: Math.round(payoutPool * catShare.B * 100) / 100,
    C: Math.round(payoutPool * catShare.C * 100) / 100
  };

  // Si une catégorie n’a aucun gagnant : on la reporte au prochain tour (dans reserves.next)
  let carriedDOS = 0;
  for (const cat of ["A","B","C"]) {
    const totalGridWins = Object.values(winnersGrids[cat]).reduce((s,v)=>s+v,0);
    if (totalGridWins === 0) {
      carriedDOS = Math.round((carriedDOS + alloc[cat]) * 100) / 100;
      alloc[cat] = 0;
    }
  }
  if (carriedDOS > 0) {
    DATA.reserves.next = Math.round((DATA.reserves.next + carriedDOS) * 100) / 100;
  }

  // Paiement des gagnants (proportionnel aux grilles gagnantes)
  const payoutsByPlayer = {}; // playerId -> amount
  for (const cat of ["A","B","C"]) {
    const totalGridWins = Object.values(winnersGrids[cat]).reduce((s,v)=>s+v,0);
    if (totalGridWins === 0 || alloc[cat] <= 0) continue;

    for (const [pid, cnt] of Object.entries(winnersGrids[cat])) {
      const share = Math.round((alloc[cat] * (cnt / totalGridWins)) * 100) / 100;
      payoutsByPlayer[pid] = Math.round(((payoutsByPlayer[pid] || 0) + share) * 100) / 100;
    }
  }

  // Appliquer payouts
  for (const [pid, amount] of Object.entries(payoutsByPlayer)) {
    if (!DATA.players[pid]) continue;
    DATA.players[pid].balance = Math.round((DATA.players[pid].balance + amount) * 100) / 100;
  }

  // Historique (max 10)
  const histItem = {
    round,
    winning,
    potDOS,
    winners,
    payoutsByPlayer,
    carriedDOS,
    createdAt: new Date().toISOString()
  };
  DATA.history.unshift(histItem);
  DATA.history = DATA.history.slice(0, 10);

  // Nettoyage bets vieux
  const keepFrom = round - 12;
  for (const key of Object.keys(DATA.betsByRound)) {
    if (Number(key) < keepFrom) delete DATA.betsByRound[key];
  }
}

// -------------------- ROUTES PUBLIC --------------------
app.get("/api/health", (req, res) => res.json({ status: "ok", service: "ddj-api" }));

app.get("/api/state", (req, res) => {
  const st = stateNow();
  ensureFinalizedUpTo(st.round);

  // Jackpot = reserves.next (carry)
  const jackpotDOS = DATA.reserves.next;

  const draw = drawForRound(st.round);
  const drawnSoFar = st.phase === "DRAWING"
    ? [...draw.nums, draw.chance].slice(0, st.revealIndex)
    : [];

  res.json({
    ...st,
    closeBetsLastSeconds: CONFIG.closeBetsLastSeconds,
    drawSeconds: CONFIG.drawSeconds,
    revealEverySeconds: CONFIG.revealEverySeconds,
    jackpotDOS,
    drawnSoFar,
    // On ne donne la combinaison complète qu’après DRAWING (quand le round a avancé)
    // => les joueurs la verront via l'historique du round précédent.
    history: DATA.history.map(summarizeHistoryItem),
    serverTime: new Date().toISOString()
  });
});

app.get("/api/history", (req, res) => {
  res.json(DATA.history.map(summarizeHistoryItem));
});

// -------------------- AUTH --------------------
app.post("/api/register", (req, res) => {
  const firstName = String(req.body?.firstName || "").trim();
  const lastName = String(req.body?.lastName || "").trim();
  if (!firstName || !lastName) return res.status(400).json({ error: "Nom/Prénom requis" });

  // ID format L####
  let id;
  for (let i = 0; i < 50; i++) {
    const n = Math.floor(1000 + Math.random() * 9000);
    id = `L${n}`;
    if (!DATA.players[id]) break;
  }
  if (DATA.players[id]) return res.status(500).json({ error: "ID generation failed" });

  const pin = String(Math.floor(1000 + Math.random() * 9000)); // 4 chiffres
  const pinHash = sha256(pin);

  DATA.players[id] = {
    id,
    firstName,
    lastName,
    pinHash,
    balance: 0,
    createdAt: new Date().toISOString()
  };

  saveData();
  res.json({ ok: true, playerId: id, pin });
});

app.post("/api/login", (req, res) => {
  const playerId = String(req.body?.playerId || "").trim();
  const pin = String(req.body?.pin || "").trim();
  const p = DATA.players[playerId];
  if (!p) return res.status(401).json({ error: "Identifiants invalides" });
  if (sha256(pin) !== p.pinHash) return res.status(401).json({ error: "Identifiants invalides" });

  const token = makeToken();
  DATA.sessions[token] = { playerId, expMs: Date.now() + 1000 * 60 * 60 * 24 * 30 }; // 30 jours
  saveData();
  res.json({ ok: true, token, player: { id: p.id, firstName: p.firstName, lastName: p.lastName, balance: p.balance } });
});

app.post("/api/logout", requireAuth, (req, res) => {
  delete DATA.sessions[req.token];
  saveData();
  res.json({ ok: true });
});

// -------------------- PLAYER --------------------
app.get("/api/me", requireAuth, (req, res) => {
  const p = DATA.players[req.playerId];
  if (!p) return res.status(401).json({ error: "Unauthorized" });

  res.json({
    player: { id: p.id, firstName: p.firstName, lastName: p.lastName, balance: p.balance },
    history: DATA.history.map(h => ({
      round: h.round,
      winning: h.winning,
      potDOS: h.potDOS,
      winners: h.winners,
      myWinDOS: Math.round((h.payoutsByPlayer[p.id] || 0) * 100) / 100,
      createdAt: h.createdAt
    }))
  });
});

app.post("/api/topup", requireAuth, (req, res) => {
  const serial = String(req.body?.serial || "").trim();
  if (!serial) return res.status(400).json({ error: "Serial requis" });

  const s = DATA.serials[serial];
  if (!s) return res.status(400).json({ error: "Serial invalide" });
  if (s.used) return res.status(400).json({ error: "Serial déjà utilisé" });

  s.used = true;
  s.usedBy = req.playerId;
  s.usedAt = new Date().toISOString();

  const p = DATA.players[req.playerId];
  p.balance = Math.round((p.balance + s.amount) * 100) / 100;

  saveData();
  res.json({ ok: true, added: s.amount, balance: p.balance });
});

app.post("/api/bet", requireAuth, (req, res) => {
  const st = stateNow();
  ensureFinalizedUpTo(st.round);

  if (st.phase !== "OPEN") return res.status(400).json({ error: "Mises fermées" });

  const numbers = (req.body?.numbers || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 20);
  const chances = (req.body?.chances || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 20);

  const uniqNumbers = [...new Set(numbers)];
  const uniqChances = [...new Set(chances)];

  if (uniqNumbers.length < 4) return res.status(400).json({ error: "Choisir au moins 4 numéros" });
  if (uniqNumbers.length > 8) return res.status(400).json({ error: "Max 8 numéros" });
  if (uniqChances.length < 1) return res.status(400).json({ error: "Choisir au moins 1 numéro chance" });
  if (uniqChances.length > 3) return res.status(400).json({ error: "Max 3 chances" });

  const cost = betCostDOS(uniqNumbers.length, uniqChances.length);

  const p = DATA.players[req.playerId];
  if (!p) return res.status(401).json({ error: "Unauthorized" });
  if (p.balance < cost) return res.status(400).json({ error: "Solde insuffisant" });

  // 1 bet par round par joueur (simplifié)
  const roundKey = String(st.round);
  const arr = DATA.betsByRound[roundKey] || [];
  const already = arr.find(b => b.playerId === req.playerId);
  if (already) return res.status(400).json({ error: "Déjà joué pour ce tour" });

  p.balance = Math.round((p.balance - cost) * 100) / 100;

  arr.push({
    playerId: req.playerId,
    numbers: uniqNumbers.sort((a,b)=>a-b),
    chances: uniqChances.sort((a,b)=>a-b),
    cost,
    createdAt: new Date().toISOString()
  });

  DATA.betsByRound[roundKey] = arr;
  saveData();

  res.json({ ok: true, round: st.round, cost, balance: p.balance });
});

// -------------------- ADMIN --------------------
app.get("/api/admin/players", requireAdmin, (req, res) => {
  const list = Object.values(DATA.players).map(p => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    balance: p.balance,
    createdAt: p.createdAt
  }));
  res.json(list);
});

app.post("/api/admin/player/balance", requireAdmin, (req, res) => {
  const playerId = String(req.body?.playerId || "").trim();
  const mode = String(req.body?.mode || "add");
  const amount = Math.round(num(req.body?.amount, 0) * 100) / 100;

  const p = DATA.players[playerId];
  if (!p) return res.status(404).json({ error: "Joueur introuvable" });

  if (mode === "set") p.balance = amount;
  else if (mode === "zero") p.balance = 0;
  else p.balance = Math.round((p.balance + amount) * 100) / 100;

  saveData();
  res.json({ ok: true, playerId, balance: p.balance });
});

app.post("/api/admin/serials", requireAdmin, (req, res) => {
  const amount = Math.round(num(req.body?.amount, 0) * 100) / 100;
  if (!(amount > 0)) return res.status(400).json({ error: "Montant invalide" });

  // serial 10 chiffres
  let serial = "";
  for (let i = 0; i < 60; i++) {
    serial = String(Math.floor(1_000_000_000 + Math.random() * 9_000_000_000));
    if (!DATA.serials[serial]) break;
  }
  if (DATA.serials[serial]) return res.status(500).json({ error: "Serial generation failed" });

  DATA.serials[serial] = { amount, used: false, usedBy: null, usedAt: null, createdAt: new Date().toISOString() };
  saveData();
  res.json({ ok: true, serial, amount });
});

app.get("/api/admin/config", requireAdmin, (req, res) => res.json(CONFIG));

app.post("/api/admin/config", requireAdmin, (req, res) => {
  const roundSeconds = req.body?.roundSeconds;
  const closeBetsLastSeconds = req.body?.closeBetsLastSeconds;
  const drawSeconds = req.body?.drawSeconds;
  const revealEverySeconds = req.body?.revealEverySeconds;
  const anchorNow = req.body?.anchorNow === true;

  if (roundSeconds !== undefined) {
    const v = Math.floor(num(roundSeconds, CONFIG.roundSeconds));
    if (v < 60 || v > 24 * 3600) return res.status(400).json({ error: "roundSeconds (60..86400)" });
    CONFIG.roundSeconds = v;
  }
  if (closeBetsLastSeconds !== undefined) {
    const v = Math.floor(num(closeBetsLastSeconds, CONFIG.closeBetsLastSeconds));
    if (v < 0 || v > CONFIG.roundSeconds) return res.status(400).json({ error: "closeBetsLastSeconds invalide" });
    CONFIG.closeBetsLastSeconds = v;
  }
  if (drawSeconds !== undefined) {
    const v = Math.floor(num(drawSeconds, CONFIG.drawSeconds));
    if (v < 3 || v > 120) return res.status(400).json({ error: "drawSeconds (3..120)" });
    CONFIG.drawSeconds = v;
  }
  if (revealEverySeconds !== undefined) {
    const v = Math.floor(num(revealEverySeconds, CONFIG.revealEverySeconds));
    if (v < 1 || v > 10) return res.status(400).json({ error: "revealEverySeconds (1..10)" });
    CONFIG.revealEverySeconds = v;
  }
  if (anchorNow) CONFIG.anchorMs = Date.now();

  saveConfig(CONFIG);
  res.json({ ok: true, config: CONFIG });
});

// --------------------
const PORT = num(process.env.PORT, 3000);
app.listen(PORT, () => console.log(`DDJ API running on port ${PORT}`));