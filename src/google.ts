import { JWT } from "google-auth-library";
import { googleCredentials, need } from "./config.js";
import { HttpError, request } from "./http.js";

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const LICENSING = "https://licensing.googleapis.com/apps/licensing/v1";

export const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.group.member",
  "https://www.googleapis.com/auth/apps.licensing",
];

type Entry = Record<string, unknown>;
export interface GoogleUser {
  id: string;
  primaryEmail: string;
  aliases?: string[];
  suspended?: boolean;
  orgUnitPath?: string;
  name?: { givenName?: string; familyName?: string };
  emails?: Entry[];
  relations?: Entry[];
  organizations?: Entry[];
  externalIds?: Entry[];
  addresses?: Entry[];
  customSchemas?: Record<string, Record<string, unknown>>;
}

const USER_FIELDS =
  "id,primaryEmail,aliases,suspended,orgUnitPath,name,emails,relations,organizations,externalIds,addresses,customSchemas";

let jwt: { client: JWT; id: string } | undefined;
/** Service account with domain-wide delegation, impersonating GOOGLE_ADMIN. Rebuilt when either changes. */
async function api<T>(url: string, init: Parameters<typeof request>[1] = {}, retries?: number): Promise<T> {
  const { client_email, private_key } = googleCredentials();
  const subject = need("GOOGLE_ADMIN");
  const id = `${client_email}|${private_key.length}|${subject}`;
  if (jwt?.id !== id) jwt = { id, client: new JWT({ email: client_email, key: private_key, scopes: SCOPES, subject }) };
  const { token } = await jwt.client.getAccessToken();
  return request<T>(url, { ...init, headers: { Authorization: `Bearer ${token}` } }, retries);
}

const qs = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

const projection = (customSchema: string) =>
  customSchema ? { projection: "custom", customFieldMask: customSchema } : { projection: "basic" };

/** Every user in the account. https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/list */
export async function listUsers(customSchema: string): Promise<GoogleUser[]> {
  const users: GoogleUser[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api<{ users?: GoogleUser[]; nextPageToken?: string }>(
      `${DIRECTORY}/users?${qs({
        customer: "my_customer",
        maxResults: "500",
        fields: `nextPageToken,users(${USER_FIELDS})`,
        pageToken,
        ...projection(customSchema),
      })}`,
    );
    users.push(...(page.users ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return users;
}

/** A single user by BambooHR id (externalId) or email; undefined when absent. */
export async function findUser(employeeId: string, email: string | null, customSchema: string) {
  const byId = await api<{ users?: GoogleUser[] }>(
    `${DIRECTORY}/users?${qs({ customer: "my_customer", query: `externalId=${employeeId}`, fields: `users(${USER_FIELDS})`, ...projection(customSchema) })}`,
  );
  if (byId.users?.[0]) return byId.users[0];
  if (!email) return undefined;
  try {
    return await api<GoogleUser>(
      `${DIRECTORY}/users/${encodeURIComponent(email)}?${qs({ fields: USER_FIELDS, ...projection(customSchema) })}`,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return undefined;
    throw err;
  }
}

/** https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/insert */
export const insertUser = (body: object) => api<GoogleUser>(`${DIRECTORY}/users`, { method: "POST", json: body });

/** Patch semantics: omitted fields are kept, null clears. .../users/update */
export const updateUser = (userKey: string, body: object) =>
  api<GoogleUser>(`${DIRECTORY}/users/${encodeURIComponent(userKey)}`, { method: "PUT", json: body });

/** Groups the user is a direct member of. .../groups/list */
export async function listUserGroups(userKey: string): Promise<{ id: string; email: string }[]> {
  const groups: { id: string; email: string }[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api<{ groups?: { id: string; email: string }[]; nextPageToken?: string }>(
      `${DIRECTORY}/groups?${qs({ userKey, maxResults: "200", fields: "nextPageToken,groups(id,email)", pageToken })}`,
    );
    groups.push(...(page.groups ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return groups;
}

/** .../members/delete */
export const removeMember = (groupKey: string, memberKey: string) =>
  api(`${DIRECTORY}/groups/${encodeURIComponent(groupKey)}/members/${encodeURIComponent(memberKey)}`, {
    method: "DELETE",
  });

/** https://developers.google.com/admin-sdk/licensing/reference/rest/v1/licenseAssignments/delete */
export const revokeLicense = (productId: string, skuId: string, userId: string) =>
  api(`${LICENSING}/product/${encodeURIComponent(productId)}/sku/${encodeURIComponent(skuId)}/user/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });

/** Cheap authenticated call used by the connection check (also proves the delegated token works). */
export async function ping(): Promise<string> {
  try {
    await api(`${DIRECTORY}/users?${qs({ customer: "my_customer", maxResults: "1", fields: "users(id)" })}`, {}, 0);
  } catch (err) {
    if (/unauthorized_client/.test(String((err as Error).message))) {
      throw new Error(
        `${(err as Error).message}\nDomain-wide delegation is missing or incomplete. In the Admin console (Security → API controls → Domain-wide delegation), authorize client ID ${googleCredentials().client_id ?? "(client_id in the JSON key)"} with exactly the scopes shown under Credentials.`,
      );
    }
    throw err;
  }
  return `token ok · ${SCOPES.length} scopes`;
}
