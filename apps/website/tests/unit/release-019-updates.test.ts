import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import committedJson from "../../src/data/releases.json";
import { publishedManifest, syntheticBuild } from "./fixtures/releases";

// KalCode 0.1.9 is an owner-declared public version. Its release is published as a 0.1.9+N build;
// the site names it by the public version (displayManifest), and its notes live at /updates#release-0-1-9.
// While the manifest selects 0.1.8 (or a 0.1.8+N build), nothing about 0.1.9 appears.

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import DownloadPlatforms from "../../src/components/DownloadPlatforms.astro";
import { assertManifest, displayManifest } from "../../src/lib/releases";
import Download from "../../src/pages/download.astro";
import Product from "../../src/pages/product.astro";
import Updates from "../../src/pages/updates.astro";

const COMMITTED = committedJson as ReleaseManifest;

const WINDOWS_NOTE =
  "Windows: 0.1.6 can't update itself. If you have 0.1.6, download this installer and run it once — your data is kept. On macOS, 0.1.6 updates in the app.";

/** A signed Stable 0.1.9+N (or other) build, shaped exactly like the committed releases.json. */
function signedStableBuild(publicVersion: string, build: number): ReleaseManifest {
  return assertManifest(syntheticBuild(COMMITTED, publicVersion, build));
}

function select(manifest: ReleaseManifest) {
  for (const key of Object.keys(fixture.manifest)) delete (fixture.manifest as Record<string, unknown>)[key];
  Object.assign(fixture.manifest, displayManifest(manifest));
}

async function render(component: Parameters<AstroContainer["renderToString"]>[0], path: string) {
  const container = await AstroContainer.create();
  return container.renderToString(component, { request: new Request(`https://kalcoded.com${path}`) });
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

beforeEach(() => select(structuredClone(publishedManifest) as ReleaseManifest));

describe("the Updates page for 0.1.9", () => {
  it("features 0.1.9 above the un-featured 0.1.8, 0.1.7 and 0.1.6 entries from a signed Stable 0.1.9 build", async () => {
    select(signedStableBuild("0.1.9", 1050));
    const html = await render(Updates, "/updates");
    const copy = text(html);
    const ids = ["release-0-1-9", "release-0-1-8", "release-0-1-7", "release-0-1-6"];
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    for (let i = 1; i < ids.length; i += 1) {
      expect(html.indexOf(`id="${ids[i - 1]}"`)).toBeLessThan(html.indexOf(`id="${ids[i]}"`));
    }
    expect(html.match(/update--featured/g)).toHaveLength(1);
    expect(html).toMatch(/<article class="update update--featured" id="release-0-1-9"/);
    expect(html).toMatch(/<article class="update" id="release-0-1-8"/);
    // The site names the build by its public version only.
    expect(copy).toContain("KalCode 0.1.9");
    expect(copy).not.toContain("0.1.9+1050");
    expect(copy).toContain("October 8, 2026");
    // 0.1.8, 0.1.7 and 0.1.6 keep their own publication dates.
    expect(html).toContain('<time datetime="2026-10-01T14:23:12.937Z"');
    expect(html).toContain('<time datetime="2026-09-30T18:25:35.409Z"');
    expect(html).toContain('<time datetime="2026-09-30T02:34:07.332Z"');
    expect(copy).toContain("KalCode 0.1.9 puts every agent, account and terminal in one command deck.");
    expect(copy).toContain("From 0.1.8 or 0.1.7: update in the app with Restart to update or Settings > Updates.");
    expect(copy).toContain(
      "Windows: 0.1.6 can't update itself. Download the 0.1.9 installer from the download page and run it once — your data is kept.",
    );
    expect(html).toMatch(
      /Download the 0\.1\.9 installer from the <a class="text-link" href="\/download"[^>]*>download page<\/a> and run it once/,
    );
    expect(copy).toContain(
      "0.1.9 updates KalCode's data to save each thread's reasoning effort, so Restore previous version can't go back to 0.1.8 afterwards.",
    );
    expect(copy).toContain("Search and commands with Ctrl+K or Cmd+K.");
    expect(copy).toContain(
      "Ready to merge appears only when the agent finished, its work is committed and Git reports no conflicts.",
    );
    expect(copy).toContain('then say "open it" or "that one".');
    expect(copy).toContain("Closing a terminal or agent pane now ends it.");
    // The plan names come from PLANS.
    expect(copy).toContain("Pro, MAX and MAX 2X can be bought monthly or yearly in the app.");
    expect(copy).toContain(
      "Known issues Gemini CLI is still unavailable in KalCode. Claude Code and Codex are unaffected. Codex agents can't commit inside their own worktree; use Commit changes on the agent's card.",
    );
    // No prices are stated in the 0.1.9 entry.
    const entry = html.match(/<article[^>]*id="release-0-1-9"[\s\S]*?<\/article>/)?.[0] ?? "";
    expect(entry).not.toMatch(/\$\d/);
  });

  it("announces no 0.1.9 while the manifest selects 0.1.8 or a 0.1.8 build", async () => {
    for (const manifest of [
      signedStableBuild("0.1.8", 923),
      COMMITTED,
      (() => {
        const plain = structuredClone(COMMITTED);
        if (plain.latest) plain.latest.version = "0.1.8";
        return plain;
      })(),
    ]) {
      select(manifest);
      const html = await render(Updates, "/updates");
      expect(html).not.toContain("release-0-1-9");
      expect(html).not.toContain("0.1.9");
      expect(html).toMatch(/<article class="update update--featured" id="release-0-1-8"/);
      expect(html.match(/update--featured/g)).toHaveLength(1);
    }
  });
});

describe("the download page for 0.1.9", () => {
  it("still tells Windows users of 0.1.6 to run the installer once, only in the Windows row", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, {
      props: { manifest: displayManifest(signedStableBuild("0.1.9", 1050)) },
    });
    const row = (os: string) => html.match(new RegExp(`<li[^>]*id="${os}"[\\s\\S]*?</li>`))?.[0] ?? "";
    expect(text(row("windows"))).toContain(WINDOWS_NOTE);
    expect(row("macos")).not.toContain("data-windows-update-note");
    expect(html.match(/data-windows-update-note/g)).toHaveLength(1);
    expect(html).toContain('href="/updates#release-0-1-9"');
    expect(html).toContain("KalCode_0.1.9_build1050_x64-setup.exe");
  });
});

// Gemini CLI stays unavailable in 0.1.9, so the release-scoped copy written for 0.1.6 names the served
// public version (releaseCopy in lib/releases), never the internal build.
describe("release-scoped copy with a signed Stable 0.1.9 build", () => {
  it("names 0.1.9 on the download and product pages", async () => {
    select(signedStableBuild("0.1.9", 1050));
    const download = text(await render(Download, "/download"));
    expect(download).toContain("Gemini CLI is unavailable in 0.1.9 after Google");
    const product = text(await render(Product, "/product"));
    expect(product).toContain("Gemini CLI is unavailable in 0.1.9 after Google");
    for (const copy of [download, product]) {
      expect(copy).not.toContain("0.1.9+1050");
      expect(copy).not.toMatch(/unavailable in (KalCode )?0\.1\.[678]\b/);
    }
  });
});
