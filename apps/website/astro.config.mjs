// @ts-check
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { kalcodeBuildStamp } from "./scripts/build-stamp.mjs";

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
    // dist/.well-known/kalcode-build.json: the commit production serves (tooling/release/lifecycle).
    kalcodeBuildStamp(),
    sitemap({
      // Keep every noindex surface out of search discovery.
      filter: (page) =>
        !page.endsWith("/404") &&
        !page.endsWith("/404.html") &&
        !page.endsWith("/account") &&
        !page.endsWith("/account.html") &&
        !page.includes("/early-access/") &&
        !page.includes("/owner/"),
    }),
  ],
  // Astro 7 defaults to JSX whitespace rules, which drop the spaces between text and inline
  // elements in prose ("Read the<a>privacy notice</a>"). HTML-aware compression keeps them.
  compressHTML: true,
  devToolbar: { enabled: false },
});
