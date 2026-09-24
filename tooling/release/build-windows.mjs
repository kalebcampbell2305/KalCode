// Builds the Windows x64 installer (NSIS per-user `-setup.exe`) from a clean commit and stages it
// in dist/release/<version>/ with a build record (build.json): version, commit, date, size,
// SHA-256 and signature status.
//
// Usage: pnpm release:build            (Windows only)
//
// The installer is not code-signed: there is no certificate. build.json records that
// (`signed: false`), and publish refuses to claim otherwise.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  appVersion,
  assertCleanTree,
  capture,
  DESKTOP_DIR,
  fail,
  formatBytes,
  headCommit,
  powershellJson,
  productName,
  psQuote,
  readJson,
  run,
  sha256File,
  stagingDir,
  TARGET_DIR,
  TAURI_CONF,
  writeJson,
} from "./lib.mjs";

if (process.platform !== "win32") fail("The Windows installer can only be built on Windows.");

assertCleanTree("A release build");
const version = appVersion();
const commit = headCommit();
const product = productName();
const conf = readJson(TAURI_CONF);
const webviewInstallMode = conf.bundle?.windows?.webviewInstallMode?.type;
if (webviewInstallMode !== "downloadBootstrapper") {
  fail(`bundle.windows.webviewInstallMode must stay "downloadBootstrapper" (found ${webviewInstallMode}).`);
}
const installMode = conf.bundle?.windows?.nsis?.installMode ?? "currentUser";
if (installMode !== "currentUser") fail(`NSIS installMode must be "currentUser" (found ${installMode}).`);

const file = `${product}_${version}_x64-setup.exe`;
const bundled = join(TARGET_DIR, "release", "bundle", "nsis", file);
const startedAt = Date.now();

console.log(`Building ${product} ${version} for Windows x64 from ${commit.slice(0, 12)}…`);
run("pnpm", ["--filter", "@kalcode/desktop", "tauri", "build", "--bundles", "nsis"], {
  env: { ...process.env, CARGO_TARGET_DIR: TARGET_DIR },
});

if (!existsSync(bundled)) fail(`The bundler did not produce ${bundled}`);
if (statSync(bundled).mtimeMs < startedAt - 1000) fail(`${bundled} is stale (not written by this build).`);
// The build must not have changed tracked files (e.g. a lockfile), or the artifact would not
// match the recorded commit.
assertCleanTree("After the build, the working tree");
if (headCommit() !== commit) fail("HEAD moved during the build.");

const outDir = stagingDir(version);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const staged = join(outDir, file);
copyFileSync(bundled, staged);

const size = statSync(staged).size;
const sha256 = await sha256File(staged);
const signature = powershellJson(
  `Get-AuthenticodeSignature -LiteralPath ${psQuote(staged)} | Select-Object @{n='status';e={[string]$_.Status}}, @{n='signer';e={if ($_.SignerCertificate) { $_.SignerCertificate.Subject } else { $null }}} | ConvertTo-Json -Compress`,
);
const signed = signature?.status === "Valid";

const record = {
  product,
  version,
  commit,
  builtAt: new Date().toISOString(),
  os: "windows",
  arch: "x64",
  kind: "nsis",
  file,
  size,
  sha256,
  signed,
  signatureStatus: signature?.status ?? "Unknown",
  installMode,
  webviewInstallMode,
  toolchain: {
    node: process.version,
    rustc: capture("rustc", ["--version"]),
    tauriCli: capture("pnpm", ["--filter", "@kalcode/desktop", "exec", "tauri", "--version"], { cwd: DESKTOP_DIR }),
  },
};
writeJson(join(outDir, "build.json"), record);

console.log(`
Built ${file}
  version    ${version}
  commit     ${commit}
  size       ${formatBytes(size)}
  sha256     ${sha256}
  signature  ${record.signatureStatus}${signed ? "" : " (unsigned: Windows SmartScreen will warn on first run)"}
  staged at  ${staged}

Next: pnpm release:verify`);
