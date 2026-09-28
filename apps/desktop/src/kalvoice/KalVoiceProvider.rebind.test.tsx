import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getRebindRequest, resetAccountIntentForTests, setSelectedThread } from "../surfaces/threads/accountIntent.ts";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

// 0.1.5 switch accounts: a voice rebind comes back as `confirm_thread_rebind`. KalVoice only asks
// the Threads surface to show the Rebind dialog; it never calls `thread_rebind_account`.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  focus: vi.fn().mockResolvedValue(undefined),
  client: {
    subscribeKalVoice: vi.fn().mockResolvedValue(() => undefined),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn().mockResolvedValue(null),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
    rebindThreadAccount: vi.fn(),
  },
  toast: { show: vi.fn() },
}));
vi.mock("../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: { ...mocks.client, kalvoiceRequest: mocks.request } }),
}));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "workspace" } }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: mocks.focus }) }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: mocks.navigate }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => mocks.toast }));

let submit: ((text: string) => Promise<void>) | null = null;
function Probe() {
  submit = useKalVoice().submit;
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountIntentForTests();
  mocks.request.mockImplementation(async (request) => ({
    requestId: request.requestId,
    outcome: { kind: "completed", summary: "Confirm in KalCode to switch “Login fix” to Gemini B." },
    directive: { kind: "confirm_thread_rebind", threadId: "thread-1", accountId: "account-b" },
  }));
});

async function say(text: string) {
  render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(submit).not.toBeNull());
  await act(async () => submit?.(text));
}

it("asks for the Rebind dialog of the shown thread and sends that thread with the request", async () => {
  setSelectedThread({ threadId: "thread-1", providerId: "gemini-cli", providerAccountId: "account-a" });
  await say("Switch this Gemini thread to Gemini B.");
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1" }));
  expect(getRebindRequest()).toMatchObject({ threadId: "thread-1", accountId: "account-b" });
  expect(mocks.navigate).toHaveBeenCalledWith("threads");
  expect(mocks.focus).not.toHaveBeenCalled();
  expect(mocks.client.rebindThreadAccount).not.toHaveBeenCalled();
});

it("opens a named thread that isn't on screen before asking", async () => {
  await say("switch the login fix thread to Gemini B");
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ threadId: null }));
  expect(getRebindRequest()).toMatchObject({ threadId: "thread-1", accountId: "account-b" });
  expect(mocks.focus).toHaveBeenCalledWith({ kind: "thread", threadId: "thread-1" });
  expect(mocks.client.rebindThreadAccount).not.toHaveBeenCalled();
});
