// Called by `train.mjs land` after main moved to a merge-train candidate. Shipping starts from here.
//
// Automatic release-on-merge is off today (KALCODE_AUTO_RELEASE unset, release runner offline), so this
// hook emits the release kit's start command for the landed main commit. Point KALCODE_RELEASE_KIT at a
// different kit folder when one is current. When the release lookahead (speculative.mjs) or a releaser already
// ran a speculative front half for exactly this SHA, it says so, so the releaser reuses that build. The hook
// never publishes anything by itself.
import { join } from "node:path";

import { DEFAULT_RELEASE_KIT, speculativeFrontHalfFor } from "./speculative.mjs";

export { DEFAULT_RELEASE_KIT };

export function releaseKitCommand({
  main,
  mainCheckout,
  kit = process.env.KALCODE_RELEASE_KIT || DEFAULT_RELEASE_KIT,
}) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return `& ${quote(join(kit, "prepare-release.ps1"))} -Commit ${main} -Repo ${quote(mainCheckout)}`;
}

export default function onLanded({
  main,
  mainCheckout,
  lanesDir = mainCheckout ? join(mainCheckout, "target", "lanes") : null,
  kit = process.env.KALCODE_RELEASE_KIT || DEFAULT_RELEASE_KIT,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const speculative = speculativeFrontHalfFor({ sha: main, lanesDir, kit });
  if (speculative) {
    log(
      `SHIP ${main}: speculative front half already ran for ${speculative.branch}; rerun front half without -SpeculativeRef for notes, then back half`,
    );
    return;
  }
  log(`SHIP ${main}: start the release kit (PowerShell): ${releaseKitCommand({ main, mainCheckout, kit })}`);
}
