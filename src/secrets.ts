import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Secrets entered in the console, encrypted at rest with AES-256-GCM in DATA_DIR/secrets.enc.json.
 * The key comes from ENCRYPTION_KEY, or is generated once into DATA_DIR/secret.key (mode 600).
 * Values are write-only: the API reports whether each one is set, never the value.
 * Environment variables always win, so a secret manager can still be used instead.
 */
export const SECRET_KEYS = ["BAMBOO_SUBDOMAIN", "BAMBOO_API_KEY", "GOOGLE_ADMIN", "GOOGLE_CREDENTIALS", "SLACK_WEBHOOK_URL"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
type Stored = Partial<Record<SecretKey | "UI_PASSWORD_HASH", string>>;

// Read straight from process.env: config.ts depends on this module, not the other way round.
const dataDir = () => process.env.DATA_DIR || "./data";
const file = () => join(dataDir(), "secrets.enc.json");

let key: Buffer | undefined;
export function keySource(): "env" | "file" {
  return process.env.ENCRYPTION_KEY ? "env" : "file";
}
function masterKey(): Buffer {
  if (key) return key;
  if (process.env.ENCRYPTION_KEY) return (key = scryptSync(process.env.ENCRYPTION_KEY, "bamboohr-gws-sync", 32));
  const path = join(dataDir(), "secret.key");
  try {
    key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  } catch {
    mkdirSync(dataDir(), { recursive: true });
    key = randomBytes(32);
    writeFileSync(path, key.toString("base64"), { mode: 0o600, flag: "wx" });
  }
  return key;
}

export function encrypt(plain: string, k = masterKey()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function decrypt(box: ReturnType<typeof encrypt>, k = masterKey()): string {
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
}

let cache: Stored | undefined;
export let secretsError: string | undefined;

export function storedSecrets(): Stored {
  if (cache) return cache;
  let raw: string;
  try {
    raw = readFileSync(file(), "utf8");
  } catch {
    return (cache = {});
  }
  try {
    cache = JSON.parse(decrypt(JSON.parse(raw))) as Stored;
    secretsError = undefined;
  } catch {
    secretsError = "Saved credentials can't be decrypted. The encryption key changed; re-enter them or restore the old key.";
    cache = {};
  }
  return cache;
}

/** Merge changes in ("" removes a value) and write atomically. */
export function saveSecrets(changes: Stored) {
  const next: Stored = { ...storedSecrets() };
  for (const [k, v] of Object.entries(changes) as [keyof Stored, string][]) {
    if (v) next[k] = v;
    else delete next[k];
  }
  mkdirSync(dataDir(), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(encrypt(JSON.stringify(next))), { mode: 0o600 });
  renameSync(tmp, file());
  cache = next;
  secretsError = undefined;
}

/** scrypt password hash for the console login created at first run. */
export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 32).toString("base64")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, "base64"), want.length), want);
}
