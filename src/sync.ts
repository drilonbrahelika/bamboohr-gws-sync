import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchEmployee, fetchEmployees } from "./bamboo.js";
import { env, loadSettings, need, type Settings } from "./config.js";
import * as google from "./google.js";
import { HttpError, mapLimit, retryListeners } from "./http.js";
import { notifyRun } from "./notify.js";
import { buildPlan, type Action, type ActionType } from "./plan.js";

export interface ActionResult extends Omit<Action, "body"> {
  status: "planned" | "done" | "error" | "skipped";
  error?: string;
  log?: string[];
  /** The Directory API call this action makes (password never included). */
  request?: { method: string; path: string; body: Record<string, unknown> };
  ms?: number;
}

export interface RunStep {
  name: string;
  detail: string;
  ms: number;
}

export interface RunEvent {
  t: string;
  level: "info" | "warn" | "error" | "ok";
  msg: string;
}

export interface Run {
  id: string;
  trigger: "ui" | "schedule" | "cli";
  dryRun: boolean;
  employeeId?: string;
  status: "running" | "success" | "partial" | "failed";
  startedAt: string;
  finishedAt?: string;
  counts: Record<ActionType | "employees" | "googleUsers" | "errors", number>;
  actions: ActionResult[];
  steps: RunStep[];
  events: RunEvent[];
  durationMs?: number;
  error?: string;
  /** Resolves when the run finishes (not persisted). */
  done?: Promise<Run>;
}

const KEEP_RUNS = 200;
const runsDir = () => join(env().DATA_DIR, "runs");
const log = (msg: string, extra: object = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

let current: Run | undefined;
export const currentRun = () => current;

const errorText = (err: unknown) =>
  err instanceof HttpError ? `HTTP ${err.status}: ${err.body.slice(0, 300)}` : String((err as Error)?.message ?? err);

/** Start a run. Only one run at a time; throws if one is in progress. */
export function startSync(opts: { dryRun: boolean; trigger: Run["trigger"]; employeeId?: string }): Run {
  if (current) throw new Error(`Run ${current.id} is already in progress`);
  const run: Run = {
    id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    trigger: opts.trigger,
    dryRun: opts.dryRun,
    employeeId: opts.employeeId,
    status: "running",
    startedAt: new Date().toISOString(),
    counts: { employees: 0, googleUsers: 0, create: 0, update: 0, suspend: 0, skip: 0, errors: 0 },
    actions: [],
    steps: [],
    events: [],
  };
  current = run;
  run.done = execute(run).finally(() => (current = undefined));
  return run;
}

const MAX_EVENTS = 2000;
function event(run: Run, level: RunEvent["level"], msg: string) {
  if (run.events.length < MAX_EVENTS) run.events.push({ t: new Date().toISOString(), level, msg });
}

/** Time a pipeline stage and record it on the run. */
async function step<T>(run: Run, name: string, fn: () => Promise<T>, detail: (r: T) => string): Promise<T> {
  const started = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - started);
  run.steps.push({ name, detail: detail(result), ms });
  event(run, "info", `${name}: ${detail(result)} (${ms} ms)`);
  return result;
}

async function execute(run: Run): Promise<Run> {
  log("sync started", { run: run.id, dryRun: run.dryRun, employeeId: run.employeeId });
  const started = performance.now();
  const onRetry = (r: { url: string; status: number; delayMs: number }) =>
    event(run, "warn", `${new URL(r.url).host} returned ${r.status || "network error"}, retrying in ${r.delayMs} ms`);
  retryListeners.add(onRetry);
  event(run, "info", `run started (${run.dryRun ? "preview" : "live"}, ${run.trigger}${run.employeeId ? `, employee ${run.employeeId}` : ""})`);
  let loaded: Settings | undefined;
  try {
    const settings = (loaded = await loadSettings());
    const extraFields = Object.values(settings.customFields);
    let employees, users;
    if (run.employeeId) {
      const e = await step(run, "Fetch BambooHR", () => fetchEmployee(run.employeeId!, extraFields), () => "1 employee");
      const u = await step(
        run,
        "Fetch Google",
        () => google.findUser(e.id, e.workEmail ?? null, settings.customSchema),
        (u) => (u ? `found ${u.primaryEmail}` : "no matching user"),
      );
      [employees, users] = [[e], u ? [u] : []];
    } else {
      [employees, users] = await Promise.all([
        step(run, "Fetch BambooHR", () => fetchEmployees(extraFields), (r) => `${r.length} employees`),
        step(run, "Fetch Google", () => google.listUsers(settings.customSchema), (r) => `${r.length} users`),
      ]);
      if (!employees.length) throw new Error("BambooHR returned no employees; refusing to sync");
    }
    run.counts.employees = employees.length;
    run.counts.googleUsers = users.length;

    const plan = await step(
      run,
      "Plan",
      async () => buildPlan(employees, users, { settings, adminEmail: need("GOOGLE_ADMIN"), fullDirectory: !run.employeeId }),
      (p) => {
        const c = (t: string) => p.filter((a) => a.type === t).length;
        return `${c("create")} create · ${c("update")} update · ${c("suspend")} suspend · ${c("skip")} skip`;
      },
    );
    for (const a of plan) run.counts[a.type]++;

    run.actions = await step(
      run,
      run.dryRun ? "Preview" : "Apply",
      () => mapLimit(plan, settings.concurrency, (a) => apply(run, a, settings)),
      (r) => {
        const failed = r.filter((a) => a.status === "error").length;
        return run.dryRun ? `${r.length} actions planned` : `${r.length - failed} ok · ${failed} failed · concurrency ${settings.concurrency}`;
      },
    );
    run.counts.errors = run.actions.filter((a) => a.status === "error").length;
    run.status = run.counts.errors ? "partial" : "success";
  } catch (err) {
    run.status = "failed";
    run.error = errorText(err);
    event(run, "error", run.error);
  } finally {
    retryListeners.delete(onRetry);
  }
  run.durationMs = Math.round(performance.now() - started);
  run.finishedAt = new Date().toISOString();
  event(run, run.status === "failed" ? "error" : "info", `run finished: ${run.status} in ${run.durationMs} ms`);
  log("sync finished", { run: run.id, status: run.status, counts: run.counts, error: run.error });
  const notified = await notifyRun(run, loaded);
  if (notified) event(run, notified.startsWith("Slack notification failed") ? "warn" : "info", notified);
  await saveRun(run);
  return run;
}

