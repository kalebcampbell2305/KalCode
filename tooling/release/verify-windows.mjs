// Verifies the staged Windows installer WITHOUT launching KalCode and without touching the
// owner's real install or data:
//
//   1. Checks the staged file still matches build.json (size, SHA-256) and has a valid,
//      timestamped Authenticode signature.
//   2. Safety preflight. Refuses (exit 2, "skipped") if KalCode is already installed on this
//      machine (an uninstall entry named KalCode, %LOCALAPPDATA%\KalCode,
//      %LOCALAPPDATA%\Programs\KalCode, HKCU\Software\KalCode\KalCode or a KalCode shortcut), or
//      if any kalcode.exe is running: the Tauri NSIS installer and uninstaller silently kill
//      running kalcode.exe processes of the current user.
//   3. Pass "no-shortcuts": silent per-user install (/S /NS /D=<temp dir>), checks installed files
//      files, signatures and the uninstall registration, then silent uninstall and checks
//      everything is gone.
//   4. Pass "default": the same without /NS, additionally checking that the Start-menu and
//      desktop shortcuts are created and then removed by the uninstaller.
//   5. Pass "upgrade": installs a baseline copy, reruns the installer with /UPDATE, proves an
//      existing-install sentinel survived and verifies the installed signature again.
//   6. Confirms %APPDATA%\com.kalcode.desktop (the owner's live data) is untouched. Only the
//      folder's own existence and timestamp are read; it is never opened.
//
// The release app is never started. Functional evidence comes from the real-app E2E suite
// (pnpm --filter @kalcode/desktop build:e2e && pnpm --filter @kalcode/desktop test:e2e), which
// runs on an isolated temp data folder.
//
// Usage: pnpm release:verify      Writes dist/release/<version>/verify.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { verifyComponentNotices } from "./component-notices.mjs";
import { guardianInstalledProblems } from "./guardian-packaging.mjs";
import {
  appVersion,
  fail,
  powershell,
  powershellJson,
  psQuote,
  readJson,
  sha256File,
  stagingDir,
  writeJson,
} from "./lib.mjs";
import {
  artifactSigningIdentityMatchesPinned,
  authenticodeIdentityOids,
  authenticodeStatus,
  expectedWindowsInstallerFile,
  publicSigningProblems,
  releaseProcessOptions,
  sameAuthenticodeSigner,
} from "./signing.mjs";
import { verifyUpdaterArtifact } from "./updater-signing.mjs";
import { canonicalInstallDirectory } from "./windows-install-path.mjs";
import { windowsProtocolProblems } from "./windows-protocol.mjs";

if (process.platform !== "win32") fail("The Windows installer can only be verified on Windows.");

