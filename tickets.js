import crypto from "crypto";

// Alphabet sans O/0 et I/1 (anti confusion)
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateTicketCode(length = 12) {
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function hashTicketCode(code) {
  const seed = process.env.SECRET_SEED || "";
  if (!seed || seed.length < 16) throw new Error("SECRET_SEED manquant/trop court");
  return crypto.createHash("sha256").update(`DDJ|${seed}|${code}`).digest("hex");
}