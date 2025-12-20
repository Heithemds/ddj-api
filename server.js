import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 300);
const CLOSE_BETS_AT = Number(process.env.CLOSE_BETS_AT || 30);
const ANCHOR_MS = Number(process.env.ANCHOR_MS || Date.UTC(2025, 0, 1, 0, 0, 0));

function getState(nowMs = Date.now()) {
  const elapsedSec = Math.floor((nowMs - ANCHOR_MS) / 1000);
  const inRound = ((elapsedSec % ROUND_SECONDS) + ROUND_SECONDS) % ROUND_SECONDS;
  const remaining = ROUND_SECONDS - inRound;
  const roundIndex = Math.floor(elapsedSec / ROUND_SECONDS) + 1;
  const phase = remaining <= CLOSE_BETS_AT ? "CLOSED" : "OPEN";

  return {
    round: roundIndex,
    phase,
    remaining,
    roundSeconds: ROUND_SECONDS,
    closeBetsAt: CLOSE_BETS_AT,
    serverTime: new Date(nowMs).toISOString()
  };
}

app.get("/api/health", (req, res) => res.json({ status: "ok", service: "ddj-api" }));
app.get("/api/state", (req, res) => res.json(getState()));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`DDJ API running on port ${PORT}`));
