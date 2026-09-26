import type { ActionKind } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { describeAction, formatElapsed, providerName, runDurationMs } from "./format.ts";

const MIN = 60_000;

describe("formatElapsed", () => {
  it.each([
    [0, "under 1 min"],
    [59_999, "under 1 min"],
    [MIN, "1 min"],
    [59 * MIN + 59_000, "59 min"],
    [60 * MIN, "1 h"],
    [72 * MIN, "1 h 12 min"],
    [24 * 60 * MIN, "1 d"],
    [(3 * 24 + 2) * 60 * MIN + 5 * MIN, "3 d 2 h"],
    [Number.NaN, "under 1 min"],
    [-5_000, "under 1 min"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe("runDurationMs", () => {
  const createdAt = "2026-09-24T10:00:00.000Z";
  const lastActivityAt = "2026-09-24T10:20:00.000Z";
  const now = Date.parse("2026-09-24T11:00:00.000Z");

  it("measures open threads to now", () => {
    expect(runDurationMs({ createdAt, lastActivityAt, status: "thinking" }, now)).toBe(60 * MIN);
    expect(runDurationMs({ createdAt, lastActivityAt, status: "paused" }, now)).toBe(60 * MIN);
  });

  it("measures finished threads to their last activity", () => {
    expect(runDurationMs({ createdAt, lastActivityAt, status: "completed" }, now)).toBe(20 * MIN);
    expect(runDurationMs({ createdAt, lastActivityAt, status: "failed" }, now)).toBe(20 * MIN);
  });

  it("returns null for unparseable timestamps and never goes negative", () => {
    expect(runDurationMs({ createdAt: "nope", lastActivityAt, status: "active" }, now)).toBeNull();
    expect(runDurationMs({ createdAt, lastActivityAt, status: "active" }, Date.parse(createdAt) - MIN)).toBe(0);
  });
});

describe("describeAction", () => {
  it.each<[ActionKind, string, string | null]>([
    [{ kind: "file_read", path: "a.ts" }, "Read a file", "a.ts"],
    [{ kind: "file_write", path: "a.ts" }, "Write a file", "a.ts"],
    [{ kind: "file_delete", path: "a.ts" }, "Delete a file", "a.ts"],
    [{ kind: "command", command: "npm test", argv: ["npm", "test"], cwd: "~/p" }, "Run a command", "npm test"],
    [{ kind: "package_install", manager: "npm install", packages: ["a", "b"] }, "Install packages", "npm install a b"],
    [{ kind: "package_install", manager: "pnpm add", packages: ["zod"] }, "Install a package", "pnpm add zod"],
    [{ kind: "git", operation: "push", remote: "origin main" }, "Git push", "origin main"],
    [{ kind: "network", host: "example.com", url: null }, "Reach the network", "example.com"],
    [
      { kind: "utility_dns_resolve", operationId: "dns-operation", host: "api.example.test" },
      "Resolve a network address",
      "api.example.test",
    ],
    [{ kind: "browser", action: "navigate", url: "https://x.dev" }, "Browser: navigate", "https://x.dev"],
    [{ kind: "deploy", target: "Production" }, "Deploy", "Production"],
    [{ kind: "tool", tool: "mcp.x", inputSummary: "" }, "Use mcp.x", null],
    [
      {
        kind: "utility_http",
        operationId: "operation-id",
        method: "POST",
        origin: "https://api.example.test/",
        destination: "external",
        redirectHop: 0,
        bodyBytes: 128,
      },
      "POST HTTP request",
      "https://api.example.test/",
    ],
    [
      {
        kind: "utility_process_signal",
        operationId: "operation-id",
        pid: 42,
        processStartTime: "1337",
        processName: "node.exe",
        signal: "terminate",
      },
      "Stop a process",
      "node.exe",
    ],
    [
      {
        kind: "utility_sqlite_write",
        operationId: "operation-id",
        databaseId: "database-id",
        databaseName: "work.db",
        statement: "update",
      },
      "Update database data",
      "work.db",
    ],
  ])("%j", (action, kind, target) => {
    const detail = describeAction(action);
    expect(detail.kind).toBe(kind);
    expect(detail.target).toBe(target);
  });

  it("keeps the working directory as context for commands", () => {
    expect(describeAction({ kind: "command", command: "ls", argv: [], cwd: "~/p" }).context).toBe("~/p");
  });
});

describe("providerName", () => {
  it("names known providers and passes future ids through", () => {
    expect(providerName("claude-code")).toBe("Claude Code");
    expect(providerName("gemini-cli")).toBe("Gemini CLI");
    expect(providerName("future-agent")).toBe("future-agent");
  });
});
