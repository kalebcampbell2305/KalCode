import type { FeatureFlag, SurfaceFlag } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeStartup } from "./CodeStartup.tsx";
import { NavigationProvider, useNavigation } from "./navigation.tsx";

const workspaces = vi.hoisted(() => ({
  current: {
    state: "loading" as "loading" | "ready" | "error",
    active: null as { id: string } | null,
  },
}));

vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => workspaces.current }));

const flags = [
  { id: "dashboard", state: "available", visible: true },
  { id: "code", state: "available", visible: true },
  { id: "settings", state: "available", visible: true },
] as SurfaceFlag[];
const features = [{ id: "workspace_home", state: "available", visible: true }] as FeatureFlag[];

function NavigationProbe() {
  const { current, navigate } = useNavigation();
  return (
    <>
      <output aria-label="Current destination">{current}</output>
      <button type="button" onClick={() => navigate("home")}>
        Home
      </button>
      <button type="button" onClick={() => navigate("settings")}>
        Settings
      </button>
    </>
  );
}

function tree(featureFlags: readonly FeatureFlag[] | undefined = features) {
  return (
    <NavigationProvider flags={flags} features={featureFlags}>
      <CodeStartup />
      <NavigationProbe />
    </NavigationProvider>
  );
}

function mount(featureFlags: readonly FeatureFlag[] | undefined = features) {
  return render(tree(featureFlags));
}

function settle(
  view: ReturnType<typeof mount>,
  state: "ready" | "error",
  active: { id: string } | null,
  featureFlags: readonly FeatureFlag[] | undefined = features,
) {
  workspaces.current = { state, active };
  view.rerender(tree(featureFlags));
}

beforeEach(() => {
  workspaces.current = { state: "loading", active: null };
});

describe("Code startup", () => {
  it("opens Code after the initial active workspace is restored", () => {
    const view = mount();
    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("home");

    settle(view, "ready", { id: "workspace" });

    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("code");
  });

  it("keeps the onboarding destination when no workspace was restored", () => {
    const view = mount();

    settle(view, "ready", null);

    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("home");
  });

  it("keeps the existing Dashboard start when Home is unavailable and no workspace was restored", () => {
    const view = mount([]);

    settle(view, "ready", null, []);

    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("dashboard");
  });

  it("keeps the onboarding destination when the initial restore fails", () => {
    const view = mount();

    settle(view, "error", null);

    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("home");
  });

  it("never overrides navigation performed while the workspace restore is pending", async () => {
    const user = userEvent.setup();
    const view = mount();
    await user.click(screen.getByRole("button", { name: "Settings" }));

    settle(view, "ready", { id: "workspace" });

    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("settings");
  });

  it("treats navigation to the already-current destination as user intent", async () => {
    const user = userEvent.setup();
    const view = mount();
    await user.click(screen.getByRole("button", { name: "Home" }));

    settle(view, "ready", { id: "workspace" });

    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("home");
  });

  it("does not redirect when a workspace appears after the initial restore", () => {
    const view = mount();
    settle(view, "ready", null);

    workspaces.current = { state: "loading", active: null };
    view.rerender(tree());
    settle(view, "ready", { id: "workspace" });

    expect(screen.getByRole("status", { name: "Current destination" })).toHaveTextContent("home");
  });
});
