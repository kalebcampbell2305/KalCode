// Tauri custom signing command for production Windows release builds.
// SignTool output is intentionally not forwarded because it may include certificate identity data.
import { basename } from "node:path";

import { powershellJson } from "./lib.mjs";
import {
  authenticodeIdentityOids,
  authenticodeStatus,
  parsePublisherIdentityEnvironment,
  signTarget,
} from "./signing.mjs";

const targetPath = process.argv[2];
const metadataPath = process.env.KALCODE_ARTIFACT_SIGNING_METADATA;

try {
  if (!targetPath || process.argv.length !== 3) throw new Error("one signing target is required");
  if (!metadataPath) throw new Error("release signing metadata is unavailable");
  const expectedPublisherIdentity = parsePublisherIdentityEnvironment(process.env.KALCODE_AUTHENTICODE_IDENTITY_OIDS);

  signTarget({ targetPath, metadataPath });
  const evidence = authenticodeStatus(targetPath, powershellJson);
  if (evidence.status !== "Valid" || !evidence.timestamped) {
    throw new Error("Authenticode verification did not return a valid timestamped signature");
  }
  const actualPublisherIdentity = authenticodeIdentityOids(targetPath, powershellJson);
  if (
    actualPublisherIdentity.length !== expectedPublisherIdentity.length ||
    actualPublisherIdentity.some((oid, index) => oid !== expectedPublisherIdentity[index])
  ) {
    throw new Error("Authenticode signature does not match the approved Artifact Signing publisher identity");
  }
  console.log(`Signed and timestamped ${basename(targetPath)} with Azure Artifact Signing.`);
} catch (error) {
  console.error(`release signing failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
