import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SA = JSON.stringify({ type: "service_account", client_email: "sa@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" });
let dir: string;

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
  for (const k of ["BAMBOO_SUBDOMAIN", "BAMBOO_API_KEY", "GOOGLE_ADMIN", "GOOGLE_CREDENTIALS", "SLACK_WEBHOOK_URL", "ENCRYPTION_KEY"]) delete process.env[k];
  process.env.DATA_DIR = dir;
});

describe("encrypted credential store", () => {
  it("encrypts at rest and feeds the config", async () => {
    const secrets = await import("../src/secrets.js");
    secrets.saveSecrets({ BAMBOO_API_KEY: "bamboo-secret-123", GOOGLE_CREDENTIALS: SA });

    const raw = readFileSync(join(dir, "secrets.enc.json"), "utf8");
    expect(raw).not.toContain("bamboo-secret-123");
    expect(raw).not.toContain("PRIVATE KEY");
    expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);

    const config = await import("../src/config.js");
    expect(config.need("BAMBOO_API_KEY")).toBe("bamboo-secret-123");
    expect(config.googleCredentials().client_email).toBe("sa@p.iam.gserviceaccount.com");
    expect(config.credentialSource("BAMBOO_API_KEY")).toBe("console");
    expect(() => config.need("GOOGLE_ADMIN")).toThrow(/GOOGLE_ADMIN is not set/);
  });

  it("survives a restart and lets env vars win", async () => {
    (await import("../src/secrets.js")).saveSecrets({ BAMBOO_API_KEY: "from-console" });
    vi.resetModules();
    process.env.BAMBOO_API_KEY = "";
    expect((await import("../src/config.js")).need("BAMBOO_API_KEY")).toBe("from-console");

    vi.resetModules();
    process.env.BAMBOO_API_KEY = "from-env";
    const config = await import("../src/config.js");
    expect(config.need("BAMBOO_API_KEY")).toBe("from-env");
    expect(config.credentialSource("BAMBOO_API_KEY")).toBe("env");
  });

  it("reports, rather than crashes on, a changed encryption key", async () => {
    process.env.ENCRYPTION_KEY = "first key";
    (await import("../src/secrets.js")).saveSecrets({ BAMBOO_API_KEY: "x" });
    vi.resetModules();
    process.env.ENCRYPTION_KEY = "another key";
    const secrets = await import("../src/secrets.js");
    expect(secrets.storedSecrets()).toEqual({});
    expect(secrets.secretsError).toMatch(/can't be decrypted/);
  });

  it("removes a value when it's cleared", async () => {
    const secrets = await import("../src/secrets.js");
    secrets.saveSecrets({ BAMBOO_API_KEY: "x", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" });
    secrets.saveSecrets({ SLACK_WEBHOOK_URL: "" });
    expect(secrets.storedSecrets()).toEqual({ BAMBOO_API_KEY: "x" });
  });

  it("hashes the console password", async () => {
    const { hashPassword, verifyPassword } = await import("../src/secrets.js");
    const hash = hashPassword("correct horse battery");
    expect(hash).not.toContain("correct");
    expect(verifyPassword("correct horse battery", hash)).toBe(true);
    expect(verifyPassword("wrong password!!", hash)).toBe(false);
  });

  it("validates what is entered in the console", async () => {
    const { validateCredential } = await import("../src/config.js");
    expect(() => validateCredential("GOOGLE_CREDENTIALS", "{}")).toThrow(/service account key/);
    expect(() => validateCredential("GOOGLE_CREDENTIALS", "not json")).toThrow(/JSON file/);
    expect(JSON.parse(validateCredential("GOOGLE_CREDENTIALS", ` ${SA} `)).client_email).toBe("sa@p.iam.gserviceaccount.com");
    expect(() => validateCredential("GOOGLE_ADMIN", "nope")).toThrow();
    expect(() => validateCredential("SLACK_WEBHOOK_URL", "http://hooks.slack.com/x")).toThrow();
    expect(validateCredential("BAMBOO_SUBDOMAIN", " acme ")).toBe("acme");
  });
});
