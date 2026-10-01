import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../../src/data/releases";
import { publishedManifest } from "./fixtures/releases";

// B11 truth: Stable 0.1.6 is live, and the committed releases.json stays Stable 0.1.6 until the 0.1.7
// release assembly replaces it with the generated, signed Stable 0.1.7 manifest. 0.1.2 is the private
// QA baseline, and 0.1.3, 0.1.4 and 0.1.5 are private or burned QA versions: never public.

const fixture = vi.hoisted(() => ({ manifest: {} as ReleaseManifest }));
vi.mock("../../src/lib/releases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/releases")>()),
  RELEASES: fixture.manifest,
}));

import DownloadPlatforms from "../../src/components/DownloadPlatforms.astro";
import { assertManifest, buildStatus, downloadCta, platformRows, signedStableRelease } from "../../src/lib/releases";
import DocsIndex from "../../src/pages/docs/index.astro";
import DocsPermissions from "../../src/pages/docs/permissions.astro";
import DocsProviders from "../../src/pages/docs/providers.astro";
import Download from "../../src/pages/download.astro";
import Home from "../../src/pages/index.astro";
import Pricing from "../../src/pages/pricing.astro";
import Product from "../../src/pages/product.astro";
import Security from "../../src/pages/security.astro";
import Updates from "../../src/pages/updates.astro";

const NEVER_PUBLIC = ["0.1.2", "0.1.3", "0.1.4", "0.1.5"] as const;

/** The Stable 0.1.6 manifest as committed and deployed at f1da08b5 (docs/releases/0.1.6.md identities). */
const COMMITTED_016 = {
  version: "0.1.6",
  commit: "b3b10093f0dbdf5603e729bae547310e2c6e2ce2",
  files: {
    "KalCode_0.1.6_x64-setup.exe": {
      size: 7_965_176,
      sha256: "515b559d935f812476589ff7a85bc5cdc0b3ec6261e61eeb77088aec7d28e911",
    },
    "KalCode_0.1.6_arm64.dmg": {
      size: 14_050_393,
      sha256: "2273c8c6d96440ee162dce029f6bd71567fad82f3a77a7cd7da1618a6048fbc1",
    },
  },
} as const;
const FILES_017 = ["KalCode_0.1.7_arm64.dmg", "KalCode_0.1.7_x64-setup.exe"];

const WINDOWS_NOTE_017 =
  "Windows: 0.1.6 can't update itself. If you have 0.1.6, download this installer and run it once — your data is kept. On macOS, 0.1.6 updates in the app.";

/** A complete signed Stable selection for Windows and Apple silicon, as the publisher generates it. */
function signedStable(version: string): ReleaseManifest {
  const manifest = structuredClone(publishedManifest) as ReleaseManifest;
  if (!manifest.latest) throw new Error("fixture has no release");
  manifest.latest.version = version;
  manifest.latest.channel = "stable";
  manifest.latest.publishedAt = "2026-10-08T01:23:45.000Z";
  manifest.latest.notesUrl = `/updates#release-${version.replaceAll(".", "-")}`;
  const windows = manifest.latest.platforms[0];
  if (!windows) throw new Error("fixture has no Windows platform");
  windows.signed = true;
  windows.file = `KalCode_${version}_x64-setup.exe`;
  windows.pinnedUrl = `/download/${version}/KalCode_${version}_x64-setup.exe`;
  manifest.latest.platforms.push({
    os: "macos",
    arch: "arm64",
    label: "macOS 14 or later, Apple silicon",
    kind: "dmg",
    file: `KalCode_${version}_arm64.dmg`,
    url: "/download/macos-arm64",
    pinnedUrl: `/download/${version}/KalCode_${version}_arm64.dmg`,
    size: 4_200_000,
    sha256: "d".repeat(64),
    signed: true,
  });
  manifest.unavailable = manifest.unavailable.filter((entry) => entry.os !== "macos");
  return manifest;
}

/**
 * The only two states releases.json may hold in B11: the committed Stable 0.1.6 manifest exactly, or
 * a valid signed Stable 0.1.7 manifest offering only the two 0.1.7 files. Returns why a state is refused.
 */
