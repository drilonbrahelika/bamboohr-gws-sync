import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
  JWT: class {
    getAccessToken = async () => ({ token: "test-token" });
  },
}));

Object.assign(process.env, {
  BAMBOO_SUBDOMAIN: "acme",
  BAMBOO_API_KEY: "key",
  GOOGLE_ADMIN: "admin@acme.com",
  GOOGLE_CREDENTIALS: JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "k" }),
  DATA_DIR: mkdtempSync(join(tmpdir(), "sync-test-")),
  CUSTOM_SCHEMA: "",
  RECOVERY_EMAIL: "recovery@acme.com",
  LICENSE_SKUS: "sku-a,sku-b",
  NEW_USER_OU: "/Joiners",
  SUSPENDED_OU: "/Leavers",
});

const employees = [
  { id: "1", status: "Active", workEmail: "new@acme.com", firstName: "New", lastName: "Hire" },
  { id: "2", status: "Active", workEmail: "stay@acme.com", firstName: "Stay", lastName: "Er", jobTitle: "CEO" },
  { id: "3", status: "Inactive", workEmail: "leaver@acme.com", firstName: "Lea", lastName: "Ver" },
];
const googleUsers = [
  { id: "g2", primaryEmail: "stay@acme.com", name: { givenName: "Stay", familyName: "Er" }, externalIds: [{ type: "organization", value: "2" }] },
  { id: "g3", primaryEmail: "leaver@acme.com", name: { givenName: "Lea", familyName: "Ver" }, externalIds: [{ type: "organization", value: "3" }] },
];

const calls: { method: string; url: string; body?: any }[] = [];
let bambooAttempts = 0;

function fakeFetch(input: string | URL, init: RequestInit = {}) {
  const url = String(input);
  const method = init.method ?? "GET";
  calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  if (url.includes("bamboohr.com")) {
    expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from("key:x").toString("base64")}`);
    // First call is rate-limited, as BambooHR does with 503.
    if (bambooAttempts++ === 0) return new Response("slow down", { status: 503, headers: { "Retry-After": "0" } });
    return json({ employees });
  }
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
  if (method === "GET" && url.includes("/directory/v1/users?")) return json({ users: googleUsers });
  if (method === "GET" && url.includes("/directory/v1/groups?")) {
    return json({ groups: [{ id: "grp1", email: "team@acme.com" }, { id: "grp2", email: "dynamic@acme.com" }] });
  }
  if (method === "DELETE" && url.includes("/groups/grp2/")) return json({ error: "auto-managed" }, 412);
  if (method === "DELETE" && url.includes("/sku/sku-b/")) return json({ error: "not found" }, 404);
  if (method === "DELETE") return new Response(null, { status: 204 });
  return json({ id: "ok" });
}

describe("sync run against fake BambooHR and Google", () => {
  let run: Awaited<ReturnType<typeof import("../src/sync.js")["startSync"]>>;

  beforeAll(async () => {
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    const { startSync } = await import("../src/sync.js");
    run = await startSync({ dryRun: false, trigger: "cli" }).done!;
  });

  it("finishes cleanly with the expected counts", () => {
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("success");
    expect(run.counts).toMatchObject({ employees: 3, googleUsers: 2, create: 1, update: 1, suspend: 1, errors: 0 });
  });

  it("retries BambooHR after a 503", () => {
    expect(calls.filter((c) => c.url.includes("bamboohr.com/")).length).toBe(2);
    expect(calls[0]!.url).toBe("https://api.bamboohr.com/api/gateway.php/acme/v1/reports/custom?format=JSON&onlyCurrent=false");
  });

  it("creates the new hire with a random password", () => {
    const insert = calls.find((c) => c.method === "POST" && c.url.endsWith("/directory/v1/users"));
    expect(insert?.body).toMatchObject({ primaryEmail: "new@acme.com", orgUnitPath: "/Joiners" });
    expect(insert?.body.password).toMatch(/^[\w-]{24}$/);
  });

  it("updates changed users in place", () => {
    const update = calls.find((c) => c.method === "PUT" && c.url.endsWith("/users/g2"));
    expect(update?.body.organizations).toEqual([{ title: "CEO", primary: true }]);
  });

  it("suspends leavers, removes groups and revokes licences", () => {
    const suspend = calls.find((c) => c.method === "PUT" && c.url.endsWith("/users/g3"));
    expect(suspend?.body).toMatchObject({ suspended: true, orgUnitPath: "/Leavers", recoveryEmail: "recovery+lea.ver@acme.com" });
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url.replace(/^https:\/\/[^/]+/, ""));
    expect(deletes).toEqual([
      "/admin/directory/v1/groups/grp1/members/g3",
      "/admin/directory/v1/groups/grp2/members/g3",
      "/apps/licensing/v1/product/Google-Apps/sku/sku-a/user/g3",
      "/apps/licensing/v1/product/Google-Apps/sku/sku-b/user/g3",
    ]);
    const leaver = run.actions.find((a) => a.type === "suspend");
    expect(leaver?.log).toEqual(["removed from team@acme.com", "left in dynamic@acme.com (412)", "revoked licence sku-a"]);
  });

  it("persists the run for the UI", async () => {
    const { getRun, listRuns } = await import("../src/sync.js");
    expect((await getRun(run.id))?.actions.length).toBe(3);
    expect((await listRuns())[0]?.id).toBe(run.id);
  });
});
