import type { UpdaterChannel, UpdaterDescriptorV1 } from "../../../worker/updater-descriptor";

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * A structurally valid updater descriptor for route/validator tests.
 *
 * Its signature-shaped bytes are synthetic and provide no cryptographic validity claim.
 */
export function syntheticUpdaterDescriptor(
  version: string,
  file: string,
  sha256: string,
  size: number,
  channel: UpdaterChannel,
): UpdaterDescriptorV1 {
  const signatureRecord = new Uint8Array(74);
  signatureRecord[0] = "E".charCodeAt(0);
  signatureRecord[1] = "D".charCodeAt(0);
  const signatureDocument = [
    "untrusted comment: synthetic updater descriptor test fixture",
    base64(signatureRecord),
    `trusted comment: timestamp:1790352000\tfile:${file}\tversion:${version}`,
    base64(new Uint8Array(64)),
  ].join("\n");
  const signature = base64(new TextEncoder().encode(signatureDocument));

  return {
    version,
    notes: "Security and reliability improvements.",
    pub_date: "2026-09-25T12:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://kalcoded.com/releases/updater/${channel}/${version}/${sha256}/${file}`,
      },
    },
    kalcode: {
      schemaVersion: 1,
      channel,
      size,
      sha256,
      commit: "b".repeat(40),
    },
  };
}
