import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy*/waitFor wait up to 3 s, as in the desktop tests: a loaded gate machine can take longer
// than the 1 s default to render a menu, and a real failure still fails.
configure({ asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
});
