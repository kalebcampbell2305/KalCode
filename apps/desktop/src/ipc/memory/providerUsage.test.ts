import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../client.ts";
import { createMemoryTransport } from "../memoryTransport.ts";

const client = () => new KalCodeClient(createMemoryTransport("default", { detectDelayMs: 0 }));
const remaining = (windows: { remainingPercent: number }[]) => windows.map((window) => window.remainingPercent);

describe("provider usage memory fixture", () => {
  it("reports realistic usage per account and never numbers for signed-out or unsupported accounts", async () => {
    const api = client();
    const accounts = await api.listProviderAccounts();
    const usage = await api.providerAccountUsage();
    expect(usage.map((entry) => entry.accountId).sort()).toEqual(accounts.map((account) => account.id).sort());
    const byName = new Map(
      accounts.map((account) => [
        `${account.providerId}/${account.displayName}`,
        usage.find((entry) => entry.accountId === account.id),
      ]),
    );
    const claude = byName.get("claude-code/Personal");
    expect(claude).toMatchObject({ status: "available", plan: "Max 20x" });
    expect(remaining(claude?.windows ?? [])).toEqual([42, 64]);
    expect(Date.parse(claude?.windows[1]?.resetsAt ?? "") - Date.now()).toBeGreaterThan(2 * 3_600_000);
    expect(remaining(byName.get("codex/Personal")?.windows ?? [])).toEqual([56, 88]);
    expect(byName.get("codex/Work")).toMatchObject({ status: "not_checked", windows: [], reason: "Signed out" });
    expect(byName.get("gemini-cli/Personal")).toMatchObject({ status: "unavailable", windows: [] });

    const codexB = await api.createProviderAccount("codex", "B");
    const claudeB = await api.createProviderAccount("claude-code", "B");
    const [lowCodex] = await api.providerAccountUsage([codexB.id]);
    expect(remaining(lowCodex?.windows ?? [])).toEqual([8]);
    expect(remaining((await api.providerAccountUsage([claudeB.id]))[0]?.windows ?? [])).toEqual([91, 96]);
  });
});
