import { describe, expect, it } from "vitest";
import type { Employee } from "../src/bamboo.js";
import type { Settings } from "../src/config.js";
import type { GoogleUser } from "../src/google.js";
import { buildPlan, desiredFields, recoveryEmail } from "../src/plan.js";

const settings: Settings = {
  appName: "Test",
  logoUrl: "",
  accentColor: "#4F8CFF",
  supportContact: "",
  newUserOu: "/New",
  suspendedOu: "/Suspended",
  protectedOus: ["/Protected"],
  managedDomains: [],
  recoveryEmail: "recovery@acme.com",
  licenseProductId: "Google-Apps",
  licenseSkus: ["1010020028"],
  customSchema: "Employee_Information",
  customFields: { Division: "division", Contract_Start_Date: "hireDate" },
  reactivateSuspended: false,
  suspendMissing: true,
  maxSuspensionsPerRun: 10,
  concurrency: 2,
  schedule: "",
  scheduleDryRun: false,
  notifyOn: "failures",
  publicUrl: "",
};
const ctx = { settings, adminEmail: "admin@acme.com", fullDirectory: true };

const emp = (o: Partial<Employee> = {}): Employee => ({
  id: "1",
  status: "Active",
  workEmail: "anna.smith@acme.com",
  homeEmail: "anna@home.com",
  firstName: "Anna",
  preferredName: null,
  lastName: "Smith",
  jobTitle: "Engineer",
  department: "R&D",
  division: "Tech",
  employmentHistoryStatus: "Full-Time",
  supervisorEmail: "boss@acme.com",
  hireDate: "2024-01-15",
  country: "Germany",
  ...o,
});

/** A Google user that already matches emp() exactly. */
const user = (o: Partial<GoogleUser> = {}): GoogleUser => ({
  id: "g1",
  primaryEmail: "anna.smith@acme.com",
  suspended: false,
  orgUnitPath: "/",
  name: { givenName: "Anna", familyName: "Smith" },
  emails: [{ address: "anna@home.com", type: "home" }, { address: "anna.smith@acme.com", primary: true }],
  relations: [{ value: "boss@acme.com", type: "manager" }],
  organizations: [{ title: "Engineer", department: "R&D", description: "Full-Time", primary: true }],
  externalIds: [{ value: "1", type: "organization" }],
  addresses: [{ type: "home", formatted: "Germany" }],
  customSchemas: { Employee_Information: { Division: "Tech", Contract_Start_Date: "2024-01-15" } },
  ...o,
});

