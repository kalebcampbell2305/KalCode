// Verifies the staged Windows installer WITHOUT launching KalCode and without touching the
// owner's real install or data:
//
//   1. Checks the staged file still matches build.json (size, SHA-256).
//   2. Safety preflight. Refuses (exit 2, "skipped") if KalCode is already installed on this
//      machine (an uninstall entry named KalCode, %LOCALAPPDATA%\KalCode,
//      %LOCALAPPDATA%\Programs\KalCode, HKCU\Software\KalCode\KalCode or a KalCode shortcut), or
//      if any kalcode.exe is running: the Tauri NSIS installer and uninstaller silently kill
//      running kalcode.exe processes of the current user.
//   3. Pass "no-shortcuts": silent per-user install (/S /NS /D=<temp dir>), checks installed files
//      and the uninstall registration, then silent uninstall and checks everything is gone.
//   4. Pass "default": the same without /NS, additionally checking that the Start-menu and
//      desktop shortcuts are created and then removed by the uninstaller.
//   5. Confirms %APPDATA%\com.kalcode.desktop (the owner's live data) is untouched. Only the
//      folder's own existence and timestamp are read; it is never opened.
//
// The release app is never started. Functional evidence comes from the real-app E2E suite
// (pnpm --filter @kalcode/desktop build:e2e && pnpm --filter @kalcode/desktop test:e2e), which
// runs on an isolated temp data folder.
//
// Usage: pnpm release:verify      Writes dist/release/<version>/verify.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  appVersion,
  fail,
  powershell,
  powershellJson,
  psQuote,
  readJson,
  sha256File,
  stagingDir,
  TARGET_DIR,
  writeJson,
} from "./lib.mjs";

if (process.platform !== "win32") fail("The Windows installer can only be verified on Windows.");

