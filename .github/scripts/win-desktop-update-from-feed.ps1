<#
win-desktop-update-from-feed.ps1 -- Windows production update delivery check on a real interactive desktop.
Runs only as the dedicated kalcode-qa account in its own signed-in desktop session (the kalcode-desktop-qa runner on the
second Windows PC), never on the owner's PC or account and never in session 0, where KalCode's window stays hidden and a
normal close cannot be proven. No test hooks, no seeded data: the public signed live installer and the real Stable feed.

  0. refuse unless the production Stable feed already serves the exact candidate (version, commit, Windows SHA-256)
  1. install the live build from its immutable public URL (bytes must equal -LiveSha256, Authenticode Valid) and launch it
  2. wait for the live build's own updater to download and stage the exact candidate from the feed for exit
  3. close KalCode by its window (WM_CLOSE to the exact PID) and require that PID to exit
  4. require the staged candidate to be installed after exit (signed, FileVersion = candidate) and record any relaunch
  5. reopen the candidate, require app.started <candidate> and a healthy updater journal, close it by its window
  6. uninstall and remove this QA account's KalCode data so the next run starts clean
Writes <OutDir>\desktop-update-receipt.json. Exit 0 = PASS.
Optional -CandidateTag qa-... -ExpectSchema N downloads a private draft's exact signed package and proves a manual
/S /UPDATE transition plus actual SQLite preservation. That mode never claims normal updater delivery and is only
for unchanged updater behavior. Migrations additionally require -ChangesData -LiveSchema N.
#>
param(
  [string]$LiveUrl = '', [string]$LiveSha256 = '', [string]$LiveVersion = '',
  [string]$CandidateVersion = '', [string]$CandidateSha256 = '', [string]$CandidateCommit = '',
  [string]$CandidateTag = '', [int]$ExpectSchema = 0, [int]$LiveSchema = 0, [switch]$ChangesData,
  [string]$FeedUrl = 'https://kalcoded.com/releases/updater/stable.json',
  [int]$StageTimeoutSec = 900,
  [Parameter(Mandatory)][string]$OutDir,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Force -Path $OutDir
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$me = [Diagnostics.Process]::GetCurrentProcess().SessionId
$AppData = Join-Path $env:APPDATA 'com.kalcode.desktop'
$LocalData = Join-Path $env:LOCALAPPDATA 'com.kalcode.desktop'
$Updates = Join-Path $AppData 'updates'
$receipt = [ordered]@{
  schema = 'kalcode-windows-desktop-feed-delivery/v1'; status = 'FAILED'; platform = 'windows-x86_64'
  account = $id.Name; session = $me; computer = $env:COMPUTERNAME
  live = [ordered]@{ version = $LiveVersion; sha256 = $LiveSha256; url = $LiveUrl }
  candidate = [ordered]@{ version = $CandidateVersion; commit = $CandidateCommit; sha256 = $CandidateSha256 }
  feed = $null; staged = $null; liveClose = $null; applied = $null; reopen = $null; candidateClose = $null
  journal = $null; autoRelaunched = $null; forcedProcessActions = 0; cleanupClean = $null
  normalUpdaterDeliveryProven = $false
  steps = @(); startedAt = [DateTime]::UtcNow.ToString('o'); finishedAt = $null; error = $null
}
function Note([string]$l) { Write-Host $l; $receipt.steps += ('[{0}] {1}' -f [DateTime]::UtcNow.ToString('HH:mm:ss'), $l) }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
function Refuse([string]$m) { throw "REFUSED: $m" }
function Save { [IO.File]::WriteAllText((Join-Path $OutDir 'desktop-update-receipt.json'), ($receipt | ConvertTo-Json -Depth 8) + "`n", (New-Object Text.UTF8Encoding $false)) }
# KalCode keeps its log and state files open; read them with shared access.
function Read-Shared([string]$p) {
  $fs = New-Object IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try { $sr = New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding $false), $true); $sr.ReadToEnd() } finally { $fs.Dispose() }
}
function Read-Json([string]$p) { if (Test-Path -LiteralPath $p) { try { (Read-Shared $p) | ConvertFrom-Json } catch { $null } } else { $null } }
function KalProcs { @(Get-Process -Name kalcode, kalcode-provider-guardian, kalcode-update-helper -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $me }) }
function InstallDir {
  $u = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode' -ErrorAction SilentlyContinue
  if (-not $u) { return $null }; $d = ([string]$u.InstallLocation).Trim('"'); if (-not $d) { $d = Split-Path -Parent ([string]$u.UninstallString).Trim('"') }
  if ($CandidateTag -and [IO.Path]::GetFullPath($d) -notin @((Join-Path $env:LOCALAPPDATA 'KalCode'), (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'))) { Refuse 'package install path escapes the dedicated QA profile' }
  if ($CandidateTag -and (Test-Path -LiteralPath $d) -and ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Refuse 'package install path is a reparse point' }
  $d
}
function Installed {
  $d = InstallDir; if (-not $d) { return $null }
  $exe = Join-Path $d 'kalcode.exe'; if (-not (Test-Path -LiteralPath $exe)) { return $null }
  $vi = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
  [ordered]@{ exe = $exe; fileVersion = $vi.FileVersion; productVersion = $vi.ProductVersion; sha256 = (Sha $exe); signature = [string](Get-AuthenticodeSignature -LiteralPath $exe).Status }
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
    if (-not @(KalProcs | Where-Object { $_.Name -eq 'kalcode' }).Count) { Refuse "KalCode exited before app.started $version" }
    Start-Sleep -Seconds 2
  }
  Refuse "no app.started $version within ${sec}s"
}
function Launch([string]$version) {
  $i = Installed; if (-not $i) { Refuse 'no installed kalcode.exe to launch' }
  $t = [DateTime]::UtcNow.AddSeconds(-1); $p = Start-Process -FilePath $i.exe -PassThru
  $line = Wait-Started $version $t; Note "launched $version as PID $($p.Id): $line"
  # The main window must exist and be visible in this interactive session before a normal close can be proven.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 60) { $p.Refresh(); if ($p.MainWindowHandle -ne [IntPtr]::Zero) { break }; Start-Sleep -Seconds 1 }
  if ($p.MainWindowHandle -eq [IntPtr]::Zero) { Refuse "PID $($p.Id) has no main window after 60s" }
  if ($CandidateTag) { $script:PackageProcess = @{ pid = $p.Id; startedAt = $p.StartTime.ToUniversalTime().ToString('o'); exe = $i.exe } }
  [ordered]@{ pid = $p.Id; startedAt = $p.StartTime.ToUniversalTime().ToString('o'); window = [int64]$p.MainWindowHandle; appStarted = $line }
}
function Close-Exact([int]$procId, [int]$sec = 120) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $p) { return [ordered]@{ pid = $procId; method = 'already-exited'; exited = $true; seconds = 0 } }
  if ($CandidateTag -and (-not $script:PackageProcess -or $script:PackageProcess.pid -ne $procId -or $p.SessionId -ne $me -or $p.StartTime.ToUniversalTime().ToString('o') -cne $script:PackageProcess.startedAt -or $p.Path -cne $script:PackageProcess.exe)) { Refuse 'normal close target is not the exact task-launched QA process' }
  $requested = [DateTime]::UtcNow; $accepted = $p.CloseMainWindow()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $sec -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }
  $exited = -not (Get-Process -Id $procId -ErrorAction SilentlyContinue)
  $r = [ordered]@{ pid = $procId; method = 'Process.CloseMainWindow (WM_CLOSE)'; accepted = $accepted; requestedAt = $requested.ToString('o'); exited = $exited; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
  Note "close PID $procId accepted=$accepted exited=$exited after $($r.seconds)s"
  $r
}
function Leftovers {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  [ordered]@{
    uninstallEntry = Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode'
    installFolder = (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'KalCode')) -or (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'))
    appData = (Test-Path -LiteralPath $AppData) -or (Test-Path -LiteralPath $LocalData)
    shortcuts = (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KalCode.lnk')) -or (Test-Path -LiteralPath (Join-Path $programs 'KalCode.lnk')) -or (Test-Path -LiteralPath (Join-Path $programs 'KalCode'))
    processes = [bool](KalProcs).Count
  }
}
function Cleanup {
  if ($CandidateTag -and ($receipt.status -ne 'PASS' -or @(KalProcs).Count)) { Refuse 'preserve unsuccessful package proof and any running QA process; no forced cleanup' }
  # This is the dedicated QA account: after normal closes, any remaining KalCode process of this session is stopped so the
  # next run starts clean. Each forced action is counted in the receipt.
  if (-not $CandidateTag) {
    foreach ($p in @(KalProcs | Where-Object { $_.Name -eq 'kalcode' })) { $null = Close-Exact $p.Id 30 }
    $left = @(KalProcs); if ($left.Count) { $receipt.forcedProcessActions += $left.Count; $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
  }
  $d = InstallDir
  if ($CandidateTag -and $d) {
    $uninstallerSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $d 'uninstall.exe')
    if ($uninstallerSignature.Status -ne 'Valid' -or $uninstallerSignature.SignerCertificate.Subject -cne $candidatePackage.signer) { Refuse 'QA cleanup uninstaller signature/publisher mismatch' }
  }
  if ($d) { $un = Join-Path $d 'uninstall.exe'; if (Test-Path -LiteralPath $un) { $p = Start-Process -FilePath $un -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait; Start-Sleep -Seconds 8; Note "uninstall exit $($p.ExitCode)" } }
  foreach ($k in 'HKCU:\Software\KalCode', 'HKCU:\Software\Classes\kalcode', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode') {
    if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $rv = Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
  if ($rv) { foreach ($n in @($rv.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' -and [string]$_.Value -match '(?i)kalcode' } | ForEach-Object Name)) { Remove-ItemProperty -LiteralPath $runKey -Name $n -ErrorAction SilentlyContinue } }
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  # WebView2 and the uninstaller can hold files for a few seconds after exit, so retry the data removal briefly.
  $paths = @($AppData, $LocalData, (Join-Path $env:LOCALAPPDATA 'KalCode'), (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KalCode.lnk'), (Join-Path $programs 'KalCode.lnk'), (Join-Path $programs 'KalCode'))
  if ($CandidateTag) {
    foreach ($path in $paths) {
      if (-not [IO.Path]::GetFullPath($path).StartsWith($env:USERPROFILE + '\', [StringComparison]::OrdinalIgnoreCase)) { Refuse 'cleanup path escapes the QA profile' }
      for ($node = $path; $node -and $node -ne $env:USERPROFILE; $node = Split-Path -Parent $node) {
        if ((Test-Path -LiteralPath $node) -and ((Get-Item -LiteralPath $node -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Refuse 'cleanup path contains a reparse point' }
      }
    }
  }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue } }
    if (-not @($paths | Where-Object { Test-Path -LiteralPath $_ }).Count) { break }
    Start-Sleep -Seconds 3
  }
  $left = Leftovers
  if ($left.Values -contains $true) { Note ('LEFTOVER: ' + ($left | ConvertTo-Json -Compress)); return $false }
  $true
}

# Cleanup closes, uninstalls and deletes KalCode data, so it may run only after every account and session guard passed.
$guardsPassed = $false
try {
  # Account and session rules come first: this check closes and reinstalls KalCode, so it must never reach the owner.
  $elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($id.Name -notmatch '\\kalcode-qa$') { Refuse "runs only as the dedicated kalcode-qa account (got $($id.Name))" }
  if ($elevated) { Refuse 'must not run elevated' }
  if ($me -eq 0) { Refuse 'session 0 has no visible desktop; run in the signed-in kalcode-qa session' }
  if ($env:COMPUTERNAME -eq 'DESKTOP-KOOB7VV') { Refuse "never on the owner's build PC" }
  foreach ($k in 'LiveSha256', 'CandidateSha256') { if ((Get-Variable $k).Value -cnotmatch '^[0-9a-f]{64}$') { Refuse "$k must be a lowercase SHA-256" } }
  if ($CandidateCommit -cnotmatch '^[0-9a-f]{40}$') { Refuse 'CandidateCommit must be a 40-hex commit' }
  foreach ($k in 'LiveVersion', 'CandidateVersion') { if ((Get-Variable $k).Value -notmatch '^[0-9]+\.[0-9]+\.[0-9]+\+[1-9][0-9]*$') { Refuse "$k must be X.Y.Z+N" } }
  if ($LiveUrl -notmatch '^https://kalcoded\.com/releases/updater/stable/[A-Za-z0-9._+%/-]{1,200}\.exe$') { Refuse 'LiveUrl must be an immutable kalcoded.com updater URL' }
  if ($FeedUrl -cne 'https://kalcoded.com/releases/updater/stable.json') { Refuse 'FeedUrl must be the production Stable feed' }
  if ($CandidateTag -and ($CandidateTag -cnotmatch '^qa-[A-Za-z0-9][A-Za-z0-9._-]{1,100}$' -or $ExpectSchema -lt 1)) { Refuse 'package proof requires a qa- draft tag and expected schema' }
  if ($ChangesData -and (-not $CandidateTag -or $LiveSchema -lt 1 -or $ExpectSchema -le $LiveSchema)) { Refuse 'migration proof requires a draft and increasing pinned live/candidate schemas' }
  if ($CandidateTag -and $LiveSchema -gt 0 -and $LiveSchema -ne $ExpectSchema -and -not $ChangesData) { Refuse 'schema changes require the restore guard proof' }
  if ($CandidateTag) {
    if ($id.Name -cne 'KALEBSLAPTOP\kalcode-qa' -or $env:COMPUTERNAME -cne 'KALEBSLAPTOP') { Refuse 'package proof requires the exact dedicated laptop QA account' }
    $profile = Get-CimInstance Win32_UserProfile -Filter ("SID = '" + $id.User.Value + "'")
    if ($profile.LocalPath -cne 'C:\Users\kalcode-qa' -or $env:USERPROFILE -cne $profile.LocalPath -or $env:APPDATA -cne ($profile.LocalPath + '\AppData\Roaming') -or $env:LOCALAPPDATA -cne ($profile.LocalPath + '\AppData\Local')) { Refuse 'package proof requires canonical SID-bound QA profile paths' }
    foreach ($path in $env:APPDATA, $env:LOCALAPPDATA, (Join-Path $env:LOCALAPPDATA 'Programs')) {
      for ($node = $path; $node -and $node -ne 'C:\Users'; $node = Split-Path -Parent $node) {
        if ((Test-Path -LiteralPath $node) -and ((Get-Item -LiteralPath $node -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Refuse 'QA profile contains a reparse point' }
      }
    }
    if ((Leftovers).Values -contains $true) { Refuse 'QA profile is not clean; preserve unknown residue for separately reviewed recovery' }
  }
  if ($SelfTest) { $receipt.status = 'SELFTEST'; Save; Write-Host 'SELFTEST PASS'; exit 0 }
  if (@(KalProcs).Count) { Refuse 'QA session already has KalCode processes; preserve them and retry once idle' }
  $guardsPassed = $true

  if ($CandidateTag) {
    . (Join-Path $PSScriptRoot 'win-desktop-package-proof.ps1')
    $candidatePackage = Get-CandidatePackage
  } else {
  # 0. The feed must already serve the exact candidate; otherwise there is nothing for the updater to deliver.
  $feed = Invoke-RestMethod -UseBasicParsing -Uri ($FeedUrl + '?t=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  $receipt.feed = [ordered]@{ version = [string]$feed.version; commit = [string]$feed.kalcode.commit; windowsSha256 = [string]$feed.kalcode.artifacts.'windows-x86_64'.sha256 }
  if ($receipt.feed.version -ne $CandidateVersion -or $receipt.feed.commit -ne $CandidateCommit -or $receipt.feed.windowsSha256 -ne $CandidateSha256) {
    Refuse ("Stable feed serves $($receipt.feed.version)@$($receipt.feed.commit) ($($receipt.feed.windowsSha256)), not the candidate")
  }
  Note "Stable feed serves $CandidateVersion@$CandidateCommit"
  }
  $env:GH_TOKEN = $null

  $pre = Leftovers
  if ($pre.Values -contains $true) {
    Note ('profile had KalCode leftovers: ' + ($pre | ConvertTo-Json -Compress) + '; cleaning first')
    if (-not (Cleanup)) { Refuse 'could not clean KalCode leftovers before the check' }
  }

  # 1. live build
  $live = Join-Path $OutDir ([IO.Path]::GetFileName(([Uri]$LiveUrl).AbsolutePath))
  Invoke-WebRequest -UseBasicParsing -Uri $LiveUrl -OutFile $live
  if ((Sha $live) -ne $LiveSha256) { Refuse "downloaded live installer is $(Sha $live), not $LiveSha256" }
  $sig = Get-AuthenticodeSignature -LiteralPath $live; if ($sig.Status -ne 'Valid') { Refuse "live installer Authenticode $($sig.Status)" }
  $p = Start-Process -FilePath $live -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
  if ($p.ExitCode -ne 0) { Refuse "live installer exited $($p.ExitCode)" }
  $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not (Installed) -and $sw.Elapsed.TotalSeconds -lt 60) { Start-Sleep -Seconds 2 }
  $i = Installed; if (-not $i -or $i.productVersion -ne $LiveVersion) { Refuse "live install reports $($i.productVersion), expected $LiveVersion" }
  Note "installed live $LiveVersion ($($i.signature))"
  $liveRun = Launch $LiveVersion

  if ($CandidateTag) {
    Invoke-PackageProof $candidatePackage $liveRun $sig
  } else {
  # 2. the live build's own updater stages the exact candidate from the feed for exit
  $sw = [Diagnostics.Stopwatch]::StartNew(); $staged = $null
  while ($sw.Elapsed.TotalSeconds -lt $StageTimeoutSec) {
    $si = Read-Json (Join-Path $Updates 'silent-install.json')
    if ($si -and $si.version -eq $CandidateVersion -and $si.stagedForExit -eq $true) {
      $files = @(Get-ChildItem -LiteralPath (Join-Path $Updates 'prepared') -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq '.exe' })
      $match = @($files | Where-Object { (Sha $_.FullName) -eq $CandidateSha256 })
      if ($match.Count) { $staged = [ordered]@{ seconds = [int]$sw.Elapsed.TotalSeconds; file = $match[0].Name; sha256 = $CandidateSha256; silentInstall = $si }; break }
    }
    if (-not (Get-Process -Id $liveRun.pid -ErrorAction SilentlyContinue)) { Refuse 'live KalCode exited before staging the candidate' }
    Start-Sleep -Seconds 5
  }
  if (-not $staged) { Refuse "live updater did not stage $CandidateVersion within ${StageTimeoutSec}s" }
  $receipt.staged = $staged; Note "live updater staged $CandidateVersion after $($staged.seconds)s ($($staged.file))"

  # 3. normal close of the exact live PID
  $receipt.liveClose = Close-Exact $liveRun.pid
  if (-not $receipt.liveClose.exited) { Refuse "live PID $($liveRun.pid) did not exit after WM_CLOSE" }

  # 4. the staged candidate is installed after exit. kalcode.exe is not opened while the update helper or the staged
  # installer still runs (reading it then fails, and an open handle could block the replacement); a busy file means not yet.
  $prepared = Join-Path $Updates 'prepared'
  $sw = [Diagnostics.Stopwatch]::StartNew(); $applied = $null
  while ($sw.Elapsed.TotalSeconds -lt 300) {
    Start-Sleep -Seconds 2
    $busy = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.SessionId -eq $me -and ($_.Name -eq 'kalcode-update-helper' -or ($_.Path -and $_.Path.StartsWith($prepared, [StringComparison]::OrdinalIgnoreCase))) })
    if ($busy.Count) { continue }
    try { $i = Installed } catch { continue }
    if ($i -and $i.productVersion -eq $CandidateVersion) { $applied = $i; break }
  }
  if (-not $applied) { Refuse "installed version is $((Installed).productVersion) 300s after exit, not $CandidateVersion" }
  if ($applied.signature -ne 'Valid') { Refuse "installed candidate kalcode.exe Authenticode $($applied.signature)" }
  $applied.seconds = [int]$sw.Elapsed.TotalSeconds; $receipt.applied = $applied
  Start-Sleep -Seconds 10
  $relaunched = @(KalProcs | Where-Object { $_.Name -eq 'kalcode' })
  $receipt.autoRelaunched = [bool]$relaunched.Count
  Note "candidate installed after exit in $($applied.seconds)s; autoRelaunched=$($receipt.autoRelaunched)"

  # 5. reopen (or adopt the relaunched instance) and require a healthy journal
  if ($relaunched.Count) {
    $line = Wait-Started $CandidateVersion ([DateTime]::Parse($receipt.liveClose.requestedAt).ToUniversalTime())
    $receipt.reopen = [ordered]@{ pid = $relaunched[0].Id; method = 'automatic relaunch'; appStarted = $line }
  } else {
    $receipt.reopen = Launch $CandidateVersion
  }
  Start-Sleep -Seconds 10
  $journal = Read-Json (Join-Path $Updates 'updater.json'); $receipt.journal = $journal
  if (-not $journal -or $journal.lastSuccessfulVersion -ne $CandidateVersion -or $null -ne $journal.installAttempt -or $null -ne $journal.lastFailure) {
    Refuse ('updater journal is not healthy after reopen: ' + ($journal | ConvertTo-Json -Compress))
  }
  $si = Read-Json (Join-Path $Updates 'silent-install.json')
  if ($si -and $si.stagedForExit -eq $true) { Refuse 'silent install is still staged after the candidate started' }
  Note "journal healthy: lastSuccessfulVersion $($journal.lastSuccessfulVersion)"
  $receipt.candidateClose = Close-Exact $receipt.reopen.pid
  if (-not $receipt.candidateClose.exited) { Refuse "candidate PID $($receipt.reopen.pid) did not exit after WM_CLOSE" }
  $receipt.normalUpdaterDeliveryProven = $true
  }

  $receipt.status = 'PASS'
} catch {
  $receipt.error = "$_"; Note "FAILED: $_"
} finally {
  if ($guardsPassed) { try { $receipt.cleanupClean = Cleanup } catch { $receipt.cleanupClean = $false; Note "cleanup: $_" } }
  if ($receipt.status -eq 'PASS' -and ($receipt.cleanupClean -ne $true -or $receipt.forcedProcessActions -ne 0)) {
    $receipt.status = 'FAILED'; $receipt.error = 'clean natural shutdown required; cleanup was incomplete or forced'
    $receipt.normalUpdaterDeliveryProven = $false
  }
  $receipt.finishedAt = [DateTime]::UtcNow.ToString('o'); Save
}
Write-Host "DESKTOP UPDATE $($receipt.status)"
if ($receipt.status -ne 'PASS') { exit 1 }
