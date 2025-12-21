// initDb.js
import { pool } from "./db.js";

export async function initDb() {
  const client = await pool.connect();
  try {
    // Sécurise des transactions propres
    await client.query("BEGIN");

    // 1) Players
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        balance_dos INT NOT NULL DEFAULT 50,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2) Gift codes (codes cadeaux)
    // On stocke uniquement le hash (sha256) du code, jamais le code brut.
    await client.query(`
      CREATE TABLE IF NOT EXISTS gift_codes (
        id SERIAL PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        amount_dos INT NOT NULL DEFAULT 50,
        redeemed_by INT NULL REFERENCES players(id) ON DELETE SET NULL,
        redeemed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Index utile pour retrouver vite les codes non utilisés
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gift_codes_redeemed_at
      ON gift_codes (redeemed_at);
    `);

    await client.query("COMMIT");
    console.log("✅ initDb OK : tables players + gift_codes");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ initDb ERROR:", err);
    throw err;
  } finally {
    client.release();
  }
}