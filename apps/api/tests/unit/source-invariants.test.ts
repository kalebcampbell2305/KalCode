/**
 * Static guarantees about the shipped Worker source and the operator tooling:
 *   - the Worker contains no SQL that writes (no request can change an entitlement);
 *   - the production entry point never imports test code;
 *   - no email address is hardcoded anywhere in the entitlement code paths (no email bypass).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { API_DIR, REPO_ROOT } from "../support/wrangler";

function files(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name));
}

const workerFiles = files(join(API_DIR, "worker"), [".ts"]);

describe("Worker source", () => {
  it("contains no SQL that inserts, updates or deletes", () => {
    expect(workerFiles.length).toBeGreaterThan(5);
    for (const file of workerFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(API_DIR, file)).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER)\b/);
    }
  });

  it("never imports test support code", () => {
    for (const file of workerFiles) {
      expect(readFileSync(file, "utf8"), relative(API_DIR, file)).not.toMatch(/from\s+["'][^"']*tests?\//);
    }
  });

  it("uses the no-sign-in authenticator in the production wiring", () => {
    const env = readFileSync(join(API_DIR, "worker", "lib", "env.ts"), "utf8");
    expect(env).toMatch(/auth: SIGN_IN_UNAVAILABLE,/);
    expect(env).not.toMatch(/TEST_ONLY_AUTHENTICATOR/);
  });
});

describe("no hardcoded identities", () => {
  it("names no email address in the Worker, migrations, admin tooling or entitlement crate", () => {
    const scanned = [
      ...workerFiles,
      ...files(join(API_DIR, "migrations"), [".sql"]),
      ...files(join(REPO_ROOT, "tooling", "admin"), [".mjs"]),
      ...files(join(REPO_ROOT, "crates", "entitlements", "src"), [".rs"]),
    ];
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
    for (const file of scanned) {
      const found = (readFileSync(file, "utf8").match(email) ?? []).filter((m) => !m.endsWith("@example.com"));
      expect(found, relative(REPO_ROOT, file)).toEqual([]);
    }
  });
});
