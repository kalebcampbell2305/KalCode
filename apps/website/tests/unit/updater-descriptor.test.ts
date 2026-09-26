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

const MAC_FILE = `KalCode-${VERSION}-macOS-arm64.dmg`;
const MAC_SHA256 = "c".repeat(64);

function targetedSignature(
  target: "windows-x86_64" | "darwin-aarch64",
  file: string,
  channel: "stable" | "beta" | "dev" = CHANNEL,
  version = VERSION,
): string {
  return btoa(
    atob(signature({ file, version })).replace(
      `version:${version}`,
      `version:${version}\ttarget:${target}\tchannel:${channel}`,
    ),
  );
}

function platformDescriptor(
  targets: readonly ("windows-x86_64" | "darwin-aarch64")[] = ["windows-x86_64", "darwin-aarch64"],
  version = VERSION,
  channel: "stable" | "beta" | "dev" = CHANNEL,
) {
  const platforms: Record<string, { signature: string; url: string }> = {};
  const artifacts: Record<string, { target: string; format: string; size: number; sha256: string }> = {};
  for (const target of targets) {
    const mac = target === "darwin-aarch64";
    const file = mac ? MAC_FILE : FILE;
    const sha256 = mac ? MAC_SHA256 : SHA256;
    platforms[target] = {
      signature: targetedSignature(target, file, channel, version),
      url: `https://kalcoded.com/releases/updater/${channel}/${version}/${sha256}/${file}`,
    };
    artifacts[target] = {
      target,
      format: mac ? "dmg" : "nsis",
      size: mac ? 55_000_000 : 42_000_000,
      sha256,
    };
  }
  return {
    version,
    notes: "Security and reliability improvements.",
    pub_date: "2026-09-25T12:00:00.000Z",
    platforms,
    kalcode: {
      schemaVersion: 2,
      channel,
      commit: "b".repeat(40),
      artifacts,
    },
  };
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
      artifacts: {
        "windows-x86_64": {
          target: "windows-x86_64",
          format: "nsis",
          artifactKey: `releases/updater/${CHANNEL}/${VERSION}/${SHA256}/${FILE}`,
          artifactFile: FILE,
          artifactUrl: URL,
          signatureFile: `${FILE}.sig`,
          size: value.kalcode.size,
          sha256: SHA256,
          signature: value.platforms["windows-x86_64"].signature,
        },
      },
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

  it("rejects prerelease versions on stable while retaining beta and dev prerelease feeds", () => {
    const prerelease = "1.2.3-rc.1";
    const v1Stable = syntheticUpdaterDescriptor(prerelease, FILE, SHA256, 42_000_000, "stable");
    const v2Stable = platformDescriptor(["windows-x86_64"], prerelease, "stable");

    expect(parseUpdaterDescriptor(v1Stable, "stable", prerelease)).toBeNull();
    expect(parseUpdaterDescriptor(v2Stable, "stable", prerelease)).toBeNull();

    for (const channel of ["beta", "dev"] as const) {
      const v1 = syntheticUpdaterDescriptor(prerelease, FILE, SHA256, 42_000_000, channel);
      const v2 = platformDescriptor(["windows-x86_64"], prerelease, channel);
      expect(parseUpdaterDescriptor(v1, channel, prerelease)).not.toBeNull();
      expect(parseUpdaterDescriptor(v2, channel, prerelease)).not.toBeNull();
    }
  });

  it.each([
    `http://kalcoded.com/releases/updater/stable/1.2.3/${SHA256}/${FILE}`,
    `https://www.kalcoded.com/releases/updater/stable/1.2.3/${SHA256}/${FILE}`,
    `https://kalcoded.com/releases/updater/stable/1.2.3/${"c".repeat(64)}/${FILE}`,
    `https://kalcoded.com/releases/updater/stable/1.2.3/${SHA256}/${FILE}?download=1`,
    `https://kalcoded.com/releases/updater/stable/1.2.3/${SHA256}/KalCode%5f1.2.3.exe`,
    `https://kalcoded.com/releases/updater/stable/1.2.3/${SHA256}/nested/${FILE}`,
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

  it("accepts the exact v2 Windows and Apple Silicon feed and derives both content-addressed artifacts", () => {
    const value = platformDescriptor();
    const parsed = parseUpdaterDescriptor(value, CHANNEL, VERSION);

    expect(parsed?.descriptor).toEqual(value);
    expect(parsed?.artifacts).toEqual({
      "windows-x86_64": {
        target: "windows-x86_64",
        format: "nsis",
        artifactKey: `releases/updater/${CHANNEL}/${VERSION}/${SHA256}/${FILE}`,
        artifactFile: FILE,
        artifactUrl: URL,
        signatureFile: `${FILE}.sig`,
        size: 42_000_000,
        sha256: SHA256,
        signature: value.platforms["windows-x86_64"].signature,
      },
      "darwin-aarch64": {
        target: "darwin-aarch64",
        format: "dmg",
        artifactKey: `releases/updater/${CHANNEL}/${VERSION}/${MAC_SHA256}/${MAC_FILE}`,
        artifactFile: MAC_FILE,
        artifactUrl: value.platforms["darwin-aarch64"].url,
        signatureFile: `${MAC_FILE}.sig`,
        size: 55_000_000,
        sha256: MAC_SHA256,
        signature: value.platforms["darwin-aarch64"].signature,
      },
    });
    expect(parsed).not.toHaveProperty("artifactKey");
  });

  it("accepts an honest Mac-only v2 feed without inventing a Windows fallback", () => {
    const value = platformDescriptor(["darwin-aarch64"]);
    const parsed = parseUpdaterDescriptor(value, CHANNEL, VERSION);

    expect(Object.keys(parsed?.artifacts ?? {})).toEqual(["darwin-aarch64"]);
    expect(parsed?.descriptor.platforms).not.toHaveProperty("windows-x86_64");
  });

  it("requires the v2 platform and artifact keysets to be identical and closed", () => {
    for (const mutate of [
      (value: ReturnType<typeof platformDescriptor>) => delete value.kalcode.artifacts["darwin-aarch64"],
      (value: ReturnType<typeof platformDescriptor>) => delete value.platforms["windows-x86_64"],
      (value: ReturnType<typeof platformDescriptor>) =>
        Object.assign(value.platforms, { "linux-x86_64": value.platforms["windows-x86_64"] }),
      (value: ReturnType<typeof platformDescriptor>) =>
        Object.assign(value.kalcode.artifacts, { "darwin-x86_64": value.kalcode.artifacts["darwin-aarch64"] }),
    ]) {
      const value = platformDescriptor();
      mutate(value);
      expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
    }
  });

  it("binds every v2 target to its metadata, format, extension, hash path and signature", () => {
    for (const mutate of [
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.kalcode.artifacts["darwin-aarch64"].target = "windows-x86_64"),
      (value: ReturnType<typeof platformDescriptor>) => (value.kalcode.artifacts["darwin-aarch64"].format = "nsis"),
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.platforms["darwin-aarch64"].url = value.platforms["darwin-aarch64"].url.replace(/\.dmg$/, ".exe")),
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.platforms["darwin-aarch64"].url = value.platforms["darwin-aarch64"].url.replace(MAC_SHA256, SHA256)),
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.platforms["darwin-aarch64"].signature = targetedSignature("windows-x86_64", MAC_FILE)),
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.platforms["darwin-aarch64"].signature = targetedSignature("darwin-aarch64", MAC_FILE, "beta")),
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.platforms["darwin-aarch64"].signature = btoa(
          atob(value.platforms["darwin-aarch64"].signature).replace(`\tchannel:${CHANNEL}`, ""),
        )),
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.platforms["darwin-aarch64"].signature = btoa(
          atob(value.platforms["darwin-aarch64"].signature).replace(
            `version:${VERSION}\ttarget:darwin-aarch64\tchannel:${CHANNEL}`,
            `version:${VERSION}\ttarget:darwin-aarch64\tchannel:${CHANNEL}\textra:1`,
          ),
        )),
      (value: ReturnType<typeof platformDescriptor>) =>
        (value.platforms["darwin-aarch64"].signature = btoa(
          atob(value.platforms["darwin-aarch64"].signature).replace(
            `version:${VERSION}\ttarget:darwin-aarch64\tchannel:${CHANNEL}`,
            `target:darwin-aarch64\tversion:${VERSION}\tchannel:${CHANNEL}`,
          ),
        )),
    ]) {
      const value = platformDescriptor();
      mutate(value);
      expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
    }
  });

  it("keeps v1 on the historic three-field trusted comment with no target", () => {
    expect(parseUpdaterDescriptor(descriptor(), CHANNEL, VERSION)).not.toBeNull();
    const value = descriptor();
    value.platforms["windows-x86_64"].signature = targetedSignature("windows-x86_64", FILE);
    expect(parseUpdaterDescriptor(value, CHANNEL, VERSION)).toBeNull();
  });
});
