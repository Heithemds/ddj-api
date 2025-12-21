// initDb.js
import { query } from "./db.js";

export async function initDb() {
  // Tables de base (config, users, wallets, ledger, tickets)
  await query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance NUMERIC(18, 2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Ledger = traçabilité (anti-fraude / audit)
  await query(`
    CREATE TABLE IF NOT EXISTS ledger (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL, -- SIGNUP_BONUS / DEPOSIT / BET / WIN / TICKET_REDEEM / ADJUSTMENT
      amount NUMERIC(18, 2) NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_ledger_user_id ON ledger(user_id);
  `);

  // Tickets cadeaux / promos (codes sécurisés)
  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_hash TEXT UNIQUE NOT NULL,
      value NUMERIC(18,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE / REDEEMED / DISABLED
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      redeemed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      redeemed_at TIMESTAMPTZ
    );
  `);

  // Valeurs par défaut (si pas déjà présentes)
  await query(
    `INSERT INTO app_config(key, value)
     VALUES
      ('roundSeconds', '300'),
      ('closeBetsAt', '30'),
      ('signupBonus', '50')
     ON CONFLICT (key) DO NOTHING;`
  );

  // Extension gen_random_uuid() (nécessaire sur certaines instances)
  // Render Postgres l’a souvent déjà, mais on sécurise.
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
}