// Called by `train.mjs land` after main moved to a merge-train candidate. Shipping starts from here.
//
// Automatic release-on-merge is off today (KALCODE_AUTO_RELEASE unset, release runner offline), so this
// hook emits the release kit's start command for the landed main commit. Point KALCODE_RELEASE_KIT at a
// different kit folder when one is current. The hook never publishes anything by itself.
import { join } from "node:path";

export const DEFAULT_RELEASE_KIT = "C:\\kc-code-primary\\target\\code-primary-release";

export function releaseKitCommand({
  main,
  mainCheckout,
  kit = process.env.KALCODE_RELEASE_KIT || DEFAULT_RELEASE_KIT,
}) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return `& ${quote(join(kit, "prepare-release.ps1"))} -Commit ${main} -Repo ${quote(mainCheckout)}`;
}

export default function onLanded({ main, mainCheckout, log = (line) => process.stdout.write(`${line}\n`) }) {
  log(`SHIP ${main}: start the release kit (PowerShell): ${releaseKitCommand({ main, mainCheckout })}`);
}
