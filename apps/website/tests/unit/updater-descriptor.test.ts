import { describe, expect, it } from "vitest";
import { parseUpdaterDescriptor } from "../../worker/updater-descriptor";
import { syntheticUpdaterDescriptor } from "./fixtures/updater-descriptor";

const VERSION = "1.2.3";
const CHANNEL = "stable" as const;
const SHA256 = "a".repeat(64);
const FILE = "KalCode_1.2.3_x64-setup.exe";
const URL = `https://kalcoded.com/releases/updater/${CHANNEL}/${VERSION}/${SHA256}/${FILE}`;

function signature(
  overrides: { file?: string; version?: string; timestamp?: string; extraField?: string; suffix?: string } = {},
): string {
  const value = syntheticUpdaterDescriptor(VERSION, FILE, SHA256, 42_000_000, CHANNEL).platforms["windows-x86_64"]
    .signature;
  const document = atob(value)
    .replace(`file:${FILE}`, `file:${overrides.file ?? FILE}`)
    .replace(`version:${VERSION}`, `version:${overrides.version ?? VERSION}`)
    .replace("timestamp:1790352000", `timestamp:${overrides.timestamp ?? "1790352000"}`)
    .replace("\tversion:", `${overrides.extraField ?? ""}\tversion:`);
  return btoa(document).concat(overrides.suffix ?? "");
}

function descriptor() {
  return syntheticUpdaterDescriptor(VERSION, FILE, SHA256, 42_000_000, CHANNEL);
}

describe("updater descriptor validation", () => {
  it("accepts the release generator's canonical base64 wrapper around the Minisign document", () => {
    const value = descriptor();
    const encoded = value.platforms["windows-x86_64"].signature;

    expect(encoded).not.toContain("\n");
    expect(atob(encoded)).toContain(`trusted comment: timestamp:1790352000\tfile:${FILE}\tversion:${VERSION}`);
    expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).not.toBeNull();
  });

  it("normalizes the exact release-generator schema and derives the only public artifact key", () => {
    const value = descriptor();
    const parsed = parseUpdaterDescriptor(value, CHANNEL, VERSION);

    expect(parsed).toEqual({
      descriptor: value,
      artifactKey: `releases/updater/${CHANNEL}/${VERSION}/${SHA256}/${FILE}`,
      artifactFile: FILE,
      artifactUrl: URL,
      size: value.kalcode.size,
      sha256: SHA256,
      signature: value.platforms["windows-x86_64"].signature,
    });
    expect(parsed?.descriptor).not.toBe(value);
  });

  it("rejects the former two-field placeholder and unknown fields at every schema level", () => {
    expect(parseUpdaterDescriptor({ version: VERSION, kalcode: { channel: CHANNEL } }, CHANNEL, VERSION)).toBeNull();

    for (const mutate of [
      (value: ReturnType<typeof descriptor>) => Object.assign(value, { future: true }),
      (value: ReturnType<typeof descriptor>) => Object.assign(value.platforms, { linux: {} }),
      (value: ReturnType<typeof descriptor>) => Object.assign(value.platforms["windows-x86_64"], { hash: SHA256 }),
      (value: ReturnType<typeof descriptor>) => Object.assign(value.kalcode, { signatureSha256: SHA256 }),
    ]) {
      const value = descriptor();
      mutate(value);
      expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
    }
  });

  it("requires the selected channel and version plus canonical release text and date fields", () => {
    expect(parseUpdaterDescriptor(descriptor(), "beta", VERSION)).toBeNull();
    expect(parseUpdaterDescriptor(descriptor(), CHANNEL, "1.2.4")).toBeNull();

    for (const [field, invalid] of [
      ["version", "01.2.3"],
      ["notes", "  padded notes  "],
      ["notes", ""],
      ["notes", "x".repeat(10_001)],
      ["pub_date", "2026-09-25"],
      ["pub_date", "2026-09-25T12:00:00Z"],
    ] as const) {
      const value = descriptor();
      Object.assign(value, { [field]: invalid });
      expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
    }
  });

  it.each([
    "http://kalcoded.com/releases/updater/stable/1.2.3/" + SHA256 + "/" + FILE,
    "https://www.kalcoded.com/releases/updater/stable/1.2.3/" + SHA256 + "/" + FILE,
    "https://kalcoded.com/releases/updater/stable/1.2.3/" + "c".repeat(64) + "/" + FILE,
    "https://kalcoded.com/releases/updater/stable/1.2.3/" + SHA256 + "/" + FILE + "?download=1",
    "https://kalcoded.com/releases/updater/stable/1.2.3/" + SHA256 + "/KalCode%5f1.2.3.exe",
    "https://kalcoded.com/releases/updater/stable/1.2.3/" + SHA256 + "/nested/" + FILE,
    "https://kalcoded.com/releases/updater/stable/1.2.3.exe",
  ])("rejects non-canonical or unbound artifact URL %s", (url) => {
    const value = descriptor();
    value.platforms["windows-x86_64"].url = url;
    expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
  });

  it("bounds and binds the artifact metadata", () => {
    for (const mutate of [
      (value: ReturnType<typeof descriptor>) => (value.kalcode.size = 0),
      (value: ReturnType<typeof descriptor>) => (value.kalcode.size = 512 * 1024 * 1024 + 1),
      (value: ReturnType<typeof descriptor>) => (value.kalcode.size = 1.5),
      (value: ReturnType<typeof descriptor>) => (value.kalcode.sha256 = "A".repeat(64)),
      (value: ReturnType<typeof descriptor>) => (value.kalcode.commit = "b".repeat(39)),
      (value: ReturnType<typeof descriptor>) => Object.assign(value.kalcode, { schemaVersion: 2 }),
    ]) {
      const value = descriptor();
      mutate(value);
      expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
    }
  });

  it("requires a bounded canonical Minisign document bound to the exact file and version", () => {
    for (const invalid of [
      signature({ file: "Other.exe" }),
      signature({ version: "1.2.4" }),
      signature({ suffix: "=" }),
      `${signature()}\n`,
      signature({ timestamp: "0" }),
      signature({ extraField: "\textra:1" }),
      btoa(`untrusted comment: ${"x".repeat(16 * 1024)}\n${atob(signature())}`),
    ]) {
      const value = descriptor();
      value.platforms["windows-x86_64"].signature = invalid;
      expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
    }
  });
});
