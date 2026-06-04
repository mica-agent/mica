// Encrypt-at-rest codec for the credential store — DORMANT in single-tenant main.
//
// When MICA_SECRET_KEY is UNSET (main's default): encrypt/decrypt are pass-through,
// so credentials.json stays plaintext exactly as today. When a multi-tenant fork
// sets MICA_SECRET_KEY: the credential store is written AES-256-GCM-encrypted and
// transparently decrypted on read. decryptSecret is robust to BOTH forms, so:
//   - toggling the key ON doesn't break reading pre-existing plaintext files, and
//   - the plaintext credentials JSON object (which is itself valid JSON) is never
//     mistaken for an envelope.
//
// The key is derived via SHA-256 of MICA_SECRET_KEY, so any string/passphrase works
// (no fixed-length requirement). No deps on server internals → importable anywhere.

import crypto from "node:crypto";

function secretKey(): Buffer | null {
  const s = process.env.MICA_SECRET_KEY;
  if (!s) return null;
  return crypto.createHash("sha256").update(s).digest(); // 32 bytes for aes-256
}

/** True when encryption-at-rest is active (a fork set MICA_SECRET_KEY). */
export function secretsEnabled(): boolean {
  return Boolean(process.env.MICA_SECRET_KEY);
}

/** Encrypt a plaintext string for at-rest storage. Pass-through when no key is
 *  configured (main): returns the plaintext unchanged. */
export function encryptSecret(plaintext: string): string {
  const k = secretKey();
  if (!k) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1, alg: "a256gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  });
}

/** Decrypt a stored string. Robust to plaintext: only our `{v:1,…}` envelope is
 *  decrypted; anything else (a plaintext JSON object, or a file written before
 *  encryption was enabled) is returned unchanged. Throws only if an envelope is
 *  present but the key is missing/wrong. */
export function decryptSecret(stored: string): string {
  let env: unknown;
  try { env = JSON.parse(stored); } catch { return stored; } // not JSON → plaintext blob
  const e = env as { v?: number; iv?: string; tag?: string; ct?: string };
  if (!e || e.v !== 1 || !e.iv || !e.tag || !e.ct) return stored; // plaintext JSON, not our envelope
  const k = secretKey();
  if (!k) throw new Error("MICA_SECRET_KEY is required to decrypt the encrypted credential store");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(e.iv, "base64"));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(e.ct, "base64")), decipher.final()]).toString("utf8");
}
