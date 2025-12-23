// initDb.js
import { pool } from "./db.js";

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // ===== DDJ: Bank + Rounds + Bet payout columns (MIGRATION) =====

// 1) Bank: carry + admin balance
await client.query(`
  CREATE TABLE IF NOT EXISTS game_bank (
    id INT PRIMARY KEY,
    carry_dos BIGINT NOT NULL DEFAULT 0,
    admin_balance_dos BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
await client.query(`
  INSERT INTO game_bank (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;
`);

// 2) Rounds: draw + totals + audit (one row per round settled)
await client.query(`
  CREATE TABLE IF NOT EXISTS rounds (
    round_id BIGINT PRIMARY KEY,
    draw_nums INT[] NULL,
    draw_chance INT NULL,
    total_bets_dos BIGINT NOT NULL DEFAULT 0,
    pot_total_dos BIGINT NOT NULL DEFAULT 0,
    admin_take_dos BIGINT NOT NULL DEFAULT 0,
    carry_in_dos BIGINT NOT NULL DEFAULT 0,
    carry_out_dos BIGINT NOT NULL DEFAULT 0,
    settled_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

// 3) Bets: store combination + payout info (compatible with old A/B bets too)
await client.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS nums INT[];`);
await client.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS chance INT;`);
await client.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS category TEXT;`);
await client.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS payout_dos BIGINT NOT NULL DEFAULT 0;`);
await client.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS settled BOOLEAN NOT NULL DEFAULT FALSE;`);

await client.query(`CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_bets_player ON bets(player_id);`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_rounds_settled ON rounds(settled_at);`);

// ===== END MIGRATION =====

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

    // ledger
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

    // gift codes
    await client.query(`
      CREATE TABLE IF NOT EXISTS gift_codes (
        id BIGSERIAL PRIMARY KEY,
        code_hash TEXT UNIQUE NOT NULL,
        value_dos BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        expires_at TIMESTAMPTZ NULL,
        redeemed_by BIGINT NULL REFERENCES players(id) ON DELETE SET NULL,
        redeemed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gift_codes_status ON gift_codes(status);`);

    // ✅ bank (carry + solde admin)
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_bank (
        id INT PRIMARY KEY,
        carry_dos BIGINT NOT NULL DEFAULT 0,
        admin_balance_dos BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      INSERT INTO game_bank (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    // ✅ rounds : résultat + audit
    await client.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        round_id BIGINT PRIMARY KEY,
        draw_nums INT[] NULL,
        draw_chance INT NULL,
        total_bets_dos BIGINT NOT NULL DEFAULT 0,
        pot_total_dos BIGINT NOT NULL DEFAULT 0,
        admin_take_dos BIGINT NOT NULL DEFAULT 0,
        carry_in_dos BIGINT NOT NULL DEFAULT 0,
        carry_out_dos BIGINT NOT NULL DEFAULT 0,
        settled_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ✅ bets = 1 combinaison (4 nums + 1 chance)
    await client.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id BIGSERIAL PRIMARY KEY,
        player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        round_id BIGINT NOT NULL,
        nums INT[] NOT NULL,      -- 4 numéros
        chance INT NOT NULL,      -- 1 chance
        amount BIGINT NOT NULL,   -- mise DOS pour cette combinaison (souvent prix fixe)
        category TEXT NULL,
        payout_dos BIGINT NOT NULL DEFAULT 0,
        settled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bets_player ON bets(player_id);`);

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