function requestFor(action: Action): ActionResult["request"] {
  if (!action.body) return undefined;
  return action.type === "create"
    ? { method: "POST", path: "/admin/directory/v1/users", body: action.body }
    : { method: "PUT", path: `/admin/directory/v1/users/${action.userKey}`, body: action.body };
}

async function apply(run: Run, action: Action, s: Settings): Promise<ActionResult> {
  const { body, ...rest } = action;
  const result: ActionResult = { ...rest, status: run.dryRun ? "planned" : "done", log: [], request: requestFor(action) };
  if (action.type === "skip") return { ...result, status: "skipped" };
  if (run.dryRun) return result;
  const started = performance.now();
  try {
    if (action.type === "create") {
      const password = env().INITIAL_PASSWORD ?? randomBytes(18).toString("base64url");
      await google.insertUser({ ...body, password });
    } else {
      await google.updateUser(action.userKey!, body!);
    }
    if (action.type === "suspend") await cleanupSuspended(action.userKey!, s, result.log!);
  } catch (err) {
    if (action.type === "create" && err instanceof HttpError && err.status === 409) {
      // Google's user listing lags writes by seconds; the account was created moments ago.
      result.status = "skipped";
      result.reason = "Already exists in Google (created by a recent run); it is linked on the next run";
    } else {
      result.status = "error";
      result.error = errorText(err);
    }
  }
  result.ms = Math.round(performance.now() - started);
  event(
    run,
    result.status === "error" ? "error" : "ok",
    `${action.type} ${action.email}${result.error ? `: ${result.error}` : ""}${result.log?.length ? ` (${result.log.join("; ")})` : ""}`,
  );
  log(`${action.type} ${result.status}`, { email: action.email, employeeId: action.employeeId, error: result.error });
  return result;
}

/** Remove direct group memberships and revoke licences. Each step is best-effort. */
async function cleanupSuspended(userKey: string, s: Settings, out: string[]) {
  const groups = await google.listUserGroups(userKey).catch((err) => {
    out.push(`list groups failed: ${errorText(err)}`);
    return [];
  });
  for (const g of groups) {
    try {
      await google.removeMember(g.id, userKey);
      out.push(`removed from ${g.email}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      // 404: no longer a member; 412: dynamic group, membership follows automatically.
      out.push(status === 404 || status === 412 ? `left in ${g.email} (${status})` : `group ${g.email}: ${errorText(err)}`);
    }
  }
  for (const sku of s.licenseSkus) {
    try {
      await google.revokeLicense(s.licenseProductId, sku, userKey);
      out.push(`revoked licence ${sku}`);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) out.push(`licence ${sku}: ${errorText(err)}`);
    }
  }
}

async function saveRun(run: Run) {
  await mkdir(runsDir(), { recursive: true });
  const { done: _, ...data } = run;
  await writeFile(join(runsDir(), `${run.id}.json`), JSON.stringify(data));
  const files = (await readdir(runsDir())).filter((f) => f.endsWith(".json")).sort();
  await Promise.all(files.slice(0, -KEEP_RUNS).map((f) => unlink(join(runsDir(), f))));
}

export async function listRuns(limit = 50): Promise<Omit<Run, "actions">[]> {
  const files = (await readdir(runsDir()).catch(() => [])).filter((f) => f.endsWith(".json")).sort().reverse();
  const runs = await Promise.all(files.slice(0, limit).map((f) => getRun(f.slice(0, -5))));
  return runs.filter((r): r is Run => !!r).map(({ actions: _, ...r }) => r);
}

export async function getRun(id: string): Promise<Run | undefined> {
  if (current?.id === id) return current;
  if (!/^[\w-]+$/.test(id)) return undefined;
  return readFile(join(runsDir(), `${id}.json`), "utf8").then(JSON.parse, () => undefined);
}

