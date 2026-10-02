import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy*/waitFor wait up to 3 s (default 1 s): whole-shell renders on a loaded gate machine can
// take longer than a second without anything being wrong.
configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
});

// jsdom lacks matchMedia; tests default to a dark OS preference.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