function refusal(candidate: ReleaseManifest): string | null {
  let manifest: ReleaseManifest;
  try {
    manifest = assertManifest(candidate);
  } catch (error) {
    return `invalid manifest: ${(error as Error).message}`;
  }
  const latest = manifest.latest;
  if (!latest) return "no release";
  if ((NEVER_PUBLIC as readonly string[]).includes(latest.version)) return `never-public ${latest.version}`;
  if (latest.channel !== "stable" || signedStableRelease(manifest)?.version !== latest.version) {
    return "not a complete signed Stable release";
  }
  if (!latest.platforms.every((p) => p.signed === true)) return "unsigned platform";
  const files = latest.platforms.map((p) => p.file).sort();
  if (latest.version === "0.1.6") {
    if (latest.commit !== COMMITTED_016.commit) return "0.1.6 commit differs from the committed manifest";
    if (JSON.stringify(files) !== JSON.stringify(Object.keys(COMMITTED_016.files).sort())) return "0.1.6 files differ";
    for (const p of latest.platforms) {
      const expected = COMMITTED_016.files[p.file as keyof typeof COMMITTED_016.files];
      if (p.size !== expected.size || p.sha256 !== expected.sha256) return `0.1.6 ${p.file} identity differs`;
    }
    return null;
  }
  if (latest.version !== "0.1.7") return `unexpected version ${latest.version}`;
  if (JSON.stringify(files) !== JSON.stringify(FILES_017)) return `0.1.7 files are ${files.join(", ")}`;
  if (latest.notesUrl !== "/updates#release-0-1-7") return "0.1.7 notes do not point at its Updates entry";
  for (const p of latest.platforms) {
    if (p.pinnedUrl !== `/download/0.1.7/${p.file}`) return `${p.file} is not pinned under /download/0.1.7/`;
  }
  return null;
}

function select(manifest: ReleaseManifest) {
  for (const key of Object.keys(fixture.manifest)) delete (fixture.manifest as Record<string, unknown>)[key];
  Object.assign(fixture.manifest, manifest);
}

async function render(component: Parameters<AstroContainer["renderToString"]>[0], path: string) {
  const container = await AstroContainer.create();
  return container.renderToString(component, { request: new Request(`https://kalcoded.com${path}`) });
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ");

beforeEach(() => select(structuredClone(publishedManifest) as ReleaseManifest));

describe("the 0.1.7 release data", () => {
  it("accepts a signed Stable 0.1.7 manifest and labels it everywhere as Stable 0.1.7", () => {
    const manifest = assertManifest(signedStable("0.1.7"));
    expect(signedStableRelease(manifest)?.version).toBe("0.1.7");
    expect(buildStatus(manifest)).toBe("Stable 0.1.7 for Windows and macOS");
    expect(downloadCta(manifest).note).toContain("Stable 0.1.7");
    const files = platformRows(manifest).flatMap((row) => ("build" in row && row.build ? [row.build.file] : []));
    expect(files.sort()).toEqual(FILES_017);
  });

  it("holds either the committed Stable 0.1.6 manifest or a signed Stable 0.1.7 one, never 0.1.2-0.1.5", async () => {
    const committed = (await import("../../src/data/releases.json")).default as ReleaseManifest;
    expect(refusal(committed)).toBeNull();
  });

  it("accepts only those two states", () => {
    expect(refusal(signedStable("0.1.7"))).toBeNull();
    for (const version of NEVER_PUBLIC) expect(refusal(signedStable(version))).toBe(`never-public ${version}`);
    expect(refusal(structuredClone(publishedManifest))).not.toBeNull();
    // A 0.1.6 that is not the committed one (other identities) is refused.
    expect(refusal(signedStable("0.1.6"))).not.toBeNull();
    const extra = signedStable("0.1.7");
    const mac = extra.latest?.platforms.find((p) => p.os === "macos");
    if (!extra.latest || !mac) throw new Error("fixture has no macOS platform");
    extra.latest.platforms.push({ ...mac, arch: "x64", file: "KalCode_0.1.7_x64.dmg" });
    expect(refusal(extra)).not.toBeNull();
    const preview = signedStable("0.1.7");
    if (preview.latest) preview.latest.channel = "preview";
    expect(refusal(preview)).not.toBeNull();
  });
});

describe("the download page for 0.1.7", () => {
  it("tells Windows users of 0.1.6 to run the 0.1.7 installer once, only in the Windows row", async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(DownloadPlatforms, { props: { manifest: signedStable("0.1.7") } });
    const row = (os: string) => html.match(new RegExp(`<li[^>]*id="${os}"[\\s\\S]*?</li>`))?.[0] ?? "";
    expect(text(row("windows"))).toContain(WINDOWS_NOTE_017);
    expect(row("windows").indexOf("data-windows-update-note")).toBeLessThan(
      row("windows").indexOf("Download for Windows"),
    );
    expect(row("macos")).not.toContain("data-windows-update-note");
    expect(html.match(/data-windows-update-note/g)).toHaveLength(1);
    expect(html).not.toContain("don&#39;t work in 0.1.6");
  });

  it("keeps the 0.1.7 note off every other release", async () => {
    const container = await AstroContainer.create();
    // 0.1.8 carries the same note (release-018-updates.test.ts).
    for (const version of ["0.1.6", "0.1.9"]) {
      const html = await container.renderToString(DownloadPlatforms, { props: { manifest: signedStable(version) } });
      expect(text(html)).not.toContain("0.1.6 can't update itself");
    }
  });
});

