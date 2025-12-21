import { pool } from "./db.js";

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // players
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id BIGSERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        balance_dos BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // dos_ledger
    await client.query(`
      CREATE TABLE IF NOT EXISTS dos_ledger (
        id BIGSERIAL PRIMARY KEY,
        player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        amount BIGINT NOT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ledger_player_id_id
      ON dos_ledger(player_id, id DESC);
    `);

    // gift_codes
    await client.query(`
      CREATE TABLE IF NOT EXISTS gift_codes (
        id BIGSERIAL PRIMARY KEY,
        code_hash TEXT UNIQUE NOT NULL,
        value_dos BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE / REDEEMED / DISABLED
        expires_at TIMESTAMPTZ NULL,
        redeemed_by BIGINT NULL REFERENCES players(id) ON DELETE SET NULL,
        redeemed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_gift_codes_status ON gift_codes(status);`);

    // bets
    await client.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id BIGSERIAL PRIMARY KEY,
        player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        round_id BIGINT NOT NULL,
        choice TEXT NOT NULL,
        amount BIGINT NOT NULL CHECK (amount > 0),
        settled BOOLEAN NOT NULL DEFAULT false,
        payout_dos BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_bets_round_id ON bets(round_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bets_settled ON bets(settled);`);

    // round_results (IMPORTANT: colonne outcome)
    await client.query(`
      CREATE TABLE IF NOT EXISTS round_results (
        round_id BIGINT PRIMARY KEY,
        outcome TEXT NOT NULL,
        settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    console.log("✅ initDb OK");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ initDb ERROR:", e);
    throw e;
  } finally {
    client.release();
  }
}