// db.js
import pg from "pg";

const { Pool } = pg;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return v;
}

// Render fournit DATABASE_URL
const DATABASE_URL = requireEnv("DATABASE_URL");

// Sur Render Postgres, SSL est généralement requis en prod.
// Sur certaines URLs "internal", ça peut marcher sans SSL, mais ce mode est safe.
export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false },
});

// Petit test de connexion au démarrage (log utile)
export async function checkDb() {
  const client = await pool.connect();
  try {
    const r = await client.query("SELECT NOW() as now");
    console.log("✅ DB connected:", r.rows[0].now);
  } finally {
    client.release();
  }
}