import { getViteConfig } from "astro/config";

// getViteConfig lets unit tests render .astro components with the Container API
// (tests/unit/download-render.test.ts) using the site's own Vite and Astro settings.
export default getViteConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
