import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SECRET_KEYS, storedSecrets, type SecretKey } from "./secrets.js";

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Secrets and process-level config. Credentials come from the environment or, when
 * entered in the console, from the encrypted store; the environment always wins.
 * They're optional here so the console can start before setup; use need() to read them.
 */
const envSchema = z.object({
  BAMBOO_SUBDOMAIN: z.string().min(1).optional(),
  BAMBOO_API_KEY: z.string().min(1).optional(),
  BAMBOO_BASE_URL: z.string().url().optional(),
  GOOGLE_ADMIN: z.string().email().optional(),
  GOOGLE_CREDENTIALS: z.string().min(1).optional(),
  INITIAL_PASSWORD: z.string().min(8).optional(),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  UI_USER: z.string().default("admin"),
  UI_PASSWORD: z.string().optional(),
  PORT: z.coerce.number().int().default(3000),
  DATA_DIR: z.string().default("./data"),
});

export type Env = z.infer<typeof envSchema>;

/** Env vars that are set and not blank (a blank line in .env means "not set"). */
const processEnv = () => Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));

/** Where each credential comes from. */
export const credentialSource = (k: SecretKey): "env" | "console" | null =>
  processEnv()[k] ? "env" : storedSecrets()[k] ? "console" : null;

let cachedEnv: Env | undefined;
export function env(): Env {
  if (!cachedEnv) {
    const stored = Object.fromEntries(SECRET_KEYS.map((k) => [k, storedSecrets()[k]]).filter(([, v]) => v));
    const parsed = envSchema.safeParse({ ...stored, ...processEnv() });
    if (!parsed.success) {
      const invalid = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment variables: ${invalid}`);
    }
    cachedEnv = parsed.data;
  }
  return cachedEnv;
}

/** Call after the stored credentials change. */
export const resetEnv = () => (cachedEnv = undefined);

/** A credential the sync can't run without. */
export function need<K extends SecretKey>(k: K): string {
  const v = env()[k];
  if (!v) throw new Error(`${k} is not set. Add it under Connections → Credentials, or as an environment variable.`);
  return v;
}

/** Validates credentials entered in the console before they're stored. */
export function validateCredential(k: SecretKey, v: string): string {
  const value = v.trim();
  if (k === "GOOGLE_ADMIN") return z.string().email("Google admin must be an email address").parse(value);
  if (k === "SLACK_WEBHOOK_URL") return z.string().url("Slack webhook must be a URL").startsWith("https://", "Slack webhook must use https").parse(value);
  if (k === "BAMBOO_SUBDOMAIN") return z.string().regex(/^[a-z0-9-]+$/i, "BambooHR subdomain is the part before .bamboohr.com").parse(value);
  if (k === "GOOGLE_CREDENTIALS") {
    let json: { type?: string; client_email?: string; private_key?: string };
    try {
      json = JSON.parse(value);
    } catch {
      throw new Error("Service account key must be the JSON file downloaded from Google Cloud");
    }
    if (json.type !== "service_account" || !json.client_email || !json.private_key) {
      throw new Error("That JSON isn't a service account key (needs type, client_email and private_key)");
    }
    return JSON.stringify(json);
  }
  return value;
}

/** Non-secret sync behaviour. Defaults come from env, overrides are saved from the UI. */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #4F8CFF");

export const settingsSchema = z.object({
  appName: z.string().trim().min(1).max(60),
  logoUrl: z.string().url().or(z.literal("")),
  accentColor: hex,
  supportContact: z.string().max(120),
  newUserOu: z.string().startsWith("/"),
  suspendedOu: z.string().startsWith("/").or(z.literal("")),
  protectedOus: z.array(z.string().startsWith("/")),
  managedDomains: z.array(z.string()),
  recoveryEmail: z.string().email().or(z.literal("")),
  licenseProductId: z.string(),
  licenseSkus: z.array(z.string()),
  customSchema: z.string(),
  customFields: z.record(z.string(), z.string()),
  reactivateSuspended: z.boolean(),
  suspendMissing: z.boolean(),
  maxSuspensionsPerRun: z.number().int().min(0),
  concurrency: z.number().int().min(1).max(20),
  schedule: z.string(),
  scheduleDryRun: z.boolean(),
  notifyOn: z.enum(["failures", "always", "off"]),
  publicUrl: z.string().url().or(z.literal("")),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Every default is neutral: nothing company-specific is baked in. */
function envDefaults(): Settings {
  const e = process.env;
  const customFields = Object.fromEntries(
    list(e.CUSTOM_FIELDS)
      .map((pair) => pair.split(":").map((s) => s.trim()) as [string, string])
      .filter(([k, v]) => k && v),
  );
  return {
    appName: e.APP_NAME || "Directory Sync",
    logoUrl: e.LOGO_URL ?? "",
    accentColor: e.ACCENT_COLOR || "#4F8CFF",
    supportContact: e.SUPPORT_CONTACT ?? "",
    newUserOu: e.NEW_USER_OU || "/",
    suspendedOu: e.SUSPENDED_OU ?? "",
    protectedOus: list(e.PROTECTED_OUS),
    managedDomains: list(e.MANAGED_DOMAINS).map((d) => d.toLowerCase()),
    recoveryEmail: e.RECOVERY_EMAIL ?? "",
    licenseProductId: e.LICENSE_PRODUCT_ID || "Google-Apps",
    licenseSkus: list(e.LICENSE_SKUS),
    customSchema: e.CUSTOM_SCHEMA ?? "",
    customFields,
    reactivateSuspended: e.REACTIVATE_SUSPENDED === "true",
    suspendMissing: e.SUSPEND_MISSING !== "false",
    maxSuspensionsPerRun: Number(e.MAX_SUSPENSIONS_PER_RUN ?? 10),
    concurrency: Number(e.CONCURRENCY ?? 5),
    schedule: e.SYNC_SCHEDULE ?? "",
    scheduleDryRun: e.SCHEDULE_DRY_RUN === "true",
    notifyOn: (["failures", "always", "off"] as const).find((v) => v === e.NOTIFY_ON) ?? "failures",
    publicUrl: e.PUBLIC_URL ?? "",
  };
}

const settingsFile = () => join(env().DATA_DIR, "settings.json");

export async function loadSettings(): Promise<Settings> {
  const overrides = await readFile(settingsFile(), "utf8").then(JSON.parse, () => ({}));
  return settingsSchema.parse({ ...envDefaults(), ...overrides });
}

export async function saveSettings(input: unknown): Promise<Settings> {
  const settings = settingsSchema.parse({ ...(await loadSettings()), ...(input as object) });
  await mkdir(env().DATA_DIR, { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(settings, null, 2));
  return settings;
}

/** GOOGLE_CREDENTIALS may hold the service-account JSON itself or a path to it. */
export function googleCredentials(): { client_email: string; private_key: string; client_id?: string } {
  const raw = need("GOOGLE_CREDENTIALS").trim();
  return JSON.parse(raw.startsWith("{") ? raw : readFileSync(raw, "utf8"));
}
