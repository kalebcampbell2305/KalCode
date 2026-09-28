import { realpathSync, statSync } from "node:fs";

// Resolve while the installed directory still exists, then retain this identity for
// strict registry ownership checks after uninstall has removed the directory.
export function canonicalInstallDirectory(requestedPath) {
  const canonicalPath = realpathSync.native(requestedPath);
  const requested = statSync(requestedPath, { bigint: true });
  const canonical = statSync(canonicalPath, { bigint: true });
  if (
    !requested.isDirectory() ||
    !canonical.isDirectory() ||
    requested.dev !== canonical.dev ||
    requested.ino !== canonical.ino
  ) {
    throw new Error("Installed directory identity changed during path resolution");
  }
  return {
    requestedPath,
    canonicalPath,
    fileIdentity: { device: canonical.dev.toString(), inode: canonical.ino.toString() },
  };
}
