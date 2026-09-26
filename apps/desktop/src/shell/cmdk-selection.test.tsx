import { createRequire } from "node:module";
import { render, screen, waitFor } from "@testing-library/react";
import { Command } from "cmdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const commonJsCommand = createRequire(import.meta.url)("cmdk").Command as typeof Command;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(() => {
  // Layout APIs are absent in jsdom; selection and MutationObserver remain real.
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
afterAll(() => {
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe.each([
  ["ESM", Command],
  ["CommonJS", commonJsCommand],
] as const)("cmdk %s selection", (_name, Menu) => {
  it("binds ARIA to controlled options after replacement and clears it after removal", async () => {
    const palette = (value: string, item: string | null) => (
      <Menu value={value}>
        <Menu.Input />
        <Menu.List>
          {item ? (
            <Menu.Item key={item} value={value} forceMount>
              {item}
            </Menu.Item>
          ) : null}
        </Menu.List>
      </Menu>
    );
    const view = render(palette("first", "First"));
    async function expectCurrentOption() {
      await waitFor(() => {
        const option = screen.queryByRole("option");
        for (const owner of [screen.getByRole("combobox"), screen.getByRole("listbox")]) {
          if (option) {
            expect(option).toHaveAttribute("aria-selected", "true");
            expect(owner).toHaveAttribute("aria-activedescendant", option.id);
          } else expect(owner).not.toHaveAttribute("aria-activedescendant");
        }
      });
    }
    await expectCurrentOption();
    view.rerender(palette("second", "Second"));
    await expectCurrentOption();
    // A remounted option can retain its value but receives a new DOM identity.
    view.rerender(palette("second", "Second remounted"));
    await expectCurrentOption();
    view.rerender(palette("", null));
    await expectCurrentOption();
  });
});
