// @ts-check
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  site: "https://kalcoded.com",
  // Pages are emitted as /pricing.html and served at /pricing (Workers static assets
  // `html_handling: auto-trailing-slash`), so canonical URLs never carry a trailing slash.
  trailingSlash: "never",
  build: {
    format: "file",
    // Strict CSP: styles must come from files on our origin, never inline <style> blocks.
    inlineStylesheets: "never",
  },
  vite: {
    build: {
      // Prevents Astro/Vite from inlining small scripts and assets into HTML (keeps CSP strict).
      assetsInlineLimit: 0,
    },
  },
  integrations: [
    sitemap({
      filter: (page) => !page.endsWith("/404") && !page.endsWith("/404.html"),
    }),
  ],
  // Astro 7 defaults to JSX whitespace rules, which drop the spaces between text and inline
  // elements in prose ("Read the<a>privacy notice</a>"). HTML-aware compression keeps them.
  compressHTML: true,
  devToolbar: { enabled: false },
});
