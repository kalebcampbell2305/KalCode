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
for releases with unchanged updater behavior. -ChangesData verifies a forward schema migration and rollback floor.
#>
param(
  [string]$LiveUrl = '', [string]$LiveSha256 = '', [string]$LiveVersion = '',
  [string]$CandidateVersion = '', [string]$CandidateSha256 = '', [string]$CandidateCommit = '',
  [string]$CandidateTag = '', [int]$ExpectSchema = 0, [switch]$ChangesData,
  [string]$CleanPacketSha256 = '', [string]$CleanVerifierSha256 = '',
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
function KalProcs {
  # NSIS can affect this user in other sessions too: protect all of them.
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='kalcode.exe' OR Name='kalcode-provider-guardian.exe' OR Name='kalcode-update-helper.exe'")) {
    $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0) { Refuse 'cannot determine a KalCode process owner; preserving state' }
    if ($owner.Sid -ceq $id.User.Value) { Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue }
  }
}
. (Join-Path $PSScriptRoot 'desktop-process-safety.ps1')
function InstallDir {
  $u = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode' -ErrorAction SilentlyContinue
  if (-not $u) { return $null }; $d = ([string]$u.InstallLocation).Trim('"'); if (-not $d) { $d = Split-Path -Parent ([string]$u.UninstallString).Trim('"') }; $d
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
  if (@(KalProcs).Count) { Refuse 'application launch requires an idle QA account' }
  $i = Installed; if (-not $i) { Refuse 'no installed kalcode.exe to launch' }
  $t = [DateTime]::UtcNow.AddSeconds(-1); $p = Start-Process -FilePath $i.exe -WindowStyle Hidden -PassThru
  $identity = Bind-App $p $i.exe $t
  $line = Wait-Started $version $t; Note "launched $version as PID $($p.Id): $line"
  # The main window must exist and be visible in this interactive session before a normal close can be proven.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 60) { $p.Refresh(); if ($p.MainWindowHandle -ne [IntPtr]::Zero) { break }; Start-Sleep -Seconds 1 }
  if ($p.MainWindowHandle -eq [IntPtr]::Zero) { Refuse "PID $($p.Id) has no main window after 60s" }
  [ordered]@{ pid = $p.Id; identity = $identity; startedAt = $p.StartTime.ToUniversalTime().ToString('o'); window = [int64]$p.MainWindowHandle; appStarted = $line }
}
function Leftovers {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $run = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  [ordered]@{
    uninstallEntry = Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode'
    productKey = Test-Path -LiteralPath 'HKCU:\Software\KalCode'
    protocolRegistration = Test-Path -LiteralPath 'HKCU:\Software\Classes\kalcode'
    runValue = [bool]($run -and @($run.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' -and [string]$_.Value -match '(?i)kalcode' }).Count)
    installFolder = (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'KalCode')) -or (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'))
    appData = (Test-Path -LiteralPath $AppData) -or (Test-Path -LiteralPath $LocalData)
    shortcuts = (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KalCode.lnk')) -or (Test-Path -LiteralPath (Join-Path $programs 'KalCode.lnk')) -or (Test-Path -LiteralPath (Join-Path $programs 'KalCode'))
    processes = [bool](KalProcs).Count
  }
}
function Cleanup {
  # A failed close is diagnostic evidence. Never repair it with process termination.
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while (@(KalProcs).Count -and $wait.Elapsed.TotalSeconds -lt 15) { Start-Sleep -Milliseconds 500 }
  Assert-CleanupAllowed
  $d = InstallDir
  if ($d) {
    $allowed = @((Join-Path $env:LOCALAPPDATA 'KalCode'), (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'))
    if ($d -notin $allowed) { Refuse 'uninstall registration points outside the task install locations' }
    Assert-CleanupPath $d $env:USERPROFILE
    $un = Join-Path $d 'uninstall.exe'
    if (Test-Path -LiteralPath $un) {
      $signature = Get-AuthenticodeSignature -LiteralPath $un
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -cne $script:InstallerPublisher) { Refuse 'uninstaller publisher mismatch' }
      Run-Installer $un @('/S')
      Wait-UninstallComplete $d
    }
  }
  Assert-CleanupAllowed
  foreach ($k in 'HKCU:\Software\KalCode', 'HKCU:\Software\Classes\kalcode', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode') {
    if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $rv = Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
  if ($rv) { foreach ($n in @($rv.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' -and [string]$_.Value -match '(?i)kalcode' } | ForEach-Object Name)) { Remove-ItemProperty -LiteralPath $runKey -Name $n -ErrorAction SilentlyContinue } }
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  # WebView2 and the uninstaller can hold files for a few seconds after exit, so retry the data removal briefly.
  $paths = @($AppData, $LocalData, (Join-Path $env:LOCALAPPDATA 'KalCode'), (Join-Path $env:LOCALAPPDATA 'Programs\KalCode'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KalCode.lnk'), (Join-Path $programs 'KalCode.lnk'), (Join-Path $programs 'KalCode'))
  foreach ($path in $paths) { Assert-CleanupPath $path $env:USERPROFILE }
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
  if ($ChangesData -and -not $CandidateTag) { Refuse 'migration proof requires a signed draft package' }
  if ($CleanPacketSha256 -or $CleanVerifierSha256) {
    if (-not $CandidateTag -or $CleanPacketSha256 -cnotmatch '^[0-9a-f]{64}$' -or $CleanVerifierSha256 -cnotmatch '^[0-9a-f]{64}$') { Refuse 'clean verification requires a draft package and exact packet/verifier hashes' }
    . (Join-Path $PSScriptRoot 'desktop-clean-packet.ps1')
  }
  if ($SelfTest) { $receipt.status = 'SELFTEST'; Save; Write-Host 'SELFTEST PASS'; exit 0 }
  if (@(KalProcs).Count) { Refuse 'QA session already has KalCode processes; preserve them and retry once idle' }

  if ($CandidateTag) {
    . (Join-Path $PSScriptRoot 'win-desktop-package-proof.ps1')
    $candidatePackage = Get-CandidatePackage
    if ($CleanPacketSha256) { $cleanPacket = Get-CleanPacket }
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
  if ($pre.Values -contains $true) { Refuse ('QA profile already contains KalCode state; preserving it: ' + ($pre | ConvertTo-Json -Compress)) }

  # 1. live build
  $live = Join-Path $OutDir ([IO.Path]::GetFileName(([Uri]$LiveUrl).AbsolutePath))
  Invoke-WebRequest -UseBasicParsing -Uri $LiveUrl -OutFile $live
  if ((Sha $live) -ne $LiveSha256) { Refuse "downloaded live installer is $(Sha $live), not $LiveSha256" }
  $sig = Get-AuthenticodeSignature -LiteralPath $live; if ($sig.Status -ne 'Valid') { Refuse "live installer Authenticode $($sig.Status)" }
  $script:InstallerPublisher = $sig.SignerCertificate.Subject
  if ((Leftovers).Values -contains $true) { Refuse 'QA state appeared during download; preserving it' }
  $script:QaStateOwned = $true
  Run-Installer $live @('/S')
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
  if (-not $receipt.liveClose.accepted -or -not $receipt.liveClose.exited) { Refuse "live PID $($liveRun.pid) did not exit after WM_CLOSE" }

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
    if ($relaunched.Count -ne 1) { Refuse 'ambiguous native relaunch; preserving all processes' }
    $identity = Bind-App $relaunched[0] $applied.exe ([DateTime]::Parse($receipt.liveClose.requestedAt).ToUniversalTime())
    $line = Wait-Started $CandidateVersion ([DateTime]::Parse($receipt.liveClose.requestedAt).ToUniversalTime())
    $receipt.reopen = [ordered]@{ pid = $relaunched[0].Id; identity = $identity; method = 'automatic relaunch'; appStarted = $line }
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
  if (-not $receipt.candidateClose.accepted -or -not $receipt.candidateClose.exited) { Refuse "candidate PID $($receipt.reopen.pid) did not exit after WM_CLOSE" }
  $receipt.normalUpdaterDeliveryProven = $true
  }

  if ($CleanPacketSha256) {
    if (-not (Cleanup)) { Refuse 'update cleanup must finish before clean installer verification' }
    $script:QaStateOwned = $false
    Invoke-CleanPacket $cleanPacket
    $receipt.cleanupClean = -not ((Leftovers).Values -contains $true)
  }
  $receipt.status = 'PASS'
} catch {
  $receipt.error = "$_"; Note "FAILED: $_"
} finally {
  if ($script:QaStateOwned) { try { $receipt.cleanupClean = Cleanup } catch { $receipt.cleanupClean = $false; Note "cleanup: $_" } }
  if ($receipt.status -eq 'PASS' -and ($receipt.cleanupClean -ne $true -or $receipt.forcedProcessActions -ne 0)) {
    $receipt.status = 'FAILED'; $receipt.error = 'clean natural shutdown required; cleanup was incomplete or forced'
    $receipt.normalUpdaterDeliveryProven = $false
  }
  $receipt.finishedAt = [DateTime]::UtcNow.ToString('o'); Save
}
Write-Host "DESKTOP UPDATE $($receipt.status)"
if ($receipt.status -ne 'PASS') { exit 1 }
