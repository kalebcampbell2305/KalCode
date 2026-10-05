import { describe, expect, it } from "vitest";
import { providerCatalog } from "../../ipc/memoryProviders.ts";
import { toolItems } from "./providerLabels.ts";

const byId = (id: string) => {
  const status = providerCatalog().find((p) => p.id === id);
  if (!status) throw new Error(id);
  return toolItems(status.capabilities);
};

describe("toolItems", () => {
  it("declares each provider's native tools, research and MCP included", () => {
    for (const id of ["claude-code", "codex", "gemini-cli"]) {
      const items = byId(id);
      for (const kind of ["shell", "file_read", "file_edit", "repo_search", "web_search", "mcp"] as const) {
        expect(items.find((t) => t.kind === kind)?.state, `${id} ${kind}`).toBe("native");
      }
    }
  });

  it("says why a tool isn't offered instead of pretending parity", () => {
    const fetch = byId("codex").find((t) => t.kind === "web_fetch");
    expect(fetch).toMatchObject({ state: "unavailable", value: "Not offered" });
    expect(fetch?.detail).toMatch(/no page-fetch tool/);
    const subagents = byId("gemini-cli").find((t) => t.kind === "subagents");
    expect(subagents).toMatchObject({ state: "needs_setup", value: "Needs setup" });
  });

  it("keeps Claude Code's research available in Plan", () => {
    const search = byId("claude-code").find((t) => t.kind === "web_search");
    expect(search?.detail).toContain("Plan included");
  });
});
