import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useNewTerminalShortcut } from "./useNewTerminalShortcut.ts";

const seams = vi.hoisted(() => ({ navigate: vi.fn(), createTerminal: vi.fn(async () => undefined) }));

vi.mock("../../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: seams.navigate }) }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ active: { id: "ws", available: true }, createTerminal: seams.createTerminal }),
}));

const chord = (repeat: boolean) =>
  new KeyboardEvent("keydown", {
    key: "~",
    code: "Backquote",
    ctrlKey: true,
    shiftKey: true,
    repeat,
    cancelable: true,
  });

it("opens one terminal while the keys are held, not one per key repeat", () => {
  renderHook(() => useNewTerminalShortcut());
  window.dispatchEvent(chord(false));
  const repeats = [chord(true), chord(true), chord(true)];
  for (const event of repeats) window.dispatchEvent(event);

  expect(seams.createTerminal).toHaveBeenCalledOnce();
  // Repeats are still consumed, so the shell never receives them either.
  expect(repeats.every((event) => event.defaultPrevented)).toBe(true);
});
