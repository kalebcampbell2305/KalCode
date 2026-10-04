import type { APIRoute } from "astro";
import { PAGES, SITE_ORIGIN } from "../lib/site";

/** A standard, direct sitemap URL for crawlers; only the public page catalog belongs here. */
export const GET: APIRoute = () =>
  new Response(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...PAGES.map(
        (page) => `  <url><loc>${new URL(page.path, SITE_ORIGIN).href.replaceAll("&", "&amp;")}</loc></url>`,
      ),
      "</urlset>",
    ].join("\n"),
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
