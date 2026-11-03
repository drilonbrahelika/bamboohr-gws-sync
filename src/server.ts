import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Cron } from "croner";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import * as bamboo from "./bamboo.js";
import {
  credentialSource,
  env,
  googleCredentials,
  loadSettings,
  resetEnv,
  saveSettings,
  validateCredential,
  type Settings,
} from "./config.js";
import * as google from "./google.js";
import { postSlack } from "./notify.js";
import { hashPassword, keySource, SECRET_KEYS, saveSecrets, secretsError, storedSecrets, verifyPassword, type SecretKey } from "./secrets.js";
import { currentRun, getRun, listRuns, startSync } from "./sync.js";

const config = env();
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

let job: Cron | undefined;
function schedule(s: Settings) {
  job?.stop();
  job = s.schedule
    ? new Cron(s.schedule, { protect: true }, () => {
        try {
          startSync({ dryRun: s.scheduleDryRun, trigger: "schedule" });
        } catch (err) {
          console.error("scheduled run skipped:", (err as Error).message);
        }
      })
    : undefined;
}

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

/**
 * Console login: UI_PASSWORD from the environment, or the admin password created on first run
 * (stored as an scrypt hash). Until one exists only the setup endpoints are reachable.
 */
const loginHash = () => storedSecrets().UI_PASSWORD_HASH;
const needsSetup = () => !config.UI_PASSWORD && !loginHash();
const envAuth = config.UI_PASSWORD ? basicAuth({ username: config.UI_USER, password: config.UI_PASSWORD }) : undefined;
const storedAuth = basicAuth({ verifyUser: (user, pass) => user === config.UI_USER && verifyPassword(pass, loginHash() ?? "") });

app.use("*", async (c, next) => {
  if (envAuth) return envAuth(c, next);
  if (!needsSetup()) return storedAuth(c, next);
  if (c.req.path === "/" || c.req.path === "/api/setup") return next();
  return c.json({ error: "Create the admin password first", setup: true }, 403);
});

app.get("/api/setup", (c) => c.json({ needsPassword: needsSetup(), user: config.UI_USER }));

app.post("/api/setup", async (c) => {
  if (!needsSetup()) return c.json({ error: "Already set up" }, 409);
  const { password } = z.object({ password: z.string().min(12, "Use at least 12 characters") }).parse(await c.req.json());
  saveSecrets({ UI_PASSWORD_HASH: hashPassword(password) });
  return c.json({ ok: true, user: config.UI_USER });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err) }, 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get("/", (c) => c.html(html));

/** Names of the env vars that are set (never their values). */
const ENV_KEYS = ["BAMBOO_BASE_URL", "INITIAL_PASSWORD", "UI_PASSWORD", "ENCRYPTION_KEY", "DATA_DIR", "TZ"];
const REQUIRED: SecretKey[] = ["BAMBOO_SUBDOMAIN", "BAMBOO_API_KEY", "GOOGLE_ADMIN", "GOOGLE_CREDENTIALS"];

function credentials() {
  let serviceAccount: string | undefined;
  let clientId: string | undefined;
  try {
    const key = env().GOOGLE_CREDENTIALS ? googleCredentials() : undefined;
    [serviceAccount, clientId] = [key?.client_email, key?.client_id];
  } catch {
    serviceAccount = "unreadable key";
  }
  return {
    // Only identifiers are returned; keys and webhook URLs never leave the server.
    items: SECRET_KEYS.map((key) => ({ key, source: credentialSource(key), required: REQUIRED.includes(key) })),
    values: { BAMBOO_SUBDOMAIN: env().BAMBOO_SUBDOMAIN ?? "", GOOGLE_ADMIN: env().GOOGLE_ADMIN ?? "", serviceAccount: serviceAccount ?? "", clientId: clientId ?? "" },
    scopes: google.SCOPES,
    keySource: keySource(),
    error: secretsError,
  };
}

