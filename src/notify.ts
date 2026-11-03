import { env, type Settings } from "./config.js";
import type { Run } from "./sync.js";

type NotifySettings = Pick<Settings, "notifyOn" | "appName" | "publicUrl">;

/** Why a run deserves an alert, or undefined when it doesn't. */
export function alertReason(run: Run, s: NotifySettings): string | undefined {
  if (s.notifyOn === "off") return undefined;
  const blocked = run.actions.filter((a) => a.reason?.startsWith("Blocked")).length;
  if (run.status === "failed") return "Sync failed";
  if (run.status === "partial") return `${run.counts.errors} action${run.counts.errors === 1 ? "" : "s"} failed`;
  if (blocked) return `${blocked} suspension${blocked === 1 ? "" : "s"} blocked by the safety limit`;
  if (s.notifyOn === "always") return "Sync finished";
  return undefined;
}

/** Slack Incoming Webhook payload (https://api.slack.com/messaging/webhooks). */
export function slackMessage(run: Run, s: NotifySettings, reason: string) {
  const ok = run.status === "success" && !run.actions.some((a) => a.reason?.startsWith("Blocked"));
  const link = s.publicUrl ? `${s.publicUrl.replace(/\/+$/, "")}/#/runs/${run.id}` : "";
  const c = run.counts;
  const lines = [
    `*${ok ? ":white_check_mark:" : ":rotating_light:"} ${s.appName}: ${reason}*`,
    `${run.dryRun ? "Preview" : "Live"} run · ${run.trigger}${run.employeeId ? ` · employee ${run.employeeId}` : ""} · ${run.status}` +
      (run.durationMs !== undefined ? ` · ${(run.durationMs / 1000).toFixed(1)} s` : ""),
  ];
  if (run.status !== "failed") lines.push(`${c.create} create · ${c.update} update · ${c.suspend} suspend · ${c.skip} skip · ${c.errors} errors`);
  if (run.error) lines.push("```" + run.error.slice(0, 500) + "```");
  const problems = run.actions.filter((a) => a.status === "error" || a.reason?.startsWith("Blocked"));
  for (const a of problems.slice(0, 5)) lines.push(`• ${a.type} ${a.email}: ${(a.error ?? a.reason ?? "").slice(0, 200)}`);
  if (problems.length > 5) lines.push(`…and ${problems.length - 5} more`);
  lines.push(link ? `<${link}|View run ${run.id}>` : `Run ${run.id}`);
  return { text: lines.join("\n") };
}

/** Slack answers "ok" as plain text. Errors never include the URL, which is a secret. */
export async function postSlack(payload: { text: string }) {
  const url = env().SLACK_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_WEBHOOK_URL is not set");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Slack returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Best-effort: a broken webhook must never fail the run itself.
 * Without settings (they failed to load) failures are still reported.
 */
export async function notifyRun(run: Run, settings?: Settings): Promise<string | undefined> {
  const s = settings ?? { notifyOn: "failures", appName: process.env.APP_NAME || "Directory Sync", publicUrl: process.env.PUBLIC_URL ?? "" };
  const reason = alertReason(run, s);
  if (!reason || !env().SLACK_WEBHOOK_URL) return undefined;
  try {
    await postSlack(slackMessage(run, s, reason));
    return `Slack notified: ${reason}`;
  } catch (err) {
    return `Slack notification failed: ${(err as Error).message.slice(0, 300)}`;
  }
}
