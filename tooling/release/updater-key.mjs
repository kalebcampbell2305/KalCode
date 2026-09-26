import { assertUpdaterKeyReady, initializeUpdaterKey } from "./updater-signing.mjs";

const [command, ...rest] = process.argv.slice(2);
if (rest.length > 0 || !["init", "status"].includes(command)) {
  console.error("usage: node tooling/release/updater-key.mjs init|status");
  process.exit(1);
}

try {
  if (command === "init") {
    initializeUpdaterKey();
    console.log("Updater signing key created under Windows user protection; tracked public key written.");
  } else {
    assertUpdaterKeyReady();
    console.log("Updater signing key is available and matches the tracked public key.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
