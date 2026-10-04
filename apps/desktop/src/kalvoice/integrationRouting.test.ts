import { describe, expect, it } from "vitest";
import type { Integration } from "../ipc/integrationClient.ts";
import { explicitlyRequestsIntegrations, namesConnectedIntegration } from "./integrationRouting.ts";

const services = [
  { name: "GitHub", connected: true },
  { name: "Stripe", connected: false },
] as Integration[];
describe("external integration intent", () => {
  it("requires an exact connected service name or explicit tools intent", () => {
    expect(namesConnectedIntegration("Check the latest GitHub issue", services)).toBe(true);
    expect(namesConnectedIntegration("Open GitHubDesktop", services)).toBe(false);
    expect(namesConnectedIntegration("Check Stripe errors", services)).toBe(false);
    expect(namesConnectedIntegration("Run the tests", services)).toBe(false);
    expect(explicitlyRequestsIntegrations("Using integrations, check production")).toBe(true);
    expect(explicitlyRequestsIntegrations("Fix integration tests")).toBe(false);
  });
});
