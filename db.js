// db.js
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn("[DDJ] DATABASE_URL manquant. La DB ne pourra pas se connecter.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined
});

export async function query(text, params) {
  return pool.query(text, params);
}

export { pool };