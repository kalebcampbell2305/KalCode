import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";
import { goTo } from "../../test/nav.ts";

// Thread detail on the Stable channel (B8 visual audit D2): the waiting notice never points at
// approval controls that aren't on screen.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

async function mountStable(identity?: {
  configuredModel: string;
  activeModel: string;
  configuredEffort: string;
  activeEffort: string;
}) {
  // The "threads" fixture has a Codex thread waiting for a decision whose request isn't loaded.
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  if (identity) {
    const invoke = transport.invoke.bind(transport);
    transport.invoke = (<T,>(command: Parameters<typeof invoke>[0], args?: Record<string, unknown>): Promise<T> =>
      invoke<T>(command, args).then((result) =>
        command === "thread_get" && (result as { name?: string }).name === "Add Dark Mode Toggle"
          ? ({
              ...(result as object),
              model: identity.configuredModel,
              activeModel: identity.activeModel,
              effort: identity.configuredEffort,
              activeEffort: identity.activeEffort,
            } as T)
          : result,
      )) as typeof transport.invoke;
  }
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
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
  return userEvent.setup();
}

describe("Waiting thread (Stable)", () => {
  it("says the request isn't shown here and opens Approvals instead of 'Answer below'", async () => {
    const user = await mountStable();
    await goTo(user, "Threads");
    const threads = await screen.findByRole("list", { name: "Threads" });
    // The row, never its "Pin globally: …" favorite action (#235).
    await user.click(
      await within(threads).findByRole("button", {
        name: /^(?!(?:Pin|Unpin) globally: |(?:Add|Remove) Favorite: ).*Add Dark Mode Toggle/,
      }),
    );

    expect(await screen.findByText("Waiting for 1 permission decision")).toBeInTheDocument();
    expect(screen.getByText("Requested: Run npm install lodash")).toBeInTheDocument();
    expect(screen.queryByText(/Answer below/)).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        "The request isn't showing here yet. Check Approvals, or interrupt the turn to deny it and keep the thread.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Approvals" }));
    expect(await screen.findByRole("dialog", { name: "Approvals" })).toBeInTheDocument();
  });

  it("shows provider-confirmed model and effort while preserving selected identity details", async () => {
    const user = await mountStable({
      configuredModel: "requested/model-v1",
      activeModel: "actual/model-v2",
      configuredEffort: "high",
      activeEffort: "xhigh",
    });
    await goTo(user, "Threads");
    const threads = await screen.findByRole("list", { name: "Threads" });
    await user.click(
      await within(threads).findByRole("button", {
        name: /^(?!(?:Pin|Unpin) globally: |(?:Add|Remove) Favorite: ).*Add Dark Mode Toggle/,
      }),
    );

    const provider = await screen.findByTestId("thread-provider-identity");
    expect(provider).toHaveTextContent(/^Codex · Account unavailable · actual\/model-v2 · xhigh$/);
    expect(provider).toHaveAttribute("title", expect.stringContaining("Selected model: requested/model-v1."));
    expect(provider).toHaveAttribute("title", expect.stringContaining("Selected reasoning: high."));
  });
});
