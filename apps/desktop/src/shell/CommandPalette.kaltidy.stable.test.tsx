import type { SurfaceFlag, TerminalInfo } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import type { ProcessInfo, ProcessList } from "../ipc/utilities.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import { noteTerminalInput, resetTerminalActivityForTests } from "../surfaces/code/kaltidy/activity.ts";
import { resetAccountIntentForTests } from "../surfaces/threads/accountIntent.ts";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

// KalTidy from the Command Palette on Stable: "Stop idle terminals" stops only idle terminals
// across workspaces; "Review" opens the review dialog; a failed scan stops nothing.
vi.mock("../surfaces/code/TerminalView.tsx", () => ({ TerminalView: () => null }));

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
});
afterEach(() => {
  resetAccountIntentForTests();
  resetTerminalActivityForTests();
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

function processRow(terminalId: string, pid: number, patch: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid,
    parentPid: null,
    name: "pwsh.exe",
    startTime: "1",
    cpuPercent: 0,
    memoryBytes: 1,
    owner: "kal_code_child",
    role: null,
    label: "",
    workspaceId: null,
    workspaceName: null,
    terminalId,
    terminalGeneration: 1,
    ports: [],
    killable: { kind: "confirm" },
    canRestart: true,
    ...patch,
  };
}

/**
 * The "code" fixture (api-server: one ended tab; kalcode-site: PowerShell and Git Bash running,
 * Command Prompt exited) with every tab an hour old, and a real-looking process scan: each running
 * shell at its prompt, except Git Bash, which runs `ping`. `scan: false` makes the scan fail.
 */
async function mountStable({ scan = true } = {}) {
  const transport = createMemoryTransport("code", { detectDelayMs: 0 });
  const invoke = transport.invoke.bind(transport);
  const closed: string[] = [];
  vi.spyOn(transport, "invoke").mockImplementation(async (command, args) => {
    if (command === "utility_processes") {
      if (!scan) throw { code: "utility_unavailable", message: "The process monitor isn't ready." };
      const running = (await invoke<TerminalInfo[]>("terminals_running")).filter((t) => !closed.includes(t.id));
      const processes = running.flatMap((t, index) => {
        const root = processRow(t.id, 1000 + index * 10);
        if (t.shellId !== "git-bash") return [root];
        return [
          { ...root, name: "bash.exe" },
          processRow(t.id, root.pid + 1, { name: "bash.exe", parentPid: root.pid, terminalGeneration: null }),
          processRow(t.id, root.pid + 2, { name: "ping.exe", parentPid: root.pid + 1, terminalGeneration: null }),
        ];
      });
      const list: ProcessList = { processes, total: processes.length, hidden: 0, cpuReady: true, sampledAt: "" };
      return list as never;
    }
    if (command === "terminal_close") closed.push(String(args?.terminalId));
    const result = await invoke(command, args);
    if (command === "terminal_list" || command === "terminals_running") {
      return (result as TerminalInfo[]).map((t) => ({
        ...t,
        startedAt: HOUR_AGO,
        endedAt: t.endedAt ? HOUR_AGO : null,
      })) as never;
    }
    return result as never;
  });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
  render(
    <ToastProvider>
      <TooltipProvider>
        <AccountProvider client={new AccountClient(transport)}>
          <RuntimeProvider client={client} info={boot.info} initialSettings={await client.getSettings()}>
            <Shell />
          </RuntimeProvider>
        </AccountProvider>
      </TooltipProvider>
    </ToastProvider>,
  );
  const terminals = async () => {
    const workspaces = await client.listWorkspaces();
    return (await Promise.all(workspaces.map((w) => client.listTerminals(w.id)))).flat();
  };
  return { user: userEvent.setup(), client, closed, terminals };
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return within(await screen.findByRole("dialog", { name: "Command palette" }));
}

describe("KalTidy in the Command Palette (Stable)", () => {
  it("offers both KalTidy commands when someone types tidy", async () => {
    const { user } = await mountStable();
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "tidy");
    expect(await palette.findByRole("option", { name: "KalTidy: Stop idle terminals" })).toBeInTheDocument();
    expect(palette.getByRole("option", { name: "KalTidy: Review terminals before stopping" })).toBeInTheDocument();
    await user.clear(palette.getByRole("combobox"));
    await user.type(palette.getByRole("combobox"), "close terminals");
    expect(await palette.findByRole("option", { name: "KalTidy: Stop idle terminals" })).toBeInTheDocument();
  });

  it("stops only idle terminals, in every workspace, and keeps the one running a command", async () => {
    const { user, closed, terminals } = await mountStable();
    const before = await terminals();
    const gitBash = before.find((t) => t.shellId === "git-bash");
    expect(before).toHaveLength(4);
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "tidy");
    await user.click(await palette.findByRole("option", { name: "KalTidy: Stop idle terminals" }));

    const toast = await screen.findByText("Stopped 3 idle terminals. Kept 1 terminal in use.");
    expect(closed).toHaveLength(3);
    expect(closed).not.toContain(gitBash?.id);
    const after = await terminals();
    expect(after.map((t) => t.id)).toEqual([gitBash?.id]);
    expect(after[0]?.status).toBe("running");

    // The toast offers the review of what was kept.
    const item = toast.closest("li") as HTMLElement;
    await user.click(within(item).getByRole("button", { name: "Review terminals" }));
    const dialog = await screen.findByRole("dialog", { name: "KalTidy — Stop idle terminals" });
    const waiting = await within(dialog).findByRole("region", { name: /^Waiting for you/ });
    expect(within(waiting).getByRole("checkbox", { name: /Git Bash/ })).not.toBeChecked();
    expect(within(waiting).getByText(/ping\.exe is open and quiet/)).toBeInTheDocument();
    expect(within(dialog).getByText("Nothing is idle right now")).toBeInTheDocument();
  });

  it("reviews first: idle terminals preselected, confirm stops exactly those", async () => {
    const { user, closed } = await mountStable();
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "tidy");
    await user.click(await palette.findByRole("option", { name: "KalTidy: Review terminals before stopping" }));
    const dialog = await screen.findByRole("dialog", { name: "KalTidy — Stop idle terminals" });
    const idle = await within(dialog).findByRole("region", { name: /^Idle/ });
    expect(within(idle).getAllByRole("checkbox")).toHaveLength(3);
    // Opt one idle terminal out: only two stop.
    await user.click(within(idle).getByRole("checkbox", { name: /Command Prompt/ }));
    await user.click(within(dialog).getByRole("button", { name: "Stop 2 terminals" }));
    expect(await screen.findByText("Stopped 2 terminals.")).toBeInTheDocument();
    expect(closed).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /KalTidy/ })).toBeNull());
  });

  it("keeps a terminal with unsent input unless the person opts it in", async () => {
    const { user, closed, terminals } = await mountStable();
    const pwsh = (await terminals()).find((t) => t.shellId === "pwsh" && t.status === "running");
    noteTerminalInput(String(pwsh?.id), "npm run depl", Date.now() - 60 * 60_000);
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "tidy");
    await user.click(await palette.findByRole("option", { name: "KalTidy: Review terminals before stopping" }));
    const dialog = await screen.findByRole("dialog", { name: "KalTidy — Stop idle terminals" });
    const waiting = await within(dialog).findByRole("region", { name: /^Waiting for you/ });
    const draft = within(waiting).getByRole("checkbox", { name: /PowerShell 7/ });
    expect(draft).not.toBeChecked();
    expect(draft).toHaveAccessibleDescription("Unsent input at the prompt");
    await user.click(draft);
    await user.click(within(dialog).getByRole("button", { name: "Stop 3 terminals" }));
    expect(await screen.findByText("Stopped 3 terminals.")).toBeInTheDocument();
    expect(closed).toContain(pwsh?.id);
  });

  it("stops nothing when the process scan fails, and says why", async () => {
    const { user, closed, terminals } = await mountStable({ scan: false });
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "tidy");
    await user.click(await palette.findByRole("option", { name: "KalTidy: Stop idle terminals" }));
    expect(await screen.findByText("Nothing was stopped: KalCode couldn't check your terminals.")).toBeInTheDocument();
    expect(screen.getByText(/couldn't check what your terminals are running/)).toBeInTheDocument();
    expect(closed).toEqual([]);
    expect(await terminals()).toHaveLength(4);
  });
});
