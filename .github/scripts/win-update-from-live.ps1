<#
win-update-from-live.ps1 -- fast-lane automated update-from-live check (owner fast-lane policy 2026-10-02), Windows.
Runs as a NON-owner account on a profile that has never run KalCode (the kalcode-ci gate account, via the
update-from-live workflow in ..\workflow\), never as Kaleb. No test hooks, no seeded data, no bypass: the signed live
installer from kalcoded.com and the signed candidate installer, exactly as users get them.

  1. install the LIVE Stable build from its public URL (bytes must equal -LiveSha256), launch it, wait for app.started <live>,
     close it by its window (never killed), snapshot the database (read-only copy) and the rollback floor
  2. run the CANDIDATE installer with /S /UPDATE (exactly InstallerMode::AfterExit, the arguments the in-app updater uses),
     launch it, wait for app.started <candidate>, close it by its window
  3. assert: candidate installed + running version, schema = max migration in C, every pre-existing table and row unchanged
     except schema_migrations (dataKept), and for a data-changing build rollback-floor == candidate (restoreGuard: Restore
     previous version can never offer the older build, guard_forward_only_schema_upgrade)
  4. uninstall and remove this account's KalCode data (later gate jobs share the profile); fail closed on any leftover
Writes <OutDir>\update-from-live-receipt.json (+ evidence). Exit 0 = PASS.

  -SelfTest: parses arguments, checks the account rule and the receipt shape with no install (used by the dry run).
