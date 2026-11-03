/**
 * Edge cases run end to end through the real sync engine against a simulated
 * BambooHR and a stateful simulated Google Workspace (users, groups, licences).
 * Each case starts from a clean directory, applies a live run, and checks what Google ends up with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("google-auth-library", () => ({
  JWT: class {
    getAccessToken = async () => ({ token: "test-token" });
  },
}));

const DATA_DIR = mkdtempSync(join(tmpdir(), "edge-"));
Object.assign(process.env, {
  BAMBOO_SUBDOMAIN: "acme",
  BAMBOO_API_KEY: "good-key",
  GOOGLE_ADMIN: "admin@acme.com",
  GOOGLE_CREDENTIALS: JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "k" }),
  SLACK_WEBHOOK_URL: "https://hooks.slack.test/T/B/x",
  DATA_DIR,
  NEW_USER_OU: "/New",
  SUSPENDED_OU: "/Leavers",
  PROTECTED_OUS: "/Protected",
  RECOVERY_EMAIL: "recovery@acme.com",
  LICENSE_SKUS: "sku-a",
  CUSTOM_SCHEMA: "",
});

type Emp = Record<string, string | null> & { id: string };
type User = Record<string, any> & { id: string; primaryEmail: string };

const OWNED_DOMAINS = ["acme.com"];
let employees: Emp[] = [];
let users: User[] = [];
let groups: Record<string, string[]> = {}; // group email -> member user ids
let licences: Record<string, string[]> = {}; // user id -> skus
let slack: string[] = [];
let writes: { method: string; path: string; body?: any }[] = [];
let nextId = 1;

const emp = (id: string, o: Partial<Emp> = {}): Emp => ({
  id,
  status: "Active",
  firstName: `First${id}`,
  lastName: `Last${id}`,
  workEmail: `user${id}@acme.com`,
  jobTitle: "Engineer",
  department: "R&D",
  ...o,
});
const gUser = (id: string, o: Partial<User> = {}): User => ({
  id,
  primaryEmail: `user${id.slice(1)}@acme.com`,
  suspended: false,
  orgUnitPath: "/",
  name: { givenName: `First${id.slice(1)}`, familyName: `Last${id.slice(1)}` },
  emails: [{ address: `user${id.slice(1)}@acme.com`, primary: true }],
  organizations: [{ title: "Engineer", department: "R&D", primary: true }],
  externalIds: [{ type: "organization", value: id.slice(1) }],
  ...o,
});
const admin = () => gUser("g0", { primaryEmail: "admin@acme.com", externalIds: [], emails: [{ address: "admin@acme.com", primary: true }] });
const find = (key: string) => users.find((u) => u.id === key || u.primaryEmail === key || u.aliases?.includes(key));

function fakeFetch(input: string | URL, init: RequestInit = {}) {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const path = decodeURIComponent(url.pathname);

  if (url.host === "hooks.slack.test") {
    slack.push(body.text);
    return new Response("ok");
  }
  if (url.host === "api.bamboohr.com") {
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== `Basic ${Buffer.from(`${process.env.BAMBOO_API_KEY === "good-key" ? "good-key" : "?"}:x`).toString("base64")}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (path.endsWith("/reports/custom")) return json({ employees });
    const one = employees.find((e) => path.endsWith(`/employees/${e.id}`));
    return one ? json(one) : json({}, 404);
  }

  if (method !== "GET") writes.push({ method, path, body });
  if (path === "/admin/directory/v1/users" && method === "GET") {
    const q = url.searchParams.get("query");
    const list = q ? users.filter((u) => u.externalIds?.some((x: any) => `externalId=${x.value}` === q)) : users;
    return json({ users: structuredClone(list) });
  }
  if (path === "/admin/directory/v1/users" && method === "POST") {
    const domain = body.primaryEmail.split("@")[1];
    if (!OWNED_DOMAINS.includes(domain)) return json({ error: { code: 403, message: "Not Authorized to access this resource/api" } }, 403);
    if (find(body.primaryEmail)) return json({ error: { code: 409, message: "Entity already exists." } }, 409);
    const { password: _, ...rest } = body;
    const u = { id: `n${nextId++}`, suspended: false, ...rest };
    users.push(u);
    return json(u);
  }
  const userPath = path.match(/^\/admin\/directory\/v1\/users\/(.+)$/);
  if (userPath) {
    const u = find(userPath[1]!);
    if (!u) return json({ error: { code: 404 } }, 404);
    if (method === "GET") return json(u);
    // Patch semantics: given fields replace, null clears. A rename keeps the old address as an alias, like Google.
    if (body.primaryEmail && body.primaryEmail !== u.primaryEmail) u.aliases = [...(u.aliases ?? []), u.primaryEmail];
    for (const [k, v] of Object.entries(body)) v === null ? delete u[k] : (u[k] = v);
    return json(u);
  }
  if (path === "/admin/directory/v1/groups") {
    const id = find(url.searchParams.get("userKey")!)?.id;
    return json({ groups: Object.entries(groups).filter(([, m]) => m.includes(id!)).map(([g]) => ({ id: g, email: g })) });
  }
  const member = path.match(/^\/admin\/directory\/v1\/groups\/(.+)\/members\/(.+)$/);
  if (member && method === "DELETE") {
    groups[member[1]!] = (groups[member[1]!] ?? []).filter((m) => m !== member[2]);
    return new Response(null, { status: 204 });
  }
  const lic = path.match(/^\/apps\/licensing\/v1\/product\/[^/]+\/sku\/([^/]+)\/user\/(.+)$/);
  if (lic && method === "DELETE") {
    const [, sku, user] = lic;
    if (!licences[user!]?.includes(sku!)) return json({ error: { code: 404 } }, 404);
    licences[user!] = licences[user!]!.filter((s) => s !== sku);
    return new Response(null, { status: 204 });
  }
  return json({ error: `unhandled ${method} ${path}` }, 500);
}
vi.stubGlobal("fetch", vi.fn(fakeFetch));

const sync = async (dryRun = false, employeeId?: string) => {
  const { startSync } = await import("../src/sync.js");
  return startSync({ dryRun, trigger: "cli", employeeId }).done!;
};
const setSettings = async (s: object) => (await import("../src/config.js")).saveSettings(s);
const action = (run: Awaited<ReturnType<typeof sync>>, email: string) => run.actions.find((a) => a.email === email);
const user = (email: string) => find(email)!;

beforeEach(() => {
  rmSync(join(DATA_DIR, "settings.json"), { force: true });
  employees = [emp("1")];
  users = [admin(), gUser("g1")];
  groups = {};
  licences = {};
  slack = [];
  writes = [];
  process.env.BAMBOO_API_KEY = "good-key";
});

describe("joiners", () => {
  it("1. active employee with no Google user is created in the new-user OU", async () => {
    employees.push(emp("2"));
    const run = await sync();
    expect(action(run, "user2@acme.com")).toMatchObject({ type: "create", status: "done" });
    const post = writes.find((w) => w.method === "POST")!;
    expect(post.body).toMatchObject({ primaryEmail: "user2@acme.com", orgUnitPath: "/New", changePasswordAtNextLogin: true });
    expect(post.body.password).toBeTruthy();
    expect(user("user2@acme.com").externalIds).toEqual([{ value: "2", type: "organization" }]);
  });

  it("2. active employee without a work email is skipped", async () => {
    employees.push(emp("2", { workEmail: null }));
    const run = await sync();
    expect(run.actions.find((a) => a.employeeId === "2")).toMatchObject({ type: "skip", reason: "No work email in BambooHR" });
    expect(writes).toEqual([]);
  });

  it("3. employee on a domain the Workspace doesn't use is skipped, not failed", async () => {
    employees.push(emp("2", { workEmail: "sam@sample-company.com" }));
    const run = await sync();
    expect(action(run, "sam@sample-company.com")?.reason).toMatch(/isn't used in this Google Workspace/);
    expect(run.status).toBe("success");
    expect(writes).toEqual([]);
  });

  it("4. future hire (Active, start date ahead) is created right away", async () => {
    employees.push(emp("2", { hireDate: "2099-01-01" }));
    const run = await sync();
    expect(action(run, "user2@acme.com")).toMatchObject({ type: "create", status: "done" });
  });

  it("5. a manually created Google user is linked by email, not duplicated", async () => {
    users.push(gUser("g7", { primaryEmail: "user2@acme.com", externalIds: [], emails: [{ address: "user2@acme.com", primary: true }], name: { givenName: "First2", familyName: "Last2" } }));
    employees.push(emp("2"));
    const run = await sync();
    expect(action(run, "user2@acme.com")).toMatchObject({ type: "update", status: "done" });
    expect(writes.filter((w) => w.method === "POST")).toEqual([]);
    expect(user("user2@acme.com").externalIds).toEqual([{ value: "2", type: "organization" }]);
    expect(users.filter((u) => u.primaryEmail === "user2@acme.com")).toHaveLength(1);
  });
});

describe("changes", () => {
  it("6. title, department and preferred name changes update only those fields", async () => {
    employees = [emp("1", { jobTitle: "Lead", department: "Platform", preferredName: "Al" })];
    const run = await sync();
    expect(action(run, "user1@acme.com")?.diff?.map((d) => d.field).sort()).toEqual(["name", "organizations"]);
    expect(user("user1@acme.com")).toMatchObject({ name: { givenName: "Al" }, organizations: [{ title: "Lead", department: "Platform" }] });
  });

  it("7. setting a manager adds the manager relation", async () => {
    employees = [emp("1", { supervisorEmail: "Boss@acme.com" })];
    await sync();
    expect(user("user1@acme.com").relations).toEqual([{ value: "boss@acme.com", type: "manager" }]);
  });

  it("8. a work email change renames the user and keeps the old address as an alias", async () => {
    employees = [emp("1", { workEmail: "renamed@acme.com" })];
    const run = await sync();
    expect(run.actions[0]).toMatchObject({ type: "update", status: "done" });
    expect(user("renamed@acme.com")).toMatchObject({ id: "g1", primaryEmail: "renamed@acme.com", aliases: ["user1@acme.com"] });
  });

  it("9. fields BambooHR doesn't own are never touched", async () => {
    user("user1@acme.com").phones = [{ value: "+1 555", type: "work" }];
    const run = await sync();
    expect(run.actions).toEqual([]);
    expect(writes).toEqual([]);
    employees = [emp("1", { jobTitle: "Lead" })];
    await sync();
    expect(writes.every((w) => !("phones" in (w.body ?? {})))).toBe(true);
    expect(user("user1@acme.com").phones).toEqual([{ value: "+1 555", type: "work" }]);
  });
});

describe("leavers", () => {
  it("10. inactive employee is suspended, moved, removed from groups and unlicensed", async () => {
    employees = [emp("1", { status: "Inactive" })];
    groups = { "team@acme.com": ["g1"], "all@acme.com": ["g1"] };
    licences = { g1: ["sku-a"] };
    const run = await sync();
    expect(run.actions[0]).toMatchObject({ type: "suspend", status: "done" });
    expect(user("user1@acme.com")).toMatchObject({ suspended: true, orgUnitPath: "/Leavers", recoveryEmail: "recovery+first1.last1@acme.com" });
    expect(groups).toEqual({ "team@acme.com": [], "all@acme.com": [] });
    expect(licences.g1).toEqual([]);
  });

  it("11. inactive employee in a protected OU is not suspended", async () => {
    user("user1@acme.com").orgUnitPath = "/Protected";
    employees = [emp("1", { status: "Inactive" })];
    const run = await sync();
    expect(run.actions[0]?.reason).toMatch(/protected OU/);
    expect(user("user1@acme.com").suspended).toBe(false);
  });

  it("12. employee deleted from BambooHR gets their Google user suspended", async () => {
    users.push(gUser("g2"));
    employees = [emp("1")];
    const run = await sync();
    expect(action(run, "user2@acme.com")).toMatchObject({ type: "suspend", reason: "Employee no longer exists in BambooHR" });
    expect(user("user2@acme.com").suspended).toBe(true);
  });

  it("13. a rehire stays suspended unless reactivation is on", async () => {
    Object.assign(user("user1@acme.com"), { suspended: true, orgUnitPath: "/Leavers" });
    let run = await sync();
    expect(run.actions[0]?.reason).toMatch(/not reactivating/);
    expect(user("user1@acme.com").suspended).toBe(true);

    await setSettings({ reactivateSuspended: true });
    run = await sync();
    expect(user("user1@acme.com").suspended).toBe(false);
  });

  it("14. the Google admin is never suspended", async () => {
    employees = [emp("1"), emp("0", { workEmail: "admin@acme.com", status: "Inactive" })];
    const run = await sync();
    expect(run.actions.some((a) => a.type === "suspend")).toBe(false);
    expect(user("admin@acme.com").suspended).toBe(false);
  });
});

describe("safety and alerts", () => {
  it("15. too many suspensions are all blocked and Slack is alerted", async () => {
    await setSettings({ maxSuspensionsPerRun: 1 });
    users.push(gUser("g2"));
    employees = [emp("1", { status: "Inactive" }), emp("2", { status: "Inactive" })];
    const run = await sync();
    expect(run.actions.map((a) => a.reason)).toEqual([expect.stringMatching(/^Blocked: 2 suspensions/), expect.stringMatching(/^Blocked/)]);
    expect(users.some((u) => u.suspended)).toBe(false);
    expect(slack[0]).toMatch(/2 suspensions blocked by the safety limit/);
  });

  it("16. a wrong BambooHR key fails the run, changes nothing and alerts Slack", async () => {
    process.env.BAMBOO_API_KEY = "wrong-key";
    (await import("../src/config.js")).resetEnv();
    const run = await sync();
    (await import("../src/config.js")).resetEnv();
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/HTTP 401/);
    expect(writes).toEqual([]);
    expect(slack[0]).toMatch(/Sync failed/);
  });

  it("17. a second run while one is in progress is refused", async () => {
    const { startSync } = await import("../src/sync.js");
    const first = startSync({ dryRun: true, trigger: "ui" });
    expect(() => startSync({ dryRun: true, trigger: "ui" })).toThrow(/already in progress/);
    await first.done;
  });

  it("18. a preview right after a live run shows no changes", async () => {
    employees = [
      emp("1", { jobTitle: "Lead", supervisorEmail: "admin@acme.com", homeEmail: "me@home.test", country: "Germany" }),
      emp("2", { preferredName: "Bo" }),
      emp("3", { status: "Inactive" }),
    ];
    users.push(gUser("g3"));
    await sync();
    const again = await sync(true);
    expect(again.actions.filter((a) => a.type !== "skip")).toEqual([]);
    expect(again.status).toBe("success");
  });
});

describe("worth checking in your data", () => {
  it("19. two employees with the same work email never steal each other's Google user", async () => {
    employees = [emp("1"), emp("2", { workEmail: "user1@acme.com" })];
    let run = await sync();
    expect(run.actions).toEqual([expect.objectContaining({ employeeId: "2", type: "skip", reason: expect.stringMatching(/also used by another employee/) })]);
    expect(user("user1@acme.com").externalIds).toEqual([{ type: "organization", value: "1" }]);
    run = await sync(); // stable on the next run too
    expect(run.actions.map((a) => a.type)).toEqual(["skip"]);

    // Same email for two new joiners: one account, not a failed second create.
    employees = [emp("1"), emp("5", { workEmail: "dup@acme.com" }), emp("6", { workEmail: "dup@acme.com" })];
    run = await sync();
    expect(run.actions.map((a) => `${a.type}:${a.employeeId}`)).toEqual(["create:5", "skip:6"]);
    expect(run.status).toBe("success");
  });
});