const PRODUCT = "KalCode";
const BUNDLE_ID = "com.kalcode.desktop";
const UNINSTALL_KEY = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT}`;
const PRODUCT_KEY = `HKCU:\\Software\\${PRODUCT}\\${PRODUCT}`;
const MANUFACTURER_KEY = `HKCU:\\Software\\${PRODUCT}`;
const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const PROTOCOL_KEY = "HKCU:\\Software\\Classes\\kalcode";
const QUIET_PROCESS_OPTIONS = releaseProcessOptions({ stdio: "ignore" });
const WINDOWS_KALVOICE_FEATURE = "kalvoice-whisper";
const WINDOWS_NOTICE_RESOURCE_PATH = "third_party/kalvoice-notices";
const WINDOWS_UPDATER_TARGET = "windows-x86_64";

const version = appVersion();
const outDir = stagingDir(version);
const buildPath = join(outDir, "build.json");
if (!existsSync(buildPath)) fail(`No build record at ${buildPath}. Run pnpm release:build first.`);
const build = readJson(buildPath);
if (build.file !== expectedWindowsInstallerFile(version)) {
  fail("build record has an unsafe or version-mismatched installer file name");
}
const installer = join(outDir, build.file);

const report = {
  version,
  commit: build.commit,
  file: build.file,
  sha256: build.sha256,
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

function validateWindowsKalVoiceEvidence(build) {
  if (
    !Array.isArray(build.features) ||
    build.features.some((feature) => typeof feature !== "string" || !/^[a-z0-9-]+$/.test(feature)) ||
    new Set(build.features).size !== build.features.length
  ) {
    throw new Error("build record has invalid or duplicate Cargo feature evidence");
  }
  const included = build.features.includes(WINDOWS_KALVOICE_FEATURE);
  const evidence = build.kalvoice;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== "localSttFeature,localSttIncluded" ||
    evidence.localSttFeature !== WINDOWS_KALVOICE_FEATURE ||
    evidence.localSttIncluded !== included
  ) {
    throw new Error("build record does not truthfully describe the compiled KalVoice local STT feature");
  }
  if (build.requestedReleaseChannel === "stable" && !included) {
    throw new Error("stable Windows release does not include the local KalVoice STT engine");
  }
  return {
    localSttFeature: WINDOWS_KALVOICE_FEATURE,
    localSttIncluded: included,
    requiredForChannel: build.requestedReleaseChannel === "stable",
  };
}

function validateWindowsNoticeEvidence(build, verifiedSourceEvidence) {
  const evidence = build.notices;
  const expectedFields = "componentCount,files,noticeCount,resourcePath,schemaVersion,sourceVerifiedBeforeBuild";
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== expectedFields ||
    evidence.schemaVersion !== verifiedSourceEvidence.schemaVersion ||
    evidence.noticeCount !== verifiedSourceEvidence.noticeCount ||
    evidence.componentCount !== verifiedSourceEvidence.componentCount ||
    !Array.isArray(evidence.files) ||
    JSON.stringify(evidence.files) !== JSON.stringify(verifiedSourceEvidence.files) ||
    evidence.resourcePath !== WINDOWS_NOTICE_RESOURCE_PATH ||
    evidence.sourceVerifiedBeforeBuild !== true
  ) {
    throw new Error("build record has invalid or substituted KalVoice notice evidence");
  }
  return { ...evidence, files: [...evidence.files] };
}

function validateWindowsUpdaterV2Evidence(build) {
  const evidence = build.updaterV2;
  const expectedFields =
    "artifactFile,channel,channelBound,cryptographicallyVerified,publicKeyConfigured,schemaVersion,signatureFile,signatureStatus,target,targetBound,versionBound";
  const expectedSignatureFile = `${build.file}.windows-x86_64.sig`;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== expectedFields ||
    evidence.schemaVersion !== 2 ||
    evidence.artifactFile !== build.file ||
    evidence.signatureFile !== expectedSignatureFile ||
    evidence.signatureStatus !== "Valid" ||
    evidence.cryptographicallyVerified !== true ||
    evidence.versionBound !== true ||
    evidence.target !== WINDOWS_UPDATER_TARGET ||
    evidence.targetBound !== true ||
    evidence.channel !== build.requestedReleaseChannel ||
    !["stable", "beta", "dev"].includes(evidence.channel) ||
    evidence.channelBound !== true ||
    evidence.publicKeyConfigured !== true
  ) {
    throw new Error("build record has invalid or incomplete Windows updater v2 evidence");
  }
  return { ...evidence };
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
  // Preserve an existing handler even if an unrelated/stale installation owns it.
  if (protocolRegistration().exists) problems.push(`registry key ${PROTOCOL_KEY}`);
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

function protocolRegistration() {
  return powershellJson(`
    $key = Get-Item -LiteralPath ${psQuote(PROTOCOL_KEY)} -ErrorAction SilentlyContinue
    $command = Get-Item -LiteralPath ${psQuote(`${PROTOCOL_KEY}\\shell\\open\\command`)} -ErrorAction SilentlyContinue
    [pscustomobject]@{
      exists = ($null -ne $key)
      urlProtocol = ($null -ne $key -and $key.GetValueNames() -contains 'URL Protocol')
      command = $(if ($null -ne $command) { $command.GetValue('') } else { $null })
    } | ConvertTo-Json -Compress`);
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
  const result = spawnSync(uninstaller, ["/S"], QUIET_PROCESS_OPTIONS);
  if (result.error) throw result.error;
  await waitFor(
    () =>
      !existsSync(uninstaller) &&
      !existsSync(join(installDir, "kalcode.exe")) &&
      !existsSync(join(installDir, build.guardian.file)) &&
      registry(UNINSTALL_KEY) === null,
    120_000,
    "the silent uninstall to finish",
  );
}

/** One install → inspect → uninstall → inspect cycle in a fresh temp folder. */
async function pass(name, extraArgs, expectShortcuts, { rehearseUpdate = false } = {}) {
  console.log(`\nPass "${name}": silent install ${["/S", ...extraArgs].join(" ")} /D=<temp>`);
  const root = mkdtempSync(join(tmpdir(), "kalcode-release-verify-"));
  const requestedInstallDir = join(root, PRODUCT);
  if (/\s/.test(requestedInstallDir))
    throw new Error(`temp path contains spaces, which /D= cannot take: ${requestedInstallDir}`);
  let installDir = requestedInstallDir;
  const shortcuts = shortcutPaths();
  const result = { name, args: ["/S", ...extraArgs, "/D=<temp>\\KalCode"], requestedInstallDir, installDir };
  let updateSentinel = join(installDir, ".kalcode-update-rehearsal");
  function resolveInstalledDirectory() {
    result.installDirectoryIdentity = canonicalInstallDirectory(requestedInstallDir);
    installDir = result.installDirectoryIdentity.canonicalPath;
    result.installDir = installDir;
    updateSentinel = join(installDir, ".kalcode-update-rehearsal");
  }
  report.passes.push(result);
  let after = {};
  try {
    if (rehearseUpdate) {
      const baseline = spawnSync(installer, ["/S", "/NS", `/D=${requestedInstallDir}`], QUIET_PROCESS_OPTIONS);
      if (baseline.error) throw baseline.error;
      check(`${name}: baseline installer exit code 0`, baseline.status === 0, `exit ${baseline.status}`);
      resolveInstalledDirectory();
      check(`${name}: baseline kalcode.exe installed`, existsSync(join(installDir, "kalcode.exe")));
      writeFileSync(updateSentinel, "preserve-across-update\n", "utf8");
    }
    // /D= must be the last argument and unquoted (NSIS rule).
    const install = spawnSync(installer, ["/S", ...extraArgs, `/D=${requestedInstallDir}`], QUIET_PROCESS_OPTIONS);
    if (install.error) throw install.error;
    check(`${name}: installer exit code 0`, install.status === 0, `exit ${install.status}`);
    resolveInstalledDirectory();

    check(`${name}: kalcode.exe installed`, existsSync(join(installDir, "kalcode.exe")));
    check(`${name}: uninstall.exe installed`, existsSync(join(installDir, "uninstall.exe")));
    if (rehearseUpdate) {
      result.updateModeRehearsal =
        existsSync(updateSentinel) && readFileSync(updateSentinel, "utf8") === "preserve-across-update\n";
      check(`${name}: /UPDATE preserved an existing install sentinel`, result.updateModeRehearsal);
    }
    result.installedFiles = listFiles(installDir);

    let installedNotices;
    try {
      installedNotices = await verifyComponentNotices({
        noticeDirectory: join(installDir, ...WINDOWS_NOTICE_RESOURCE_PATH.split("/")),
      });
    } catch (error) {
      check(
        `${name}: installed KalVoice notices match the pinned source bytes`,
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
    result.installedNotices = {
      ...installedNotices,
      resourcePath: WINDOWS_NOTICE_RESOURCE_PATH,
    };
    check(
      `${name}: installed KalVoice notices match the pinned source bytes`,
      JSON.stringify(installedNotices) ===
        JSON.stringify({
          schemaVersion: build.notices.schemaVersion,
          noticeCount: build.notices.noticeCount,
          componentCount: build.notices.componentCount,
          files: build.notices.files,
        }),
    );

    const exe = join(installDir, "kalcode.exe");
    result.protocolRegistration = protocolRegistration();
    const protocolProblems = windowsProtocolProblems(result.protocolRegistration, exe);
    check(
      `${name}: per-user kalcode protocol targets the exact installed app with a quoted URL argument`,
      protocolProblems.length === 0,
      protocolProblems.join("; "),
    );
    result.installedAppSignature = authenticodeStatus(exe, powershellJson);
    check(
      `${name}: installed kalcode.exe has a valid Authenticode signature`,
      result.installedAppSignature.status === "Valid",
      result.installedAppSignature.status,
    );
    check(
      `${name}: installed kalcode.exe signature has a trusted timestamp`,
      result.installedAppSignature.timestamped === true,
    );
    result.installedAppSignerMatchesInstaller = sameAuthenticodeSigner(installer, exe, powershellJson);
    check(
      `${name}: installed kalcode.exe and installer use the same signing identity`,
      result.installedAppSignerMatchesInstaller,
    );
    const guardian = join(installDir, build.guardian.file);
    const guardianExists = existsSync(guardian);
    check(`${name}: provider guardian installed beside kalcode.exe`, guardianExists);
    const guardianSha256 = guardianExists ? await sha256File(guardian) : null;
    const guardianSignature = guardianExists
      ? authenticodeStatus(guardian, powershellJson)
      : { status: "Missing", timestamped: false };
    const guardianSignerMatchesInstaller =
      guardianExists && sameAuthenticodeSigner(installer, guardian, powershellJson);
    result.installedGuardian = {
      file: build.guardian.file,
      sha256: guardianSha256,
      signatureStatus: guardianSignature.status,
      timestamped: guardianSignature.timestamped,
      signerMatchesInstaller: guardianSignerMatchesInstaller,
    };
    const guardianProblems = guardianInstalledProblems({
      buildGuardian: build.guardian,
      exists: guardianExists,
      sha256: guardianSha256,
      signature: guardianSignature,
      sameSignerAsInstaller: guardianSignerMatchesInstaller,
    });
    check(
      `${name}: installed provider guardian matches the signed build hash and publisher`,
      guardianProblems.length === 0,
      guardianProblems.join("; "),
    );
    result.exeVersionInfo = powershellJson(
      `(Get-Item -LiteralPath ${psQuote(exe)}).VersionInfo | Select-Object ProductName, ProductVersion, FileVersion, CompanyName, FileDescription | ConvertTo-Json -Compress`,
    );
    check(`${name}: kalcode.exe product version is ${version}`, result.exeVersionInfo?.ProductVersion === version);
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
    // Always uninstall and clean up, even after a failed check, before reporting.
    rmSync(updateSentinel, { force: true });
    await uninstall(installDir);
    after = {
      protocolRegistration: protocolRegistration().exists,
      uninstallEntry: registry(UNINSTALL_KEY) !== null,
      installFolder: existsSync(installDir),
      desktopShortcut: existsSync(shortcuts.desktop),
      startMenuShortcut: existsSync(shortcuts.startMenu),
    };
    // By design the Tauri uninstaller keeps HKCUSoftwareKalCodeKalCode (the last install
    // location) unless "delete app data" is ticked. Preflight proved it did not exist, so this
    // run created it: remove it (only if it points at this temp folder) and record that.
    const leftover = registry(PRODUCT_KEY);
    result.leftoverInstallLocationKey = leftover?.["(default)"] ?? null;
    if (leftover?.["(default)"] === installDir) {
      powershell(`Remove-Item -LiteralPath ${psQuote(PRODUCT_KEY)} -Recurse -Force`);
      powershell(
        `$k = Get-Item -LiteralPath ${psQuote(MANUFACTURER_KEY)} -ErrorAction SilentlyContinue; if ($k -and $k.SubKeyCount -eq 0 -and $k.ValueCount -eq 0) { Remove-Item -LiteralPath ${psQuote(MANUFACTURER_KEY)} -Force }`,
      );
    }
    rmSync(root, { recursive: true, force: true });
  }

  result.afterUninstall = after;
  check(`${name}: uninstall entry removed`, !after.uninstallEntry);
  check(`${name}: kalcode protocol registration removed`, !after.protocolRegistration);
  check(`${name}: install folder removed`, !after.installFolder);
  check(
    `${name}: no shortcuts left`,
    !after.desktopShortcut && !after.startMenuShortcut,
    `${shortcuts.desktop}, ${shortcuts.startMenu}`,
  );
  check(`${name}: no KalCode registry keys left after cleanup`, registry(MANUFACTURER_KEY) === null);
}

console.log(`Verifying ${build.file} (${build.commit.slice(0, 12)})`);
try {
  const kalvoiceEvidence = validateWindowsKalVoiceEvidence(build);
  report.kalvoice = kalvoiceEvidence;
  check("build record truthfully reports the compiled KalVoice local STT feature", true);
  const verifiedNoticeSource = await verifyComponentNotices();
  const noticeEvidence = validateWindowsNoticeEvidence(build, verifiedNoticeSource);
  report.notices = { ...noticeEvidence, allInstallPassesVerified: false };
  check("build record matches the exact verified KalVoice notice corpus", true);
  const updaterV2 = validateWindowsUpdaterV2Evidence(build);
  const signingProblems = publicSigningProblems(build);
  check(
    "build record is eligible for public release signing",
    signingProblems.length === 0,
    signingProblems.join("; "),
  );
  const size = statSync(installer).size;
  check("staged installer size matches build.json", size === build.size, `${size} bytes`);
  const sha256 = await sha256File(installer);
  check("staged installer SHA-256 matches build.json", sha256 === build.sha256, sha256);
  const signature = authenticodeStatus(installer, powershellJson);
  report.signatureStatus = signature.status;
  report.timestamped = signature.timestamped;
  check("installer signature is valid", signature.status === "Valid", signature.status);
  check("installer signature has a trusted timestamp", signature.timestamped === true);
  check("installer signature status matches build.json", signature.status === build.signatureStatus, signature.status);
  report.publisherIdentityBound = artifactSigningIdentityMatchesPinned(
    authenticodeIdentityOids(installer, powershellJson),
  );
  check("installer carries the pinned durable Artifact Signing publisher identity", report.publisherIdentityBound);
  verifyUpdaterArtifact({
    artifactPath: installer,
    signaturePath: join(outDir, build.updater.signatureFile),
    version,
  });
  report.updater = { signatureStatus: "Valid", exactBytes: true, versionBound: true };
  check("updater signature verifies the exact installer bytes and version", true);
  verifyUpdaterArtifact({
    artifactPath: installer,
    signaturePath: join(outDir, updaterV2.signatureFile),
    version,
    target: updaterV2.target,
    channel: updaterV2.channel,
  });
  report.updaterV2 = {
    schemaVersion: 2,
    signatureFile: updaterV2.signatureFile,
    signatureStatus: "Valid",
    exactBytes: true,
    versionBound: true,
    target: updaterV2.target,
    targetBound: true,
    channel: updaterV2.channel,
    channelBound: true,
  };
  check("updater v2 signature verifies the exact installer, version, target, and channel", true);
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
  await pass("upgrade", ["/UPDATE"], false, { rehearseUpdate: true });
  const guardianPasses = report.passes.map((entry) => entry.installedGuardian);
  report.guardian = {
    file: build.guardian.file,
    sha256: build.guardian.sha256,
    signatureStatus: "Valid",
    timestamped: true,
    publisherIdentityBound: true,
    allInstallPassesVerified:
      guardianPasses.length === 3 &&
      guardianPasses.every(
        (guardian) =>
          guardian?.file === build.guardian.file &&
          guardian?.sha256 === build.guardian.sha256 &&
          guardian?.signatureStatus === "Valid" &&
          guardian?.timestamped === true &&
          guardian?.signerMatchesInstaller === true,
      ),
  };
  check("provider guardian verified in every install and upgrade pass", report.guardian.allInstallPassesVerified);
  const noticePasses = report.passes.map((entry) => entry.installedNotices);
  report.notices.allInstallPassesVerified =
    noticePasses.length === 3 &&
    noticePasses.every(
      (notices) =>
        notices?.resourcePath === WINDOWS_NOTICE_RESOURCE_PATH &&
        notices?.schemaVersion === build.notices.schemaVersion &&
        notices?.noticeCount === build.notices.noticeCount &&
        notices?.componentCount === build.notices.componentCount &&
        JSON.stringify(notices?.files) === JSON.stringify(build.notices.files),
    );
  check(
    "exact KalVoice notice bytes verified in every install and upgrade pass",
    report.notices.allInstallPassesVerified,
  );
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
