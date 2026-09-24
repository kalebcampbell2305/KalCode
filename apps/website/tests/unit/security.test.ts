import { describe, expect, it } from "vitest";
import { withNoTransform, withSecurityHeaders } from "../../worker/lib/security";

describe("no-transform on HTML", () => {
  it("adds no-transform once, keeping existing directives", () => {
    expect(withNoTransform(null)).toBe("no-transform");
    expect(withNoTransform("public, max-age=0, must-revalidate")).toBe(
      "public, max-age=0, must-revalidate, no-transform",
    );
    expect(withNoTransform("No-Transform")).toBe("No-Transform");
  });

  it("applies to pages but leaves hashed assets with their immutable policy", () => {
    const html = new Response("<!doctype html>", {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
    });
    expect(withSecurityHeaders(html, "/", "default-src 'none'").headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate, no-transform",
    );
    const css = new Response("body{}", { headers: { "content-type": "text/css" } });
    expect(withSecurityHeaders(css, "/_astro/a.css", "default-src 'none'").headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});