describe("buildPlan", () => {
  it("does nothing when Google already matches BambooHR", () => {
    expect(buildPlan([emp()], [user()], ctx)).toEqual([]);
  });

  it("creates active employees missing from Google in the new-user OU", () => {
    const [a] = buildPlan([emp()], [], ctx);
    expect(a?.type).toBe("create");
    expect(a?.body).toMatchObject({ primaryEmail: "anna.smith@acme.com", orgUnitPath: "/New", changePasswordAtNextLogin: true });
    expect(a?.body).not.toHaveProperty("password");
    expect(a?.diff?.find((d) => d.field === "primaryEmail")).toEqual({ field: "primaryEmail", before: "—", after: "anna.smith@acme.com" });
  });

  it("keeps the current OU on suspension when no suspended OU is configured", () => {
    const s = { ...settings, suspendedOu: "" };
    const [a] = buildPlan([emp({ status: "Inactive" })], [user()], { ...ctx, settings: s });
    expect(a?.body).not.toHaveProperty("orgUnitPath");
    expect(a?.diff?.find((d) => d.field === "suspended")).toEqual({ field: "suspended", before: "false", after: "true" });
  });

  it("does not create inactive employees or ones in unmanaged domains", () => {
    expect(buildPlan([emp({ status: "Inactive" })], [], ctx)).toEqual([]);
    const s = { ...settings, managedDomains: ["other.com"] };
    expect(buildPlan([emp()], [], { ...ctx, settings: s })[0]?.type).toBe("skip");
  });

  it("without managed domains, only creates in domains the Workspace already uses", () => {
    const foreign = emp({ id: "9", workEmail: "sam@sample-company.com" });
    const plan = buildPlan([emp(), foreign], [], ctx);
    expect(plan.map((a) => a.type)).toEqual(["create", "skip"]);
    expect(plan[1]?.reason).toMatch(/sample-company\.com isn't used in this Google Workspace/);
    // Listing the domain explicitly allows it.
    const s = { ...settings, managedDomains: ["sample-company.com"] };
    expect(buildPlan([foreign], [], { ...ctx, settings: s })[0]?.type).toBe("create");
  });

  it("updates only the fields that changed", () => {
    const [a] = buildPlan([emp({ jobTitle: "Lead", preferredName: "Annie" })], [user()], ctx);
    expect(a?.type).toBe("update");
    expect(a?.diff?.map((d) => d.field).sort()).toEqual(["name", "organizations"]);
    expect(a?.diff?.find((d) => d.field === "organizations")).toEqual({
      field: "organizations",
      before: "Engineer · R&D · Full-Time",
      after: "Lead · R&D · Full-Time",
    });
    expect(a?.body?.name).toEqual({ givenName: "Annie", familyName: "Smith" });
  });

  it("links existing users by email and stamps the BambooHR id", () => {
    const [a] = buildPlan([emp()], [user({ externalIds: [] })], ctx);
    expect(a?.diff).toEqual([{ field: "externalIds", before: "—", after: "organization: 1" }]);
  });

  it("renames the primary email when the work email changes", () => {
    const [a] = buildPlan([emp({ workEmail: "anna.jones@acme.com" })], [user()], ctx);
    expect(a?.body?.primaryEmail).toBe("anna.jones@acme.com");
  });

  it("suspends terminated employees with recovery email and suspended OU", () => {
    const [a] = buildPlan([emp({ status: "Inactive" })], [user()], ctx);
    expect(a?.type).toBe("suspend");
    expect(a?.body).toMatchObject({ suspended: true, orgUnitPath: "/Suspended", recoveryEmail: "recovery+anna.smith@acme.com" });
  });

  it("never suspends protected-OU users or the admin", () => {
    expect(buildPlan([emp({ status: "Inactive" })], [user({ orgUnitPath: "/Protected" })], ctx)[0]?.type).toBe("skip");
    const admin = user({ primaryEmail: "admin@acme.com" });
    expect(buildPlan([emp({ status: "Inactive", workEmail: "admin@acme.com" })], [admin], ctx)).toEqual([]);
  });

  it("leaves suspended users in a protected OU alone", () => {
    expect(buildPlan([emp({ jobTitle: "X" })], [user({ suspended: true, orgUnitPath: "/Protected" })], ctx)).toEqual([]);
  });

  it("does not reactivate suspended users unless enabled", () => {
    const u = user({ suspended: true });
    expect(buildPlan([emp()], [u], ctx).map((a) => a.type)).toEqual(["skip"]);
    const s = { ...settings, reactivateSuspended: true };
    expect(buildPlan([emp()], [u], { ...ctx, settings: s })[0]?.body).toEqual({ suspended: false });
  });

  it("suspends users whose employee was deleted from BambooHR (full runs only)", () => {
    const orphan = user({ id: "g2", primaryEmail: "gone@acme.com", externalIds: [{ value: "99", type: "organization" }] });
    expect(buildPlan([emp()], [user(), orphan], ctx).map((a) => a.type)).toEqual(["suspend"]);
    expect(buildPlan([emp()], [user(), orphan], { ...ctx, fullDirectory: false })).toEqual([]);
  });

  it("blocks all suspensions above the safety limit", () => {
    const s = { ...settings, maxSuspensionsPerRun: 1 };
    const employees = [emp({ status: "Inactive" }), emp({ id: "2", workEmail: "b@acme.com", status: "Inactive" })];
    const users = [user(), user({ id: "g2", primaryEmail: "b@acme.com", externalIds: [{ value: "2", type: "organization" }] })];
    const plan = buildPlan(employees, users, { ...ctx, settings: s });
    expect(plan.every((a) => a.type === "skip" && !a.body)).toBe(true);
  });

  it("clears fields that were emptied in BambooHR", () => {
    const want = desiredFields(emp({ supervisorEmail: "", country: null, division: "" }), settings);
    expect(want.relations).toBeNull();
    expect(want.addresses).toBeNull();
    const [a] = buildPlan([emp({ supervisorEmail: "", country: null, division: "" })], [user()], ctx);
    expect(a?.body).toMatchObject({ relations: null, addresses: [], customSchemas: { Employee_Information: { Division: null } } });
  });
});

describe("recoveryEmail", () => {
  it("builds plus-addressed, ascii-safe addresses", () => {
    expect(recoveryEmail("recovery@acme.com", "Léopoldine", "Cras")).toBe("recovery+leopoldine.cras@acme.com");
    expect(recoveryEmail("recovery@acme.com", "Mary Ann", "O'Neil")).toBe("recovery+mary.ann.o.neil@acme.com");
    expect(recoveryEmail("recovery@acme.com", "", null)).toBe("recovery@acme.com");
    expect(recoveryEmail("recovery@acme.com", "a".repeat(80), "b").split("@")[0]!.length).toBeLessThanOrEqual(64);
  });
});