app.get("/api/status", async (c) => {
  const [lastRun] = await listRuns(1);
  const s = await loadSettings();
  return c.json({
    running: currentRun()?.id ?? null,
    lastRun: lastRun ?? null,
    nextRuns: job?.nextRuns(3).map((d) => d.toISOString()) ?? [],
    bambooSubdomain: env().BAMBOO_SUBDOMAIN ?? null,
    googleAdmin: env().GOOGLE_ADMIN ?? null,
    configured: REQUIRED.every((k) => env()[k]),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    branding: { appName: s.appName, logoUrl: s.logoUrl, accentColor: s.accentColor, supportContact: s.supportContact },
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, Boolean(process.env[k]?.trim())])),
  });
});

app.get("/api/credentials", (c) => c.json(credentials()));

/** Write-only: send a value to set it, "" to remove it. Values set by env vars can't be changed here. */
app.put("/api/credentials", async (c) => {
  const input = await c.req.json<Record<string, unknown>>();
  const changes: Partial<Record<SecretKey, string>> = {};
  for (const [k, v] of Object.entries(input)) {
    const key = SECRET_KEYS.find((x) => x === k);
    if (!key || typeof v !== "string") return c.json({ error: `Unknown credential ${k}` }, 400);
    if (credentialSource(key) === "env") return c.json({ error: `${key} is set by an environment variable; change it there` }, 409);
    try {
      changes[key] = v.trim() ? validateCredential(key, v) : "";
    } catch (err) {
      return c.json({ error: err instanceof z.ZodError ? err.issues[0]!.message : (err as Error).message }, 400);
    }
  }
  saveSecrets(changes);
  resetEnv();
  return c.json(credentials());
});

/** Live round-trip to each API, with latency. */
app.get("/api/connections", async (c) => {
  const check = async (name: string, fn: () => Promise<string>) => {
    const started = performance.now();
    try {
      return { name, ok: true, detail: await fn(), ms: Math.round(performance.now() - started) };
    } catch (err) {
      return { name, ok: false, detail: (err as Error).message.slice(0, 300), ms: Math.round(performance.now() - started) };
    }
  };
  return c.json(await Promise.all([check("BambooHR API", bamboo.ping), check("Google Directory API", google.ping)]));
});

app.post("/api/sync", async (c) => {
  const body = await c.req.json<{ dryRun?: boolean; employeeId?: string }>().catch(() => ({}) as never);
  const employeeId = body.employeeId?.trim() || undefined;
  if (employeeId && !/^\d+$/.test(employeeId)) return c.json({ error: "Employee ID must be numeric" }, 400);
  try {
    const run = startSync({ dryRun: body.dryRun !== false, trigger: "ui", employeeId });
    return c.json({ id: run.id }, 202);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
});

app.get("/api/runs", async (c) => c.json(await listRuns(Number(c.req.query("limit") ?? 50))));

app.get("/api/runs/:id", async (c) => {
  const run = await getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Not found" }, 404);
  const { done: _, ...data } = run;
  return c.json(data);
});

/** Sends a test message so the webhook can be checked from the UI. */
app.post("/api/notifications/test", async (c) => {
  const s = await loadSettings();
  try {
    await postSlack({ text: `:white_check_mark: *${s.appName}*: test notification. Alerts for ${s.notifyOn === "always" ? "every run" : s.notifyOn === "off" ? "runs are turned off" : "failed runs"} will arrive here.` });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get("/api/settings", async (c) => c.json(await loadSettings()));

app.put("/api/settings", async (c) => {
  const input = await c.req.json<Partial<Settings>>();
  if (input.schedule) {
    try {
      new Cron(input.schedule, { paused: true }).stop();
    } catch {
      return c.json({ error: `Invalid cron expression: ${input.schedule}` }, 400);
    }
  }
  const settings = await saveSettings(input);
  schedule(settings);
  return c.json(settings);
});

schedule(await loadSettings());
serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => console.log(`Listening on http://localhost:${port}`));
