import type { Employee } from "./bamboo.js";
import type { Settings } from "./config.js";
import type { GoogleUser } from "./google.js";

export type ActionType = "create" | "update" | "suspend" | "skip";

export interface Action {
  type: ActionType;
  employeeId?: string;
  email: string;
  name: string;
  /** Google user id for update/suspend. */
  userKey?: string;
  /** Request body sent to Google (create/update/suspend). */
  body?: Record<string, unknown>;
  /** Field-level before/after, for review in the UI. */
  diff?: FieldDiff[];
  reason?: string;
}

export interface FieldDiff {
  field: string;
  before: string;
  after: string;
}

export interface PlanContext {
  settings: Settings;
  /** The delegated admin; never suspended so the sync can't lock itself out. */
  adminEmail: string;
  /** False when planning for a single employee (the Google user list is partial). */
  fullDirectory: boolean;
}

const EXTERNAL_ID_TYPE = "organization";

const clean = (v: unknown) => {
  const s = v == null ? "" : String(v).trim();
  return s === "0000-00-00" ? "" : s;
};
const lower = (v: unknown) => clean(v).toLowerCase();
const fullName = (e: Employee) => `${clean(e.preferredName) || clean(e.firstName)} ${clean(e.lastName)}`.trim();
const externalId = (u: GoogleUser) =>
  u.externalIds?.find((x) => x.type === EXTERNAL_ID_TYPE && clean(x.value))?.value as string | undefined;

/** The Google fields BambooHR owns, in Directory API shape (null = clear). */
export function desiredFields(e: Employee, s: Settings): Record<string, unknown> {
  const work = lower(e.workEmail);
  const home = lower(e.homeEmail);
  const manager = lower(e.supervisorEmail);
  const country = clean(e.country);
  const org = Object.fromEntries(
    Object.entries({ title: e.jobTitle, department: e.department, description: e.employmentHistoryStatus })
      .map(([k, v]) => [k, clean(v)])
      .filter(([, v]) => v),
  );
  const body: Record<string, unknown> = {
    name: { givenName: clean(e.preferredName) || clean(e.firstName), familyName: clean(e.lastName) },
    emails: [...(home ? [{ address: home, type: "home" }] : []), { address: work, primary: true }],
    relations: manager ? [{ value: manager, type: "manager" }] : null,
    organizations: [{ ...org, primary: true }],
    externalIds: [{ value: e.id, type: EXTERNAL_ID_TYPE }],
    addresses: country ? [{ type: "home", formatted: country }] : null,
  };
  if (s.customSchema && Object.keys(s.customFields).length) {
    body.customSchemas = {
      [s.customSchema]: Object.fromEntries(
        Object.entries(s.customFields).map(([gField, bField]) => [gField, clean(e[bField]) || null]),
      ),
    };
  }
  return body;
}

/** Compare only what BambooHR owns, so unrelated Google data never causes churn. */
function diff(u: GoogleUser, want: Record<string, unknown>, s: Settings): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const name = want.name as { givenName: string; familyName: string };
  if (clean(u.name?.givenName) !== name.givenName || clean(u.name?.familyName) !== name.familyName) patch.name = name;

  const home = (want.emails as Entry[]).find((x) => x.type === "home")?.address ?? "";
  const curHome = lower(u.emails?.find((x) => x.type === "home")?.address);
  if (curHome !== home) patch.emails = want.emails;

  const manager = (want.relations as Entry[] | null)?.[0]?.value ?? "";
  if (lower(u.relations?.find((x) => x.type === "manager")?.value) !== manager) patch.relations = want.relations;

  const org = (want.organizations as Entry[])[0]!;
  const cur = u.organizations?.find((x) => x.primary) ?? u.organizations?.[0] ?? {};
  if (["title", "department", "description"].some((k) => clean(cur[k]) !== clean(org[k]))) {
    patch.organizations = want.organizations;
  }

  const wantId = (want.externalIds as Entry[])[0]!;
  if (externalId(u) !== wantId.value) {
    // Keep any external ids Google holds that aren't ours.
    patch.externalIds = [...(u.externalIds ?? []).filter((x) => x.type !== EXTERNAL_ID_TYPE), wantId];
  }

  const country = (want.addresses as Entry[] | null)?.[0]?.formatted ?? "";
  if (clean(u.addresses?.find((x) => x.type === "home")?.formatted) !== country) {
    patch.addresses = country
      ? [...(u.addresses ?? []).filter((x) => x.type !== "home"), ...(want.addresses as Entry[])]
      : (u.addresses ?? []).filter((x) => x.type !== "home");
  }

  if (want.customSchemas) {
    const wantSchema = (want.customSchemas as Record<string, Entry>)[s.customSchema]!;
    const curSchema = u.customSchemas?.[s.customSchema] ?? {};
    if (Object.entries(wantSchema).some(([k, v]) => clean(curSchema[k]) !== clean(v))) {
      patch.customSchemas = want.customSchemas;
    }
  }
  return patch;
}
type Entry = Record<string, unknown>;

