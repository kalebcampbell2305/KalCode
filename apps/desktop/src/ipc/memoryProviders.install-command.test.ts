import { describe, expect, it } from "vitest";
import { providerCatalog } from "./memoryProviders.ts";

describe("memory provider install commands", () => {
  it("recommends the current stable Codex CLI without pinning a minor", () => {
    const codex = providerCatalog().find((provider) => provider.id === "codex");

    expect(codex?.installCommand).toBe("npm install -g @openai/codex");
  });
});