describe("the Updates page", () => {
  it("renders the 0.1.7 entry, featured, above the un-featured 0.1.6 entry from a signed Stable 0.1.7 manifest", async () => {
    select(signedStable("0.1.7"));
    const html = await render(Updates, "/updates");
    const copy = text(html);
    expect(html).toContain('id="release-0-1-7"');
    expect(html).toContain('href="#release-0-1-7"');
    expect(html).toContain('id="release-0-1-6"');
    expect(html).toContain('href="#release-0-1-6"');
    expect(html.indexOf('id="release-0-1-7"')).toBeLessThan(html.indexOf('id="release-0-1-6"'));
    expect(html.match(/update--featured/g)).toHaveLength(1);
    expect(html).toMatch(/<article class="update update--featured" id="release-0-1-7"/);
    expect(copy).toContain("KalCode 0.1.7");
    expect(copy).toContain("October 8, 2026");
    // 0.1.6 keeps its own publication date once 0.1.7 is selected.
    expect(html).toContain('<time datetime="2026-09-30T02:34:07.332Z"');
    expect(copy).toContain(
      "Windows: 0.1.6 can't update itself. Download the 0.1.7 installer from the download page and run it once — your data is kept.",
    );
    expect(html).toMatch(
      /Download the 0\.1\.7 installer from the <a class="text-link" href="\/download"[^>]*>download page<\/a> and run it once/,
    );
    expect(copy).toContain("macOS: update from 0.1.6 in the app.");
    expect(copy).toContain(
      "Windows: in-app Update and Restore previous version now launch the installer. In 0.1.6 they can't start the installer.",
    );
    expect(copy).toContain(
      "If a provider sign-in or a file or folder dialog is open when you update, KalCode now tells you to close it and try again.",
    );
    expect(copy).not.toMatch(/Fixed: an update started during sign-in|restarts 0\.1\.6/);
    expect(copy).toContain("KalVoice");
    expect(copy).toContain("The orb now stops listening when you let go, cancel, or it times out");
  });

  it("announces no 0.1.7 while the manifest selects 0.1.6, and nothing for a never-public version", async () => {
    for (const manifest of [signedStable("0.1.6"), ...NEVER_PUBLIC.map((v) => signedStable(v))]) {
      select(manifest);
      const html = await render(Updates, "/updates");
      expect(html).not.toContain("release-0-1-7");
      expect(html).not.toContain("KalCode 0.1.7");
      for (const hidden of NEVER_PUBLIC) expect(html).not.toContain(`release-${hidden.replaceAll(".", "-")}`);
    }
  });
});

