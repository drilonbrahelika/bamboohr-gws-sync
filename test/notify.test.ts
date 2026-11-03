import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/config.js";
import { alertReason, notifyRun, slackMessage } from "../src/notify.js";
import type { Run } from "../src/sync.js";

Object.assign(process.env, {
  BAMBOO_SUBDOMAIN: "acme",
  BAMBOO_API_KEY: "key",
  GOOGLE_ADMIN: "admin@acme.com",
  GOOGLE_CREDENTIALS: "{}",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/secret",
});

const s = { notifyOn: "failures", appName: "Acme Sync", publicUrl: "https://sync.acme.com/" } as Settings;
const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  trigger: "schedule",
  dryRun: false,
  status: "success",
  startedAt: "2026-01-01T00:00:00Z",
  counts: { employees: 3, googleUsers: 3, create: 1, update: 1, suspend: 0, skip: 0, errors: 0 },
  actions: [],
  steps: [],
  events: [],
  durationMs: 1200,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("alerts", () => {
  it("stays quiet on a clean run unless set to always", () => {
    expect(alertReason(run(), s)).toBeUndefined();
    expect(alertReason(run(), { ...s, notifyOn: "always" })).toBe("Sync finished");
  });

  it("alerts on failed, partial and blocked runs, never when off", () => {
    expect(alertReason(run({ status: "failed", error: "HTTP 401" }), s)).toBe("Sync failed");
    expect(alertReason(run({ status: "partial", counts: { ...run().counts, errors: 2 } }), s)).toBe("2 actions failed");
    const blocked = run({ actions: [{ type: "skip", email: "a@acme.com", name: "A", status: "skipped", reason: "Blocked: 12 suspensions exceed the limit of 10" }] });
    expect(alertReason(blocked, s)).toBe("1 suspension blocked by the safety limit");
    expect(alertReason(run({ status: "failed" }), { ...s, notifyOn: "off" })).toBeUndefined();
  });

  it("lists failed actions and links the run", () => {
    const r = run({
      status: "partial",
      counts: { ...run().counts, errors: 1 },
      actions: [{ type: "update", email: "b@acme.com", name: "B", status: "error", error: "HTTP 403: forbidden" }],
    });
    const { text } = slackMessage(r, s, "1 action failed");
    expect(text).toContain("Acme Sync: 1 action failed");
    expect(text).toContain("• update b@acme.com: HTTP 403: forbidden");
    expect(text).toContain("<https://sync.acme.com/#/runs/r1|View run r1>");
  });

  it("posts to the webhook on failure and swallows webhook errors", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    expect(await notifyRun(run({ status: "failed", error: "boom" }), s)).toBe("Slack notified: Sync failed");
    expect(fetch).toHaveBeenCalledWith("https://hooks.slack.com/services/T/B/secret", expect.objectContaining({ method: "POST" }));
    expect(await notifyRun(run(), s)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid_token", { status: 403 })));
    const result = await notifyRun(run({ status: "failed" }), s);
    expect(result).toBe("Slack notification failed: Slack returned 403: invalid_token");
    expect(result).not.toContain("secret");
  });
});
