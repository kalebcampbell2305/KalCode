import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../../.github/scripts/", import.meta.url));
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
function powershell(command) {
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("desktop QA PowerShell parses without running installers or touching a profile", {
  skip: process.platform !== "win32",
}, () => {
  powershell(`$ErrorActionPreference='Stop'; foreach ($name in 'desktop-process-safety.ps1','desktop-clean-packet.ps1','win-desktop-package-proof.ps1','win-desktop-update-from-feed.ps1') {
    $errors=$null; $tokens=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path ${psQuote(scripts)} $name),[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
  }`);
});

test("owned process close rejects foreign identities and reused PIDs before any window action", {
  skip: process.platform !== "win32",
}, () => {
  powershell(`$ErrorActionPreference='Stop'
    function Refuse([string]$message) { throw $message }; function Note {}
    . (Join-Path ${psQuote(scripts)} 'desktop-process-safety.ps1')
    $id = @{User=@{Value='S-QA'}}; $me=7
    $script:mockIdentity=@{pid=123;sid='S-QA';session=7;exe='C:\\qa\\kalcode.exe';created='2026-10-04T12:00:00.0000000Z'}
    function Process-Identity { $script:mockIdentity }
    function Expect-Refusal([scriptblock]$action) { $refused=$false; try { & $action } catch { $refused=$true }; if (-not $refused) { throw 'unsafe action was accepted' } }
    $script:closed=0
    $p=[pscustomobject]@{Id=123;Handle=1;StartTime=[DateTime]'2026-10-04T12:00:00Z';HasExited=$false;MainWindowHandle=[IntPtr]42}
    $p | Add-Member ScriptMethod Refresh {}
    $p | Add-Member ScriptMethod CloseMainWindow { $script:closed++; $true }
    $p | Add-Member ScriptMethod WaitForExit { $true }
    Expect-Refusal { Close-Exact 123 }
    $null=Bind-App $p 'C:\\qa\\kalcode.exe' ([DateTime]'2026-10-04T11:00:00Z')
    foreach ($key in 'pid','sid','session','exe','created') {
      $original=$script:mockIdentity; $script:mockIdentity=$original.Clone(); $script:mockIdentity[$key]='wrong'
      Expect-Refusal { Close-Exact 123 }; $script:mockIdentity=$original
    }
    if ($script:closed -ne 0) { throw 'unsafe window action occurred' }
    $result=Close-Exact 123
    if (-not $result.accepted -or -not $result.exited -or $script:closed -ne 1) { throw 'owned normal close failed' }
    function KalProcs { $script:running }
    $script:running=@(); Expect-Refusal { Assert-CleanupAllowed }
    $script:QaStateOwned=$true; $script:running=@('occupied'); Expect-Refusal { Assert-CleanupAllowed }
    $script:running=@(); $script:PendingInstaller=@{}; Expect-Refusal { Assert-CleanupAllowed }
    $script:PendingInstaller=$null; Assert-CleanupAllowed
    Expect-Refusal { Assert-CleanupPath 'C:\\owner\\data' 'C:\\qa' }
  `);
});

test("clean packet paths reject traversal, alternate streams, absolute and Windows device paths", {
  skip: process.platform !== "win32",
}, () => {
  powershell(`$ErrorActionPreference='Stop'; function Refuse([string]$message) { throw $message }
    . (Join-Path ${psQuote(scripts)} 'desktop-clean-packet.ps1')
    foreach ($path in '../owner','/owner','C:/owner','one//two','one/../two','file:stream','CON','a/NUL.txt','a/file.','a\\b') {
      $refused=$false; try { Assert-PacketName $path } catch { $refused=$true }; if (-not $refused) { throw "accepted unsafe path $path" }
    }
    Assert-PacketName 'dist/release/0.1.9+1480/KalCode_0.1.9_build1480_x64-setup.exe'
  `);
});

test("Windows CIM and retained process creation identity agree at native timestamp precision", {
  skip: process.platform !== "win32",
}, () => {
  powershell(`$ErrorActionPreference='Stop'; function Refuse([string]$message) { throw $message }
    . (Join-Path ${psQuote(scripts)} 'desktop-process-safety.ps1')
    $id=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=[Diagnostics.Process]::GetCurrentProcess(); $me=$p.SessionId
    $null=Bind-App $p $p.MainModule.FileName $p.StartTime.ToUniversalTime().AddSeconds(-1)
    $bound=Assert-OwnedApp $p.Id; if ($bound.Id -ne $p.Id) { throw 'identity mismatch' }
  `);
});

test("failed close and occupied state cannot be cleaned or reported as passing", () => {
  const controller = readFileSync(`${scripts}/win-desktop-update-from-feed.ps1`, "utf8");
  const safety = readFileSync(`${scripts}/desktop-process-safety.ps1`, "utf8");
  assert.doesNotMatch(controller + safety, /Stop-Process|taskkill|\.Kill\(/iu);
  assert.match(controller, /QA profile already contains KalCode state; preserving it/u);
  assert.match(controller, /if \(\$script:QaStateOwned\) \{/u);
  assert.match(controller, /else \{ try \{ \$receipt.cleanupClean = Cleanup/u);
  assert.match(controller, /cleanupClean -ne \$true -or \$receipt\.forcedProcessActions -ne 0/u);
  assert.match(controller, /\$receipt\.status = 'FAILED'; \$receipt\.error = 'clean natural shutdown required/u);
});

test("NSIS copied uninstaller must finish before cleanup; timeout preserves the profile", {
  skip: process.platform !== "win32",
}, () => {
  powershell(`$ErrorActionPreference='Stop'; function Refuse([string]$message) { throw $message }
    . (Join-Path ${psQuote(scripts)} 'desktop-process-safety.ps1')
    $script:sleeps=0
    function Start-Sleep { $script:sleeps++ }
    function Test-Path { $script:sleeps -lt 3 }
    $script:QaStateOwned=$true; Wait-UninstallComplete 'C:\\qa' 3
    if ($script:sleeps -ne 3 -or -not $script:QaStateOwned) { throw 'uninstall completion was not observed' }
    function Test-Path { $true }
    $refused=$false; try { Wait-UninstallComplete 'C:\\qa' 0 } catch { $refused=$true }
    if (-not $refused -or $script:QaStateOwned) { throw 'unfinished uninstall was not preserved' }
  `);
});