#>
param(
  [string]$LiveUrl = '', [string]$LiveSha256 = '', [string]$LiveVersion = '',
  [string]$CandidateInstaller = '', [string]$CandidateSha256 = '', [string]$CandidateVersion = '',
  [int]$ExpectSchema = 0, [switch]$ChangesData,
  [Parameter(Mandatory)][string]$OutDir,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Force -Path $OutDir
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$me = [Diagnostics.Process]::GetCurrentProcess().SessionId
$AppData = Join-Path $env:APPDATA 'com.kalcode.desktop'
$LocalData = Join-Path $env:LOCALAPPDATA 'com.kalcode.desktop'
$Floor = Join-Path $AppData 'updates\rollback-floor'
$Db = Join-Path $AppData 'kalcode.db'
$receipt = [ordered]@{
  schema = 'kalcode-fast-update-from-live/v1'; platform = 'windows-x86_64'; status = 'FAILED'
  account = $id.Name; session = $me; startedAt = [DateTime]::UtcNow.ToString('o')
  live = [ordered]@{ version = $LiveVersion; url = $LiveUrl; sha256 = $LiveSha256 }
  candidate = [ordered]@{ version = $CandidateVersion; sha256 = $CandidateSha256 }
  changesData = [bool]$ChangesData; expectSchema = $ExpectSchema
  checks = [ordered]@{ install = $false; launch = $false; updateFromLive = $false; dataKept = $false; restoreGuard = $null }
  safeguards = [ordered]@{ authenticationBypassed = $false; cacheSeeded = $false; fixtureOnly = $false; testHooks = $false; tlsBypassed = $false }
  steps = @(); closes = @()
}
function Note([string]$l) { Write-Host $l; $receipt.steps += ('[{0}] {1}' -f [DateTime]::UtcNow.ToString('HH:mm:ss'), $l) }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function Refuse([string]$m) { throw "REFUSED: $m" }
# KalCode keeps its log and other files open; read them with shared access (ReadAllLines/ReadAllText refuse an open file).
function Read-Shared([string]$p) {
  $fs = New-Object IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try { $sr = New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding $false), $true); $sr.ReadToEnd() } finally { $fs.Dispose() }
}
function Save { [IO.File]::WriteAllText((Join-Path $OutDir 'update-from-live-receipt.json'), ($receipt | ConvertTo-Json -Depth 8) + "`n", (New-Object Text.UTF8Encoding $false)) }
function KalProcs { @(Get-Process -Name kalcode, kalcode-provider-guardian, kalcode-update-helper -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $me }) }
function InstallDir {
  $u = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode' -ErrorAction SilentlyContinue
  if (-not $u) { return $null }; $d = ([string]$u.InstallLocation).Trim('"'); if (-not $d) { $d = Split-Path -Parent ([string]$u.UninstallString).Trim('"') }; $d
}
function Run-Installer([string]$exe, [string[]]$args2) {
  $p = Start-Process -FilePath $exe -ArgumentList $args2 -PassThru -Wait
  if ($p.ExitCode -ne 0) { Refuse "$([IO.Path]::GetFileName($exe)) $($args2 -join ' ') exited $($p.ExitCode)" }
  $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not (InstallDir) -and $sw.Elapsed.TotalSeconds -lt 60) { Start-Sleep -Seconds 2 }
  if (-not (InstallDir)) { Refuse 'no KalCode uninstall entry after the installer' }
}
function Wait-Started([string]$version, [DateTime]$since, [int]$sec = 180) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $sec) {
    foreach ($lf in @(Get-ChildItem -LiteralPath (Join-Path $AppData 'logs') -Filter 'kalcode.*.log' -ErrorAction SilentlyContinue)) {
      foreach ($l in ((Read-Shared $lf.FullName) -split "`r?`n")) {
        if ($l -match '"event":"app\.started"' -and $l -match '"timestamp":"([^"]+)"' -and [DateTime]::Parse($Matches[1]).ToUniversalTime() -ge $since) {
          if ($l -match ('"version":"' + [regex]::Escape($version) + '"')) { return $l }
          Refuse "app.started reports another version: $l"
        }
      }
    }
    if (-not (KalProcs).Count) { Refuse "KalCode exited before app.started $version" }
    Start-Sleep -Seconds 2
  }
  Refuse "no app.started $version within ${sec}s"
}
function Launch([string]$version) {
  $exe = Join-Path (InstallDir) 'kalcode.exe'; if (-not (Test-Path -LiteralPath $exe)) { Refuse "no kalcode.exe in $(InstallDir)" }
  $t = [DateTime]::UtcNow.AddSeconds(-1); $null = Start-Process -FilePath $exe -PassThru
  $line = Wait-Started $version $t; Note "launched $version : $line"; Start-Sleep -Seconds 10; $line
}
function Close-App {
  # Graceful first: WM_CLOSE to KalCode's own window. The gate runner is a service (session 0), where taskkill without /F
  # can't close windows, so this uses Process.CloseMainWindow, then falls back to Stop-Process -Force on this account's
  # KalCode processes in this session only. The method is recorded; the data checks run on the closed database either way.
  $procs = @(KalProcs | Where-Object { $_.Name -eq 'kalcode' })
  if (-not $procs.Count) { return 'not-running' }
  foreach ($p in $procs) { try { [void]$p.CloseMainWindow() } catch {} }
  $sw = [Diagnostics.Stopwatch]::StartNew(); while ((KalProcs).Count -and $sw.Elapsed.TotalSeconds -lt 45) { Start-Sleep -Seconds 2 }
  $how = 'window'
  if ((KalProcs).Count) {
    $how = 'forced'; Note ('graceful close did not end ' + ((KalProcs | ForEach-Object { "$($_.Name)#$($_.Id)" }) -join ', ') + '; Stop-Process -Force')
    KalProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    $sw.Restart(); while ((KalProcs).Count -and $sw.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Seconds 1 }
  }
  if ((KalProcs).Count) { Refuse ('KalCode processes survived Stop-Process -Force: ' + ((KalProcs | ForEach-Object { "$($_.Name)#$($_.Id)@s$($_.SessionId)" }) -join ', ')) }
  $receipt.closes += $how; Note "closed KalCode ($how)"; $how
}
function Db-Snapshot([string]$label) {
  if (-not (Test-Path -LiteralPath $Db)) { Refuse "no database at $Db" }
  $copy = Join-Path $OutDir "$label.db"; Copy-Item -LiteralPath $Db -Destination $copy -Force
  foreach ($s in '-wal', '-shm') { if (Test-Path -LiteralPath "$Db$s") { Copy-Item -LiteralPath "$Db$s" -Destination "$copy$s" -Force } }
  $py = @'
import hashlib, json, sqlite3, sys
c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
out = {"schema": c.execute("SELECT COALESCE(MAX(version),0) FROM schema_migrations").fetchone()[0], "tables": {}}
for (name,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
    cols = [r[1] for r in c.execute(f'PRAGMA table_info("{name}")')]
    h = hashlib.sha256(); n = 0
    for row in c.execute(f'SELECT * FROM "{name}" ORDER BY rowid' if name != "schema_migrations" else f'SELECT * FROM "{name}" ORDER BY 1'):
        h.update(json.dumps(row, default=str).encode()); n += 1
    out["tables"][name] = {"columns": cols, "rows": n, "sha256": h.hexdigest()}
print(json.dumps(out, sort_keys=True))
'@
  $pyFile = Join-Path $OutDir 'db-digest.py'; [IO.File]::WriteAllText($pyFile, $py)
  $j = (& python -I -B $pyFile $copy | Out-String).Trim(); if ($LASTEXITCODE -ne 0 -or -not $j) { Refuse "database digest failed for $label" }
  [IO.File]::WriteAllText((Join-Path $OutDir "$label.digest.json"), $j + "`n"); $j | ConvertFrom-Json
}
function Leftovers {
  $run = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  [ordered]@{
    uninstallEntry = Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode'
    installFolder = (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'KalCode')) -or (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'))
    protocolRegistration = Test-Path -LiteralPath 'HKCU:\Software\Classes\kalcode'
    productKey = Test-Path -LiteralPath 'HKCU:\Software\KalCode'
    runValue = [bool]($run -and @($run.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' -and [string]$_.Value -match '(?i)kalcode' }).Count)
    appData = (Test-Path -LiteralPath $AppData) -or (Test-Path -LiteralPath $LocalData)
    shortcuts = (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KalCode.lnk')) -or (Test-Path -LiteralPath (Join-Path $programs 'KalCode.lnk')) -or (Test-Path -LiteralPath (Join-Path $programs 'KalCode'))
    processes = [bool](KalProcs).Count
  }
}
function Cleanup {
  try { $null = Close-App } catch { Note "cleanup close: $_" }
  $d = InstallDir
  if ($d) { $un = Join-Path $d 'uninstall.exe'; if (Test-Path -LiteralPath $un) { $p = Start-Process -FilePath $un -ArgumentList '/S' -PassThru -Wait; Start-Sleep -Seconds 8; Note "uninstall exit $($p.ExitCode)" } }
  KalProcs | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($k in 'HKCU:\Software\KalCode', 'HKCU:\Software\Classes\kalcode', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode') {
    if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue; Note "removed $k" }
  }
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $rv = Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
  if ($rv) { foreach ($n in @($rv.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' -and [string]$_.Value -match '(?i)kalcode' } | ForEach-Object Name)) { Remove-ItemProperty -LiteralPath $runKey -Name $n -ErrorAction SilentlyContinue; Note "removed Run value $n" } }
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  foreach ($p in $AppData, $LocalData, (Join-Path $env:LOCALAPPDATA 'KalCode'), (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KalCode.lnk'), (Join-Path $programs 'KalCode.lnk'), (Join-Path $programs 'KalCode')) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $left = Leftovers
  $receipt.postCheck = $left
  if ($left.Values -contains $true) { Note ('LEFTOVER: ' + ($left | ConvertTo-Json -Compress)); return $false }
  return $true
}

try {
  if ($id.Name -match '\\Kaleb$') { Refuse 'never on the owner account: run as the kalcode-ci gate account (fast-lane rule)' }
  foreach ($k in 'LiveSha256', 'CandidateSha256') { if ((Get-Variable $k).Value -cnotmatch '^[0-9a-f]{64}$') { Refuse "$k must be a lowercase SHA-256" } }
  foreach ($k in 'LiveVersion', 'CandidateVersion') { if ((Get-Variable $k).Value -notmatch '^[0-9]+\.[0-9]+\.[0-9]+\+[1-9][0-9]*$') { Refuse "$k must be X.Y.Z+N" } }
  if ($LiveUrl -notmatch '^https://kalcoded\.com/(download|releases)/[A-Za-z0-9._+%/-]{1,200}\.exe$') { Refuse 'LiveUrl must be a kalcoded.com installer URL' }
  if ($ExpectSchema -lt 1) { Refuse 'ExpectSchema (the highest migration number in C) is required' }
  if ($SelfTest) { $receipt.status = 'SELFTEST'; Save; Write-Host 'SELFTEST PASS'; exit 0 }
  $pre = Leftovers; $receipt.preCheck = $pre
  if ($pre.Values -contains $true) {
    Note ('profile had KalCode leftovers from an earlier job: ' + ($pre | ConvertTo-Json -Compress) + '; cleaning first')
    if (-not (Cleanup)) { Refuse 'could not clean KalCode leftovers from this profile before the check' }
    $receipt.postCheck = $null
  }
  if (-not (Test-Path -LiteralPath $CandidateInstaller)) { Refuse "no candidate installer $CandidateInstaller" }
  if ((Sha $CandidateInstaller) -ne $CandidateSha256) { Refuse 'candidate installer is not the pinned SHA-256' }
  $sig = Get-AuthenticodeSignature -LiteralPath $CandidateInstaller; if ($sig.Status -ne 'Valid') { Refuse "candidate Authenticode $($sig.Status)" }

  # 1. live
  $live = Join-Path $OutDir ('live-' + [IO.Path]::GetFileName(([Uri]$LiveUrl).AbsolutePath))
  Invoke-WebRequest -UseBasicParsing -Uri $LiveUrl -OutFile $live -TimeoutSec 900
  if ((Sha $live) -ne $LiveSha256) { Refuse "the public live installer is $(Sha $live), not $LiveSha256" }
  Run-Installer $live @('/S'); Note "installed live $LiveVersion into $(InstallDir)"
  $null = Launch $LiveVersion; $null = Close-App
  $pre = Db-Snapshot 'db-live'; $floorPre = if (Test-Path -LiteralPath $Floor) { (Read-Shared $Floor).Trim() } else { $null }
  Note "live database schema $($pre.schema), $(@($pre.tables.PSObject.Properties).Count) tables; floor '$floorPre'"

  # 2. candidate over live, exactly the in-app updater's after-exit install
  Run-Installer $CandidateInstaller @('/S', '/UPDATE'); Note "candidate $CandidateVersion installed over live with /S /UPDATE"
  $receipt.checks.install = $true
  $null = Launch $CandidateVersion; $receipt.checks.launch = $true
  $null = Close-App
  $post = Db-Snapshot 'db-candidate'; $floorPost = if (Test-Path -LiteralPath $Floor) { (Read-Shared $Floor).Trim() } else { $null }
  $receipt.checks.updateFromLive = $true

  # 3. data kept: every live table still exists with identical columns/rows (schema_migrations may only grow)
  $diffs = @()
  foreach ($t in $pre.tables.PSObject.Properties) {
    $after = $post.tables.($t.Name)
    if (-not $after) { $diffs += "table $($t.Name) is gone"; continue }
    if ($t.Name -eq 'schema_migrations') { if ($after.rows -lt $t.Value.rows) { $diffs += 'schema_migrations lost rows' }; continue }
    if ($after.rows -ne $t.Value.rows) { $diffs += "$($t.Name) rows $($t.Value.rows) -> $($after.rows)" }
    elseif ($after.sha256 -ne $t.Value.sha256 -and (@($after.columns) -join ',') -eq (@($t.Value.columns) -join ',')) { $diffs += "$($t.Name) row contents changed" }
  }
  if ($post.schema -ne $ExpectSchema) { $diffs += "schema $($post.schema), expected $ExpectSchema" }
  $receipt.dataCompare = [ordered]@{ liveSchema = $pre.schema; candidateSchema = $post.schema; differences = $diffs }
  if ($diffs.Count) { Refuse ('data not kept: ' + ($diffs -join '; ')) }
  $receipt.checks.dataKept = $true
  $receipt.floor = [ordered]@{ before = $floorPre; after = $floorPost }
  if ($ChangesData) {
    if ($floorPost -ne $CandidateVersion) { Refuse "rollback-floor is '$floorPost' after the migrating launch, expected $CandidateVersion (Restore could offer an older build)" }
    $receipt.checks.restoreGuard = $true; Note "restoreGuard: rollback-floor = $floorPost, so Restore previous version can never offer $LiveVersion"
  }
  $receipt.status = 'PASS'
} catch {
  $receipt.error = "$_"; Write-Host "FAILED: $_" -ForegroundColor Red
} finally {
  if (-not $SelfTest) { $clean = Cleanup; if (-not $clean -and $receipt.status -eq 'PASS') { $receipt.status = 'FAILED'; $receipt.error = 'KalCode left something behind in this profile' } }
  $receipt.finishedAt = [DateTime]::UtcNow.ToString('o'); Save
}
if ($receipt.status -eq 'PASS') { Write-Host 'UPDATE-FROM-LIVE PASS'; exit 0 } else { exit 1 }
