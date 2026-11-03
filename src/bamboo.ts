import { env, need } from "./config.js";
import { request } from "./http.js";

export type Employee = { id: string; [field: string]: string | null };

/** Fields the sync reads from BambooHR (plus whatever the custom-schema mapping needs). */
export const BASE_FIELDS = [
  "id",
  "status",
  "workEmail",
  "homeEmail",
  "firstName",
  "preferredName",
  "lastName",
  "jobTitle",
  "department",
  "division",
  "employmentHistoryStatus",
  "supervisorEmail",
  "hireDate",
  "country",
];

function client() {
  const base = env().BAMBOO_BASE_URL ?? `https://api.bamboohr.com/api/gateway.php/${need("BAMBOO_SUBDOMAIN")}/v1`;
  // BambooHR uses HTTP Basic auth with the API key as user and any password.
  const auth = `Basic ${Buffer.from(`${need("BAMBOO_API_KEY")}:x`).toString("base64")}`;
  return <T>(path: string, init: Parameters<typeof request>[1] = {}, retries?: number) =>
    request<T>(base + path, { ...init, headers: { Authorization: auth } }, retries);
}

const fieldList = (extra: string[]) => [...new Set([...BASE_FIELDS, ...extra])];

/**
 * All employees (active, inactive and future hires) in a single request via a custom report.
 * https://documentation.bamboohr.com/reference/request-custom-report-1
 */
export async function fetchEmployees(extraFields: string[] = []): Promise<Employee[]> {
  const res = await client()<{ employees?: Employee[] }>("/reports/custom?format=JSON&onlyCurrent=false", {
    method: "POST",
    json: { title: "bamboohr-gws-sync", fields: fieldList(extraFields) },
  });
  return (res.employees ?? []).map((e) => ({ ...e, id: String(e.id) }));
}

/** One employee. https://documentation.bamboohr.com/reference/get-employee */
export async function fetchEmployee(id: string, extraFields: string[] = []): Promise<Employee> {
  const fields = fieldList(extraFields).join(",");
  const e = await client()<Employee>(`/employees/${encodeURIComponent(id)}?fields=${fields}`);
  return { ...e, id: String(e.id ?? id) };
}

/** Cheap authenticated call used by the connection check. https://documentation.bamboohr.com/reference/metadata-get-a-list-of-fields */
export async function ping(): Promise<string> {
  const fields = await client()<unknown[]>("/meta/fields", {}, 0);
  return `${fields.length} fields visible`;
}