/** One-line, human-readable rendering of a Directory API field value. */
function describe(field: string, v: unknown): string {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return "—";
  const list = v as Entry[];
  switch (field) {
    case "name": {
      const n = v as { givenName?: string; familyName?: string };
      return `${clean(n.givenName)} ${clean(n.familyName)}`.trim() || "—";
    }
    case "emails":
      return list.map((e) => `${e.type ?? (e.primary ? "primary" : "other")}: ${clean(e.address)}`).join(", ");
    case "relations":
      return list.map((r) => `${r.type}: ${clean(r.value)}`).join(", ");
    case "organizations":
      return list.map((o) => [o.title, o.department, o.description].map(clean).filter(Boolean).join(" · ")).join(", ") || "—";
    case "externalIds":
      return list.map((x) => `${x.type}: ${clean(x.value)}`).join(", ");
    case "addresses":
      return list.map((a) => `${a.type}: ${clean(a.formatted)}`).join(", ");
    case "customSchemas":
      return Object.entries(v as Record<string, Entry>)
        .flatMap(([schema, f]) => Object.entries(f ?? {}).map(([k, x]) => `${schema}.${k}=${clean(x) || "∅"}`))
        .join(", ");
    default:
      return clean(v) || "—";
  }
}

const HIDDEN = new Set(["password", "changePasswordAtNextLogin"]);
function diffOf(body: Record<string, unknown>, user?: GoogleUser): FieldDiff[] {
  return Object.keys(body)
    .filter((k) => !HIDDEN.has(k))
    .map((field) => {
      let before = user ? describe(field, (user as unknown as Entry)[field]) : "—";
      // Only the custom fields we own are compared, so only show those.
      if (field === "customSchemas" && user) {
        const ours = body.customSchemas as Record<string, Entry>;
        const cur = user.customSchemas ?? {};
        before = describe(field, Object.fromEntries(Object.entries(ours).map(([sch, f]) => [sch, Object.fromEntries(Object.keys(f).map((k) => [k, cur[sch]?.[k]]))])));
      }
      return { field, before, after: describe(field, body[field]) };
    });
}

/**
 * Plus-addressed recovery email for traceability, e.g. recovery+anna.smith@example.com.
 * All variants land in the same inbox.
 */
