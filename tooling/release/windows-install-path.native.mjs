import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalInstallDirectory } from "./windows-install-path.mjs";
import { windowsProtocolProblems } from "./windows-protocol.mjs";

test("native short TEMP alias retains exact canonical identity through update and removal", {
  skip: process.platform !== "win32",
}, () => {
  const evidenceRoot = process.env.KALCODE_WINDOWS_PATH_TEST_OUTPUT ?? resolve("target/windows-install-path-tests");
  mkdirSync(evidenceRoot, { recursive: true });
  const root = mkdtempSync(join(evidenceRoot, "native-"));
  const longDirectory = join(root, "Temporary Profile Unicode Ü", "KalCode");
  assert.throws(() => canonicalInstallDirectory(longDirectory), /ENOENT/);
  mkdirSync(longDirectory, { recursive: true });
  const shortPath = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longDirectory.replaceAll("'", "''")}').ShortPath`,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(shortPath.status, 0, shortPath.stderr);
  const requestedDirectory = shortPath.stdout.trim();
  assert.notEqual(requestedDirectory.toLowerCase(), longDirectory.toLowerCase(), "real 8.3 alias required");
  const registration = { exists: true, urlProtocol: true, command: `"${join(longDirectory, "kalcode.exe")}" "%1"` };
  assert.equal(
    windowsProtocolProblems(registration, join(requestedDirectory, "kalcode.exe")).length,
    1,
    "reproduce the original verifier failure on a real alias",
  );

  const identity = canonicalInstallDirectory(requestedDirectory);
  assert.equal(identity.requestedPath, requestedDirectory);
  assert.equal(identity.canonicalPath, longDirectory);
  assert.match(identity.fileIdentity.inode, /^\d+$/);
  assert.deepEqual(windowsProtocolProblems(registration, join(identity.canonicalPath, "kalcode.exe")), []);
  for (const command of [
    `"${join(root, "Other", "kalcode.exe")}" "%1"`,
    `"${join(identity.canonicalPath, "kalcode.exe")}" %1`,
    `${registration.command} --extra`,
    `"${join(identity.canonicalPath, "uninstall.exe")}" "%1"`,
  ])
    assert.ok(
      windowsProtocolProblems({ ...registration, command }, join(identity.canonicalPath, "kalcode.exe")).length,
    );

  const sentinel = join(identity.canonicalPath, ".kalcode-update-rehearsal");
  writeFileSync(sentinel, "preserve-across-update\n");
  const updateIdentity = canonicalInstallDirectory(requestedDirectory);
  assert.deepEqual(updateIdentity, identity);
  assert.equal(readFileSync(join(requestedDirectory, ".kalcode-update-rehearsal"), "utf8"), "preserve-across-update\n");
  assert.equal(`"${longDirectory}"`, `"${updateIdentity.canonicalPath}"`);
  assert.equal(`"${join(longDirectory, "uninstall.exe")}"`, `"${join(updateIdentity.canonicalPath, "uninstall.exe")}"`);
  rmSync(sentinel);
  rmSync(longDirectory, { recursive: true });
  assert.equal(existsSync(requestedDirectory), false);
  assert.equal(
    longDirectory,
    identity.canonicalPath,
    "retained identity still matches owned registry location after uninstall",
  );
  assert.notEqual(join(root, "Other", "KalCode"), identity.canonicalPath, "unrelated leftover key is not owned");
  writeFileSync(join(root, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
});
