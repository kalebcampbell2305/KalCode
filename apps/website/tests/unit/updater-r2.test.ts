import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { type DownloadDeps, handleDownload, type ReleaseBucket } from "../../worker/downloads";
import { releaseCatalog } from "../../worker/release-catalog";
import type { UpdaterChannel, UpdaterDescriptorV2, UpdaterTarget } from "../../worker/updater-descriptor";
import { syntheticUpdaterDescriptor } from "./fixtures/updater-descriptor";

const VERSION = "2.0.0";
const CHANNEL: UpdaterChannel = "stable";
const WINDOWS_FILE = `KalCode-${VERSION}-windows-x64.exe`;
const MAC_FILE = `KalCode-${VERSION}-macOS-arm64.dmg`;
const WINDOWS_BYTES = new Uint8Array(256 * 1024).map((_, index) => index % 251);
const MAC_BYTES = new Uint8Array(384 * 1024).map((_, index) => index % 241);

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ RELEASES: R2Bucket; DB: D1Database }>>>;

let proxy: Proxy;
let deps: DownloadDeps;
let descriptor: UpdaterDescriptorV2;
let windowsHash: string;
let macHash: string;
let windowsSignatureHash: string;
let macSignatureHash: string;

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function syntheticTargetSignature(file: string, target: UpdaterTarget, channel: UpdaterChannel): string {
  const record = new Uint8Array(74);
  record[0] = "E".charCodeAt(0);
  record[1] = "D".charCodeAt(0);
  const document = [
    "untrusted comment: synthetic updater route test fixture",
    base64(record),
    `trusted comment: timestamp:1790352000\tfile:${file}\tversion:${VERSION}\ttarget:${target}\tchannel:${channel}`,
    base64(new Uint8Array(64)),
  ].join("\n");
  return base64(new TextEncoder().encode(document));
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function artifactPath(hash: string, file: string): string {
  return `/releases/updater/${CHANNEL}/${VERSION}/${hash}/${file}`;
}

function signaturePath(artifactHash: string, signatureHash: string, file: string): string {
  return `/releases/updater/${CHANNEL}/${VERSION}/${artifactHash}/${signatureHash}/${file}.sig`;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await handleDownload(new Request(`https://kalcoded.com${path}`, init), deps);
  if (!response) throw new Error("Updater route was not claimed");
  return response;
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ RELEASES: R2Bucket; DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/wrangler.r2.jsonc", import.meta.url)),
    persist: false,
  });
  const migration = await readFile(
    new URL("../../migrations/0003_release_publication_pointers.sql", import.meta.url),
    "utf8",
  );
  await proxy.env.DB.exec(migration.replace(/^--.*$/gm, "").replace(/\r?\n/g, " "));

  windowsHash = await sha256(WINDOWS_BYTES);
  macHash = await sha256(MAC_BYTES);
  const windowsSignature = syntheticTargetSignature(WINDOWS_FILE, "windows-x86_64", CHANNEL);
  const macSignature = syntheticTargetSignature(MAC_FILE, "darwin-aarch64", CHANNEL);
  windowsSignatureHash = await sha256(`${windowsSignature}\n`);
  macSignatureHash = await sha256(`${macSignature}\n`);
  descriptor = {
    version: VERSION,
    notes: "Synthetic dual-platform updater route fixture.",
    pub_date: "2026-09-25T12:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        url: `https://kalcoded.com${artifactPath(windowsHash, WINDOWS_FILE)}`,
        signature: windowsSignature,
      },
      "darwin-aarch64": {
        url: `https://kalcoded.com${artifactPath(macHash, MAC_FILE)}`,
        signature: macSignature,
      },
    },
    kalcode: {
      schemaVersion: 2,
      channel: CHANNEL,
      commit: "b".repeat(40),
      artifacts: {
        "windows-x86_64": {
          target: "windows-x86_64",
          format: "nsis",
          size: WINDOWS_BYTES.byteLength,
          sha256: windowsHash,
        },
        "darwin-aarch64": {
          target: "darwin-aarch64",
          format: "dmg",
          size: MAC_BYTES.byteLength,
          sha256: macHash,
        },
      },
    },
  };
  const body = JSON.stringify(descriptor);
  const descriptorHash = await sha256(body);
  const descriptorKey = `releases/updater/${CHANNEL}/${VERSION}/${descriptorHash}.json`;
  await Promise.all([
    proxy.env.RELEASES.put(descriptorKey, body),
    proxy.env.RELEASES.put(artifactPath(windowsHash, WINDOWS_FILE).slice(1), WINDOWS_BYTES),
    proxy.env.RELEASES.put(artifactPath(macHash, MAC_FILE).slice(1), MAC_BYTES),
    proxy.env.RELEASES.put(
      signaturePath(windowsHash, windowsSignatureHash, WINDOWS_FILE).slice(1),
      `${windowsSignature}\n`,
    ),
    proxy.env.RELEASES.put(signaturePath(macHash, macSignatureHash, MAC_FILE).slice(1), `${macSignature}\n`),
  ]);
  await proxy.env.DB.prepare("INSERT INTO release_publication_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      CHANNEL,
      VERSION,
      "0000002",
      descriptorKey,
      `releases/${VERSION}/${descriptorHash}.json`,
      descriptorHash,
      descriptorHash,
      "2026-09-25T12:00:00.000Z",
    )
    .run();
  await proxy.env.DB.prepare("INSERT INTO release_publication_pointers VALUES (?, ?, ?, ?)")
    .bind(CHANNEL, VERSION, "0000002", 1)
    .run();
  deps = {
    bucket: proxy.env.RELEASES as unknown as ReleaseBucket,
    catalog: releaseCatalog(proxy.env.DB),
    assets: { fetch: async () => new Response("<h1>404</h1>", { headers: { "content-type": "text/html" } }) },
    log: () => undefined,
  };
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe("authoritative multi-platform updater routes against local R2", () => {
  it("serves the exact Windows and macOS artifacts selected by the v2 descriptor", async () => {
    const windows = await request(artifactPath(windowsHash, WINDOWS_FILE), { headers: { range: "bytes=64-127" } });
    expect(windows.status).toBe(206);
    expect(windows.headers.get("content-type")).toBe("application/vnd.microsoft.portable-executable");
    expect(new Uint8Array(await windows.arrayBuffer())).toEqual(WINDOWS_BYTES.slice(64, 128));

    const mac = await request(artifactPath(macHash, MAC_FILE));
    expect(mac.status).toBe(200);
    expect(mac.headers.get("content-type")).toBe("application/x-apple-diskimage");
    expect(new Uint8Array(await mac.arrayBuffer())).toEqual(MAC_BYTES);
  });

  it("serves only each descriptor-bound signature and artifact key", async () => {
    const windowsSignature = await request(signaturePath(windowsHash, windowsSignatureHash, WINDOWS_FILE));
    expect(windowsSignature.status).toBe(200);
    expect(windowsSignature.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await windowsSignature.text()).toBe(`${descriptor.platforms["windows-x86_64"]?.signature}\n`);

    const macSignatureHead = await request(signaturePath(macHash, macSignatureHash, MAC_FILE), { method: "HEAD" });
    expect(macSignatureHead.status).toBe(200);
    expect(await macSignatureHead.text()).toBe("");

    for (const path of [
      artifactPath("f".repeat(64), MAC_FILE),
      artifactPath(macHash, MAC_FILE.replace(/\.dmg$/, ".exe")),
      artifactPath(macHash, "unreferenced.dmg"),
      signaturePath(windowsHash, windowsSignatureHash, MAC_FILE),
      signaturePath(macHash, windowsSignatureHash, MAC_FILE),
    ]) {
      expect((await request(path)).status).toBe(404);
    }
  });

  it("serves an honest Mac-only channel without falling back to Windows", async () => {
    const channel: UpdaterChannel = "beta";
    const metadata = descriptor.kalcode.artifacts["darwin-aarch64"];
    if (!metadata) throw new Error("Mac fixture missing");
    const signature = syntheticTargetSignature(MAC_FILE, "darwin-aarch64", channel);
    const signatureHash = await sha256(`${signature}\n`);
    const body = JSON.stringify({
      ...descriptor,
      platforms: {
        "darwin-aarch64": {
          url: `https://kalcoded.com/releases/updater/${channel}/${VERSION}/${macHash}/${MAC_FILE}`,
          signature,
        },
      },
      kalcode: { ...descriptor.kalcode, channel, artifacts: { "darwin-aarch64": metadata } },
    } satisfies UpdaterDescriptorV2);
    const descriptorHash = await sha256(body);
    const descriptorKey = `releases/updater/${channel}/${VERSION}/${descriptorHash}.json`;
    const macKey = `releases/updater/${channel}/${VERSION}/${macHash}/${MAC_FILE}`;
    const macSignatureKey = `releases/updater/${channel}/${VERSION}/${macHash}/${signatureHash}/${MAC_FILE}.sig`;
    await Promise.all([
      proxy.env.RELEASES.put(descriptorKey, body),
      proxy.env.RELEASES.put(macKey, MAC_BYTES),
      proxy.env.RELEASES.put(macSignatureKey, `${signature}\n`),
    ]);
    await proxy.env.DB.prepare("INSERT INTO release_publication_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(
        channel,
        VERSION,
        "0000002",
        descriptorKey,
        `releases/${VERSION}/${descriptorHash}.json`,
        descriptorHash,
        descriptorHash,
        "2026-09-25T12:00:00.000Z",
      )
      .run();
    await proxy.env.DB.prepare("INSERT INTO release_publication_pointers VALUES (?, ?, ?, ?)")
      .bind(channel, VERSION, "0000002", 1)
      .run();

    const feed = await request(`/releases/updater/${channel}.json`);
    expect(feed.status).toBe(200);
    expect(Object.keys(((await feed.json()) as UpdaterDescriptorV2).platforms)).toEqual(["darwin-aarch64"]);
    expect((await request(`/${macKey}`)).status).toBe(200);
    expect((await request(`/releases/updater/${channel}/${VERSION}/${windowsHash}/${WINDOWS_FILE}`)).status).toBe(404);
  });

  it("preserves the v1 Windows artifact and detached-signature routes", async () => {
    const channel: UpdaterChannel = "dev";
    const legacy = syntheticUpdaterDescriptor(VERSION, WINDOWS_FILE, windowsHash, WINDOWS_BYTES.byteLength, channel);
    const signature = legacy.platforms["windows-x86_64"].signature;
    const signatureHash = await sha256(`${signature}\n`);
    const body = JSON.stringify(legacy);
    const descriptorHash = await sha256(body);
    const descriptorKey = `releases/updater/${channel}/${VERSION}/${descriptorHash}.json`;
    const artifactKey = `releases/updater/${channel}/${VERSION}/${windowsHash}/${WINDOWS_FILE}`;
    const signatureKey = `releases/updater/${channel}/${VERSION}/${windowsHash}/${signatureHash}/${WINDOWS_FILE}.sig`;
    await Promise.all([
      proxy.env.RELEASES.put(descriptorKey, body),
      proxy.env.RELEASES.put(artifactKey, WINDOWS_BYTES),
      proxy.env.RELEASES.put(signatureKey, `${signature}\n`),
    ]);
    await proxy.env.DB.prepare("INSERT INTO release_publication_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(
        channel,
        VERSION,
        "0000002",
        descriptorKey,
        `releases/${VERSION}/${descriptorHash}.json`,
        descriptorHash,
        descriptorHash,
        "2026-09-25T12:00:00.000Z",
      )
      .run();
    await proxy.env.DB.prepare("INSERT INTO release_publication_pointers VALUES (?, ?, ?, ?)")
      .bind(channel, VERSION, "0000002", 1)
      .run();

    expect((await request(`/${artifactKey}`)).status).toBe(200);
    const detached = await request(`/${signatureKey}`);
    expect(detached.status).toBe(200);
    expect(await detached.text()).toBe(`${signature}\n`);
  });

  it("fails closed when content-addressed signature bytes are replaced", async () => {
    const key = signaturePath(windowsHash, windowsSignatureHash, WINDOWS_FILE).slice(1);
    await proxy.env.RELEASES.put(key, "tampered-signature");
    expect((await request(`/${key}`)).status).toBe(503);
    await proxy.env.RELEASES.put(key, `${descriptor.platforms["windows-x86_64"]?.signature ?? ""}\n`);
  });
});
