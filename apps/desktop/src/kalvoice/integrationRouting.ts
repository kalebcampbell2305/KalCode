import {
  INTEGRATIONS_CHANGED,
  type Integration,
  type IntegrationTurn,
  integrationClient,
  integrationDispatch,
} from "../ipc/integrationClient.ts";

let cached: Promise<Integration[]> | null = null;
let expiresAt = 0;
export function invalidateIntegrationRouting() {
  cached = null;
  expiresAt = 0;
}
window.addEventListener(INTEGRATIONS_CHANGED, invalidateIntegrationRouting);

export function explicitlyRequestsIntegrations(text: string) {
  return /\b(?:using|use|ask|with) (?:my |the )?(?:connected tools|integrations)\b/i.test(text);
}
export function namesConnectedIntegration(text: string, integrations: Integration[]) {
  const normalized = ` ${text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return integrations.some(
    (item) =>
      item.connected &&
      item.name.trim().length >= 3 &&
      normalized.includes(
        ` ${item.name
          .toLocaleLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim()} `,
      ),
  );
}

/** Metadata only is cached. No prompt, tool output or credential is stored here. */
export async function routesToIntegrations(text: string) {
  if (explicitlyRequestsIntegrations(text)) return true;
  if (!cached || Date.now() >= expiresAt) {
    cached = integrationClient.list().catch(() => []);
    expiresAt = Date.now() + 30_000;
  }
  return namesConnectedIntegration(text, await cached);
}

export async function runVoiceIntegration(
  text: string,
  workspaceId: string | null,
  signal: AbortSignal,
): Promise<string> {
  if (!workspaceId) throw new Error("Open a workspace before asking its connected tools.");
  const scope = { workspace_id: workspaceId, surface: "kalvoice" as const, session_id: "kalvoice" };
  let outcome = await integrationDispatch<IntegrationTurn>("query", { scope, prompt: text });
  // Native owns the approval dialog; voice and model output cannot approve an action.
  for (let count = 0; outcome.status === "approval_required" && count < 8; count++) {
    if (signal.aborted) return "The request was stopped before approval.";
    await integrationDispatch("approve", { approval_id: outcome.approval.id });
    if (signal.aborted) return "Approval was recorded. The request was stopped before execution.";
    outcome = await integrationDispatch<IntegrationTurn>("resume", { scope, turn_id: outcome.turn_id });
  }
  return outcome.status === "completed"
    ? outcome.text
    : "More external actions need approval. Continue from connected tools in Settings.";
}