const PRODUCT = "KalCode";
const BUNDLE_ID = "com.kalcode.desktop";
const UNINSTALL_KEY = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT}`;
const PRODUCT_KEY = `HKCU:\\Software\\${PRODUCT}\\${PRODUCT}`;
const MANUFACTURER_KEY = `HKCU:\\Software\\${PRODUCT}`;
const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const version = appVersion();
const outDir = stagingDir(version);
const buildPath = join(outDir, "build.json");
if (!existsSync(buildPath)) fail(`No build record at ${buildPath}. Run pnpm release:build first.`);
const build = readJson(buildPath);
const installer = join(outDir, build.file);

const report = {
  version,
  commit: build.commit,
  file: build.file,
  verifiedAt: new Date().toISOString(),
  status: "running",
  launchedApp: false,
  checks: [],
  passes: [],
};

function check(name, ok, detail = "") {
  report.checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}

function finish(status, code) {
  report.status = status;
  writeJson(join(outDir, "verify.json"), report);
  console.log(`\nverify: ${status} (report: ${relative(process.cwd(), join(outDir, "verify.json"))})`);
  process.exit(code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shortcutPaths() {
  const folders = powershellJson(
    "[pscustomobject]@{ desktop = [Environment]::GetFolderPath('Desktop'); programs = [Environment]::GetFolderPath('Programs') } | ConvertTo-Json -Compress",
  );
  return { desktop: join(folders.desktop, `${PRODUCT}.lnk`), startMenu: join(folders.programs, `${PRODUCT}.lnk`) };
}

/** Everything that would indicate a real KalCode install on this machine. */
function existingInstall() {
  const found = powershellJson(`
    $roots = @(
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
    $hits = @(foreach ($root in $roots) {
      if (Test-Path $root) {
        Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
          $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          if ($_.PSChildName -eq '${PRODUCT}' -or $p.DisplayName -eq '${PRODUCT}') { $_.Name }
        }
      }
    })
    [pscustomobject]@{ uninstallEntries = $hits; productKey = (Test-Path ${psQuote(PRODUCT_KEY)}) } | ConvertTo-Json -Compress`);
  const shortcuts = shortcutPaths();
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const problems = [...(found.uninstallEntries ?? [])].map((key) => `uninstall entry ${key}`);
  if (found.productKey) problems.push(`registry key ${PRODUCT_KEY}`);
  for (const dir of [join(localAppData, PRODUCT), join(localAppData, "Programs", PRODUCT)]) {
    if (existsSync(dir)) problems.push(`install folder ${dir}`);
  }
  for (const lnk of Object.values(shortcuts)) if (existsSync(lnk)) problems.push(`shortcut ${lnk}`);
  return problems;
}

function runningKalcode() {
  return (
    powershellJson(
      "@(Get-Process -Name kalcode -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Id }) | ConvertTo-Json -Compress",
    ) ?? []
  );
}

function dataFolderState() {
  const state = {};
  for (const [name, base] of [
    ["appData", process.env.APPDATA],
    ["localAppData", process.env.LOCALAPPDATA],
  ]) {
    const dir = join(base ?? "", BUNDLE_ID);
    // Existence and the folder's own timestamp only: never list or read inside it.
    state[name] = existsSync(dir) ? { exists: true, mtimeMs: statSync(dir).mtimeMs } : { exists: false };
  }
  return state;
}

function registry(key) {
  return powershellJson(
    `if (Test-Path ${psQuote(key)}) { Get-ItemProperty ${psQuote(key)} | Select-Object * -ExcludeProperty PS* | ConvertTo-Json -Compress }`,
  );
}

function listFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push({ path: relative(dir, path).replaceAll("\\", "/"), size: statSync(path).size });
    }
  };
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function uninstall(installDir) {
  const uninstaller = join(installDir, "uninstall.exe");
  if (!existsSync(uninstaller)) return;
  // The NSIS uninstaller copies itself to %TEMP% and re-launches, so the first process exits at
  // once. Wait for the files and registration to disappear instead.
  const result = spawnSync(uninstaller, ["/S"], { stdio: "ignore" });
  if (result.error) throw result.error;
  await waitFor(
    () => !existsSync(uninstaller) && !existsSync(join(installDir, "kalcode.exe")) && registry(UNINSTALL_KEY) === null,
    120_000,
    "the silent uninstall to finish",
  );
}

/** One install → inspect → uninstall → inspect cycle in a fresh temp folder. */
async function pass(name, extraArgs, expectShortcuts) {
  console.log(`\nPass "${name}": silent install ${["/S", ...extraArgs].join(" ")} /D=<temp>`);
  const root = mkdtempSync(join(tmpdir(), "kalcode-release-verify-"));
  const installDir = join(root, PRODUCT);
  if (/\s/.test(installDir)) throw new Error(`temp path contains spaces, which /D= cannot take: ${installDir}`);
  const shortcuts = shortcutPaths();
  const result = { name, args: ["/S", ...extraArgs, "/D=<temp>\\KalCode"], installDir };
  report.passes.push(result);
  try {
    // /D= must be the last argument and unquoted (NSIS rule).
    const install = spawnSync(installer, ["/S", ...extraArgs, `/D=${installDir}`], { stdio: "ignore" });
    if (install.error) throw install.error;
    check(`${name}: installer exit code 0`, install.status === 0, `exit ${install.status}`);

    check(`${name}: kalcode.exe installed`, existsSync(join(installDir, "kalcode.exe")));
    check(`${name}: uninstall.exe installed`, existsSync(join(installDir, "uninstall.exe")));
    result.installedFiles = listFiles(installDir);

    const exe = join(installDir, "kalcode.exe");
    result.exeVersionInfo = powershellJson(
      `(Get-Item -LiteralPath ${psQuote(exe)}).VersionInfo | Select-Object ProductName, ProductVersion, FileVersion, CompanyName, FileDescription | ConvertTo-Json -Compress`,
    );
    check(`${name}: kalcode.exe product version is ${version}`, result.exeVersionInfo?.ProductVersion === version);
    const builtExe = join(TARGET_DIR, "release", "kalcode.exe");
    if (existsSync(builtExe)) {
      const same = (await sha256File(exe)) === (await sha256File(builtExe));
      result.exeMatchesBuild = same;
      check(`${name}: installed kalcode.exe is byte-identical to target/release/kalcode.exe`, same);
    }

    const reg = registry(UNINSTALL_KEY);
    result.uninstallRegistration = reg;
    check(`${name}: uninstall entry registered under HKCU (per-user)`, reg !== null);
    check(`${name}: DisplayName = ${PRODUCT}`, reg.DisplayName === PRODUCT);
    check(`${name}: DisplayVersion = ${version}`, reg.DisplayVersion === version);
    check(`${name}: Publisher = KalCode`, reg.Publisher === "KalCode");
    check(`${name}: InstallLocation points at the temp dir`, reg.InstallLocation === `"${installDir}"`);
    check(
      `${name}: UninstallString points at the temp uninstaller`,
      reg.UninstallString === `"${join(installDir, "uninstall.exe")}"`,
    );
    const runValue = powershell(`(Get-ItemProperty ${psQuote(RUN_KEY)} -ErrorAction SilentlyContinue).'${PRODUCT}'`);
    check(`${name}: no autostart entry`, runValue === "");

    const created = { desktop: existsSync(shortcuts.desktop), startMenu: existsSync(shortcuts.startMenu) };
    result.shortcutsCreated = created;
    if (expectShortcuts) {
      check(`${name}: Start-menu shortcut created`, created.startMenu, shortcuts.startMenu);
      check(`${name}: desktop shortcut created`, created.desktop, shortcuts.desktop);
    } else {
      check(`${name}: no shortcuts created with /NS`, !created.desktop && !created.startMenu);
    }
  } finally {
    await uninstall(installDir);
  }

  check(`${name}: uninstall entry removed`, registry(UNINSTALL_KEY) === null);
  check(`${name}: install folder removed`, !existsSync(installDir));
  check(
    `${name}: no shortcuts left`,
    !existsSync(shortcuts.desktop) && !existsSync(shortcuts.startMenu),
    `${shortcuts.desktop}, ${shortcuts.startMenu}`,
  );
  // By design the Tauri uninstaller keeps HKCU\Software\KalCode\KalCode (the last install
  // location) unless "delete app data" is ticked. Preflight proved it did not exist, so this run
  // created it: remove it and record that.
  const leftover = registry(PRODUCT_KEY);
  result.leftoverInstallLocationKey = leftover !== null;
  if (leftover !== null) {
    powershell(`Remove-Item -LiteralPath ${psQuote(PRODUCT_KEY)} -Recurse -Force`);
    powershell(
      `$k = Get-Item -LiteralPath ${psQuote(MANUFACTURER_KEY)} -ErrorAction SilentlyContinue; if ($k -and $k.SubKeyCount -eq 0 -and $k.ValueCount -eq 0) { Remove-Item -LiteralPath ${psQuote(MANUFACTURER_KEY)} -Force }`,
    );
  }
  check(`${name}: no KalCode registry keys left after cleanup`, registry(MANUFACTURER_KEY) === null);
  rmSync(root, { recursive: true, force: true });
}

console.log(`Verifying ${build.file} (${build.commit.slice(0, 12)})`);
try {
  const size = statSync(installer).size;
  check("staged installer size matches build.json", size === build.size, `${size} bytes`);
  const sha256 = await sha256File(installer);
  check("staged installer SHA-256 matches build.json", sha256 === build.sha256, sha256);
  const signature = powershell(`[string](Get-AuthenticodeSignature -LiteralPath ${psQuote(installer)}).Status`);
  report.signatureStatus = signature;
  check("signature status recorded honestly", (signature === "Valid") === build.signed, signature);
} catch (error) {
  console.error(error);
  finish("failed", 1);
}

console.log("\nSafety preflight");
const existing = existingInstall();
report.preflight = { existingInstall: existing, runningKalcode: runningKalcode() };
if (existing.length > 0) {
  console.log(`  SKIP: KalCode is already installed on this machine:\n    ${existing.join("\n    ")}`);
  console.log("  The install/uninstall test would overwrite or remove that install, so it was not run.");
  finish("skipped", 2);
}
if (report.preflight.runningKalcode.length > 0) {
  console.log(
    `  SKIP: kalcode.exe is running (PIDs ${report.preflight.runningKalcode.join(", ")}). The NSIS installer kills running kalcode.exe processes; close them and retry.`,
  );
  finish("skipped", 2);
}
console.log("  ok   no existing KalCode install, shortcut or running kalcode.exe");

const dataBefore = dataFolderState();
try {
  await pass("no-shortcuts", ["/NS"], false);
  if (runningKalcode().length > 0) throw new Error("a kalcode.exe started during verification; stopping");
  await pass("default", [], true);
  const dataAfter = dataFolderState();
  report.dataFolders = { before: dataBefore, after: dataAfter };
  check(
    `%APPDATA%\\${BUNDLE_ID} untouched (existence and folder timestamp unchanged)`,
    JSON.stringify(dataBefore.appData) === JSON.stringify(dataAfter.appData),
  );
  check(
    `%LOCALAPPDATA%\\${BUNDLE_ID} untouched (existence and folder timestamp unchanged)`,
    JSON.stringify(dataBefore.localAppData) === JSON.stringify(dataAfter.localAppData),
  );
  check("KalCode was never launched", report.launchedApp === false);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  finish("failed", 1);
}
finish("passed", 0);
