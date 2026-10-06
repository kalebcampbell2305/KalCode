import { getViteConfig } from "astro/config";
import { lowerLocalPriority } from "../../tooling/local-priority.mjs";

// Local runs yield the CPU to the gate (tooling/local-priority.mjs); CI is unchanged.
lowerLocalPriority();

// getViteConfig lets unit tests render .astro components with the Container API
// (tests/unit/download-render.test.ts) using the site's own Vite and Astro settings.
export default getViteConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