export function recoveryEmail(base: string, given: unknown, family: unknown): string {
  const [local, domain] = base.split("@");
  const slug = (v: unknown) =>
    clean(v)
      .normalize("NFKD")
      .replace(/[^\x00-\x7f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, ".")
      .replace(/\.+/g, ".")
      .replace(/^[.-]+|[.-]+$/g, "");
  const tag = [slug(given), slug(family)].filter(Boolean).join(".");
  if (!tag) return base;
  const localPart = `${local}+${tag}`.slice(0, 64).replace(/[.-]+$/, "");
  return `${localPart}@${domain}`;
}

const domainOf = (email: string) => email.split("@")[1] ?? "";

/**
 * Decide what to do in Google for every BambooHR employee. Pure: no I/O.
 *
 * Rules (carried over from the original script):
 *  - Users suspended in a protected OU are never touched.
 *  - Users in a protected OU are never suspended.
 *  - The sync never un-suspends a user unless `reactivateSuspended` is on.
 *  - New users are created only for Active employees with a work email.
 *  - On suspension: move to suspendedOu, set recovery email; the executor
 *    then removes group memberships and revokes licences.
 */
export function buildPlan(employees: Employee[], users: GoogleUser[], ctx: PlanContext): Action[] {
  const s = ctx.settings;
  const byExternalId = new Map<string, GoogleUser>();
  const byEmail = new Map<string, GoogleUser>();
  for (const u of users) {
    const id = externalId(u);
    if (id) byExternalId.set(id, u);
    for (const email of [u.primaryEmail, ...(u.aliases ?? [])]) byEmail.set(email.toLowerCase(), u);
  }

  const actions: Action[] = [];
  const matched = new Set<string>();
  const employeeIds = new Set(employees.map((e) => e.id));
  const creating = new Set<string>();
  const isProtected = (u: GoogleUser) => s.protectedOus.includes(u.orgUnitPath ?? "");
  const isAdmin = (u: GoogleUser) => u.primaryEmail.toLowerCase() === ctx.adminEmail.toLowerCase();
  // Without an explicit list, only create users in domains this Workspace already uses
  // (Google rejects creates in domains it doesn't own with a 403). Needs the full directory.
  const knownDomains = new Set([domainOf(ctx.adminEmail.toLowerCase()), ...[...byEmail.keys()].map(domainOf)]);
  const domainBlocked = (d: string) =>
    s.managedDomains.length
      ? s.managedDomains.includes(d)
        ? undefined
        : `Domain ${d} is not in Managed domains`
      : ctx.fullDirectory && !knownDomains.has(d)
        ? `Domain ${d} isn't used in this Google Workspace. Add it under Settings → Managed domains to allow it`
        : undefined;

  const suspendBody = (given: unknown, family: unknown) => ({
    suspended: true,
    ...(s.suspendedOu ? { orgUnitPath: s.suspendedOu } : {}),
    ...(s.recoveryEmail ? { recoveryEmail: recoveryEmail(s.recoveryEmail, given, family) } : {}),
  });

  for (const e of employees) {
    const work = lower(e.workEmail);
    const name = fullName(e);
    const active = clean(e.status) === "Active";
    const linked = byExternalId.get(e.id);
    const byWork = !linked && work ? byEmail.get(work) : undefined;
    // A work email shared by two employees must not move the Google user between them.
    const owner = byWork && externalId(byWork);
    if (work && ((byWork && (matched.has(byWork.id) || (owner && owner !== e.id && employeeIds.has(owner)))) || (!linked && !byWork && creating.has(work)))) {
      if (active) actions.push({ type: "skip", employeeId: e.id, email: work, name, reason: `Work email ${work} is also used by another employee in BambooHR` });
      continue;
    }
    const user = linked ?? byWork;
    if (user) matched.add(user.id);

    if (!work) {
      if (active) actions.push({ type: "skip", employeeId: e.id, email: "", name, reason: "No work email in BambooHR" });
      continue;
    }

    if (!user) {
      if (!active) continue;
      const blocked = domainBlocked(domainOf(work));
      if (blocked) {
        actions.push({ type: "skip", employeeId: e.id, email: work, name, reason: blocked });
        continue;
      }
      const body = Object.fromEntries(Object.entries(desiredFields(e, s)).filter(([, v]) => v !== null));
      const schema = (body.customSchemas as Record<string, Entry> | undefined)?.[s.customSchema];
      if (schema) {
        const set = Object.entries(schema).filter(([, v]) => v !== null);
        if (set.length) body.customSchemas = { [s.customSchema]: Object.fromEntries(set) };
        else delete body.customSchemas;
      }
      creating.add(work);
      actions.push({
        type: "create",
        employeeId: e.id,
        email: work,
        name,
        body: { primaryEmail: work, orgUnitPath: s.newUserOu, ...body, changePasswordAtNextLogin: true },
      });
      actions.at(-1)!.diff = diffOf(actions.at(-1)!.body!);
      continue;
    }

    if (user.suspended && isProtected(user)) continue; // manually parked; off limits

    const patch = diff(user, desiredFields(e, s), s);
    // Rename only when we're sure it's the same person (matched by id) and the address changed.
    if (user.primaryEmail.toLowerCase() !== work && !user.aliases?.some((a) => a.toLowerCase() === work)) {
      patch.primaryEmail = work;
    }

    const base = { employeeId: e.id, email: user.primaryEmail, name, userKey: user.id };
    if (!active && !user.suspended && !isAdmin(user)) {
      if (isProtected(user)) {
        actions.push({ ...base, type: "skip", reason: `Inactive in BambooHR but in protected OU ${user.orgUnitPath}` });
      } else {
        Object.assign(patch, suspendBody(e.preferredName || e.firstName, e.lastName));
        actions.push({ ...base, type: "suspend", body: patch, diff: diffOf(patch, user) });
        continue;
      }
    }
    if (active && user.suspended) {
      if (s.reactivateSuspended) patch.suspended = false;
      else actions.push({ ...base, type: "skip", reason: "Active in BambooHR but suspended in Google; not reactivating" });
    }
    if (Object.keys(patch).length) actions.push({ ...base, type: "update", body: patch, diff: diffOf(patch, user) });
  }

  // Google users linked to an employee who no longer exists in BambooHR.
  if (ctx.fullDirectory && s.suspendMissing) {
    for (const u of users) {
      const id = externalId(u);
      if (!id || matched.has(u.id) || u.suspended || isProtected(u) || isAdmin(u)) continue;
      const body = suspendBody(u.name?.givenName, u.name?.familyName);
      actions.push({
        type: "suspend",
        employeeId: id,
        email: u.primaryEmail,
        name: `${clean(u.name?.givenName)} ${clean(u.name?.familyName)}`.trim(),
        userKey: u.id,
        body,
        diff: diffOf(body, u),
        reason: "Employee no longer exists in BambooHR",
      });
    }
  }

  // Safety valve against bad source data (e.g. an empty or truncated report).
  const suspensions = actions.filter((a) => a.type === "suspend");
  if (suspensions.length > s.maxSuspensionsPerRun) {
    for (const a of suspensions) {
      a.type = "skip";
      a.reason = `Blocked: ${suspensions.length} suspensions exceed the limit of ${s.maxSuspensionsPerRun} per run`;
      delete a.body;
      delete a.diff;
    }
  }
  return actions;
}