// Gemini CLI stays unavailable and threads still start in Plan, Approve or Auto in 0.1.7, so the
// release-scoped copy written for 0.1.6 names the served Stable release (releaseCopy in lib/releases).
describe("release-scoped copy with a signed Stable 0.1.7 manifest", () => {
  const STALE_016 = [
    /unavailable in (KalCode )?0\.1\.6/i,
    /\bIn (KalCode )?0\.1\.6,/,
    /threads in 0\.1\.6/,
    /not available in 0\.1\.6/,
    /KalCode 0\.1\.6 (also|still)/,
  ];
  const pages = [
    {
      name: "home page",
      component: Home,
      path: "/",
      says: ["Gemini CLI is unavailable in KalCode 0.1.7.", "Unavailable in 0.1.7"],
    },
    {
      name: "product page",
      component: Product,
      path: "/product",
      says: [
        "KalCode 0.1.7 also can't set the Google Cloud project",
        "Gemini CLI is unavailable in 0.1.7 after Google",
      ],
    },
    {
      name: "download page",
      component: Download,
      path: "/download",
      says: ["Gemini CLI is unavailable in 0.1.7 after Google"],
    },
    {
      name: "pricing page",
      component: Pricing,
      path: "/pricing",
      says: ["In 0.1.7, threads run in Plan, Approve or Auto on every plan; Bypass and Custom are planned."],
    },
    {
      name: "security page",
      component: Security,
      path: "/security",
      says: ["Gemini CLI is unavailable in KalCode 0.1.7."],
    },
    {
      name: "docs index",
      component: DocsIndex,
      path: "/docs",
      says: ["threads in 0.1.7 run in Plan, Approve or Auto", "why Gemini CLI is unavailable in 0.1.7."],
    },
    {
      name: "providers docs",
      component: DocsProviders,
      path: "/docs/providers",
      says: [
        "Gemini CLI is unavailable in 0.1.7",
        "KalCode 0.1.7 still includes its Gemini CLI adapter",
        "why Gemini CLI is unavailable in 0.1.7.",
      ],
    },
    {
      name: "permissions docs",
      component: DocsPermissions,
      path: "/docs/permissions",
      says: [
        "In KalCode 0.1.7, threads start in Plan, Approve or Auto, on every plan. Bypass and Custom are planned and not available in 0.1.7.",
        "threads in 0.1.7 run in Plan, Approve or Auto",
      ],
    },
  ];

  it.each(pages)("the $name names 0.1.7, not 0.1.6", async ({ component, path, says }) => {
    select(signedStable("0.1.7"));
    const html = await render(component, path);
    const copy = text(html).replace(/&quot;/g, '"');
    for (const phrase of says) expect(html.includes(phrase) || copy.includes(phrase), phrase).toBe(true);
    for (const stale of STALE_016) expect(copy).not.toMatch(stale);
  });

  it.each(pages)(
    "the $name keeps its 0.1.6 wording for the committed 0.1.6 manifest",
    async ({ component, path, says }) => {
      select(signedStable("0.1.6"));
      const html = await render(component, path);
      const copy = text(html);
      for (const phrase of says) {
        const old = phrase.replaceAll("0.1.7", "0.1.6");
        expect(html.includes(old) || copy.includes(old), old).toBe(true);
      }
      for (const phrase of says) expect(copy).not.toContain(phrase);
    },
  );
});

describe("pages rendered from a signed Stable 0.1.7 manifest", () => {
  const pages = [
    { name: "download page", component: Download, path: "/download" },
    { name: "home page", component: Home, path: "/" },
    { name: "product page", component: Product, path: "/product" },
    { name: "Updates page", component: Updates, path: "/updates" },
    { name: "download platforms", component: DownloadPlatforms, path: "/download" },
  ];

  // The footer and hero status read the real committed manifest through a default parameter the mock
  // can't reach, so the "Stable 0.1.7" labels are checked on the synthetic 0.1.7 build instead.
  it.each(pages)("the $name offers only 0.1.7 files and never 0.1.2 through 0.1.6", async ({ component, path }) => {
    select(signedStable("0.1.7"));
    const html = await render(component, path);
    for (const hidden of [...NEVER_PUBLIC, "0.1.6"]) {
      expect(html).not.toContain(`KalCode_${hidden}_`);
      expect(html).not.toContain(`/download/${hidden}/`);
    }
    for (const hidden of NEVER_PUBLIC) {
      expect(html).not.toMatch(new RegExp(`(Stable|Preview) ${hidden.replaceAll(".", "\\.")}\\b`));
    }
  });
});

describe("website sources", () => {
  const root = join(__dirname, "../../src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(astro|ts|tsx|json|md|mdx)$/.test(name)) files.push(path);
    }
  };
  walk(root);

  it("never name the private 0.1.2 QA baseline", () => {
    const hits = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /\b0\.1\.2\b|0-1-2\b|_0\.1\.2_/.test(line) ? [`${relative(root, path)}:${index + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});
