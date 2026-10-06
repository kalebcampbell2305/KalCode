import type { PaneLayout } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  browserContent,
  clampCustomViewport,
  normalizeBrowserAddress,
  persistableBrowserUrl,
  updateBrowserUrl,
  viewportWidth,
} from "./browserModel.ts";

describe("normalizeBrowserAddress", () => {
  it.each([
    ["localhost:3000", "http://localhost:3000/"],
    ["127.0.0.1:5173/docs", "http://127.0.0.1:5173/docs"],
    ["[::1]:8000", "http://[::1]:8000/"],
    ["kalcoded.com/docs", "https://kalcoded.com/docs"],
    [" HTTPS://EXAMPLE.COM/a?b=c#d ", "https://example.com/a?b=c#d"],
    ["example.com:8080", "https://example.com:8080/"],
    ["myapp.test:3000/x", "https://myapp.test:3000/x"],
    ["host.docker.internal:8080", "https://host.docker.internal:8080/"],
    ["dev.localhost:5173", "http://dev.localhost:5173/"],
    ["0.0.0.0:3000", "http://0.0.0.0:3000/"],
    ["192.168.1.5:5173", "http://192.168.1.5:5173/"],
    ["10.0.0.2:8000/app?x=1", "http://10.0.0.2:8000/app?x=1"],
    ["172.20.0.3:80", "http://172.20.0.3/"],
    ["172.32.0.3:8080", "https://172.32.0.3:8080/"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeBrowserAddress(input)).toBe(expected);
  });

  it.each([
    "",
    "file:///C:/private.txt",
    "javascript:alert(1)",
    "data:text/html,hello",
    "blob:https://example.com/id",
    "about:blank",
    "javascript:0",
    "about:1",
    "example.com:99999",
    "https://user:password@example.com",
    "https://example.com/line\nbreak",
    "https://example.com/tab\tbreak",
    "https://example.com/null\0break",
    "https://example.com/unit\u001fseparator",
    "https://example.com/delete\u007fcharacter",
    `https://${"a".repeat(2048)}.com`,
  ])("rejects unsafe address %s", (input) => {
    expect(() => normalizeBrowserAddress(input)).toThrow();
  });
});

describe("persistableBrowserUrl", () => {
  it("escapes a stray percent so the layout stays saveable", () => {
    expect(persistableBrowserUrl("http://localhost:3000/100%")).toBe("http://localhost:3000/100%25");
    expect(persistableBrowserUrl("http://localhost:3000/a%2Fb%zz%4?q=1%#h%")).toBe(
      "http://localhost:3000/a%2Fb%25zz%254",
    );
  });
});

describe("browser pane state", () => {
  it("keeps browser identity stable when a navigated URL is persisted", () => {
    const original = browserContent("550e8400-e29b-41d4-a716-446655440000", "http://localhost:3000/");
    const layout: PaneLayout = {
      schemaVersion: 1,
      root: {
        kind: "leaf",
        paneId: "left",
        tabs: [original, { kind: "dashboard" }],
        activeTab: 0,
        collapsed: false,
      },
      maximizedPaneId: null,
      dock: [browserContent("550e8400-e29b-41d4-a716-446655440001", "https://example.com/")],
    };

    const next = updateBrowserUrl(layout, original.browserId, "http://localhost:3000/settings");

    expect(next).not.toBe(layout);
    expect(next.root).toMatchObject({
      kind: "leaf",
      tabs: [
        {
          kind: "browser",
          browserId: original.browserId,
          url: "http://localhost:3000/settings",
        },
        { kind: "dashboard" },
      ],
    });
    expect(next.dock).toEqual(layout.dock);
    expect(updateBrowserUrl(next, "missing", "https://example.com/")).toBe(next);
  });

  it("does not persist query strings or fragments that may contain credentials", () => {
    const original = browserContent("550e8400-e29b-41d4-a716-446655440000", "https://example.com/");
    const layout: PaneLayout = {
      schemaVersion: 1,
      root: { kind: "leaf", paneId: "only", tabs: [original], activeTab: 0, collapsed: false },
      maximizedPaneId: null,
      dock: [],
    };
    const next = updateBrowserUrl(layout, original.browserId, "https://example.com/callback?code=secret#token");
    expect(next.root).toMatchObject({ tabs: [{ url: "https://example.com/callback" }] });
  });
});

describe("responsive viewport sizing", () => {
  it("uses the available width for fluid mode and caps named presets", () => {
    expect(viewportWidth("fluid", 900, 1040)).toBe(1040);
    expect(viewportWidth("laptop", 900, 1400)).toBe(1280);
    expect(viewportWidth("mobile", 900, 300)).toBe(300);
    expect(viewportWidth("custom", 910, 1200)).toBe(910);
  });

  it("bounds custom widths to a usable development range", () => {
    expect(clampCustomViewport(50)).toBe(320);
    expect(clampCustomViewport(900.8)).toBe(901);
    expect(clampCustomViewport(9000)).toBe(3840);
  });
});
