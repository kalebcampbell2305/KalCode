# Process identity is captured only for this run's explicit launches or its
# single verified native updater relaunch. Never close an untracked process.
$script:OwnedApps = @{}
$script:QaStateOwned = $false
$script:PendingInstaller = $null

function Process-Identity([int]$procId) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
  if (-not $p) { Refuse "tracked PID $procId no longer exists" }
  $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -cne $id.User.Value -or $p.SessionId -ne $me) { Refuse "PID $procId is outside the QA account/session" }
  [ordered]@{ pid = $procId; sid = $owner.Sid; session = $p.SessionId; exe = [IO.Path]::GetFullPath($p.ExecutablePath); created = $p.CreationDate.ToUniversalTime().ToString('o') }
}
function Bind-App($process, [string]$exe, [DateTime]$since) {
  $identity = Process-Identity $process.Id
  if ($identity.exe -ine [IO.Path]::GetFullPath($exe) -or [DateTime]::Parse($identity.created).ToUniversalTime() -lt $since.ToUniversalTime()) { Refuse 'application executable/creation does not match the owned launch' }
  # Retaining the process handle makes WaitForExit refer to this instance even
  # if Windows later reuses its numeric PID.
  $null = $process.Handle
  # Win32_Process reports microseconds; Process.StartTime retains 100ns ticks.
  $createdTicks = $process.StartTime.ToUniversalTime().Ticks
  if (($createdTicks - ($createdTicks % 10)) -ne [DateTime]::Parse($identity.created).ToUniversalTime().Ticks) { Refuse 'application creation identity changed while binding its handle' }
  $script:OwnedApps[$process.Id] = @{ identity = $identity; process = $process }
  $identity
}
function Assert-OwnedApp([int]$procId) {
  $owned = $script:OwnedApps[$procId]
  if (-not $owned) { Refuse "PID $procId was not launched by this QA run" }
  $current = Process-Identity $procId
  foreach ($key in 'pid', 'sid', 'session', 'exe', 'created') {
    if ($current[$key] -cne $owned.identity[$key]) { Refuse "PID $procId identity changed ($key); preserving it" }
  }
  if ($owned.process.HasExited) { Refuse "owned PID $procId exited before its normal close" }
  $owned.process
}
function Close-Exact([int]$procId, [int]$sec = 120) {
  $p = Assert-OwnedApp $procId
  $p.Refresh()
  if ($p.MainWindowHandle -eq [IntPtr]::Zero) { Refuse "owned PID $procId has no window to close" }
  $window = [int64]$p.MainWindowHandle
  $requested = [DateTime]::UtcNow
  $accepted = $p.CloseMainWindow()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $exited = $accepted -and $p.WaitForExit($sec * 1000)
  $r = [ordered]@{ pid = $procId; identity = $script:OwnedApps[$procId].identity; window = $window; method = 'Process.CloseMainWindow (WM_CLOSE)'; accepted = $accepted; requestedAt = $requested.ToString('o'); exited = $exited; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
  Note "close PID $procId accepted=$accepted exited=$exited after $($r.seconds)s"
  $r
}
function Run-Installer([string]$exe, [string[]]$arguments) {
  if (@(KalProcs).Count) { Refuse 'installer requires an idle QA account; preserving running processes' }
  $script:PendingInstaller = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $null = $script:PendingInstaller.Handle
  if (-not $script:PendingInstaller.WaitForExit(300000)) { Refuse 'installer exceeded 300s; preserving process and profile for diagnosis' }
  $code = $script:PendingInstaller.ExitCode
  $script:PendingInstaller.Dispose(); $script:PendingInstaller = $null
  if ($code -ne 0) { Refuse "installer failed: $code" }
}
function Assert-CleanupAllowed {
  if (-not $script:QaStateOwned) { Refuse 'this run does not own the QA profile; preserving it' }
  if ($script:PendingInstaller -or @(KalProcs).Count) { Refuse 'QA runtime or installer still present; preserving all state without forcing shutdown' }
}
function Wait-UninstallComplete([string]$directory, [int]$seconds = 120) {
  # NSIS may exit its initial process while a copied uninstaller still runs.
  $paths = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode') +
    @('kalcode.exe', 'uninstall.exe', 'kalcode-hook.exe', 'kalcode-provider-guardian.exe', 'kalcode-update-helper.exe' | ForEach-Object { Join-Path $directory $_ })
  $wait = [Diagnostics.Stopwatch]::StartNew()
  do {
    $incomplete = @($paths | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
    if (-not $incomplete) { return }
    Start-Sleep -Seconds 1
  } while ($wait.Elapsed.TotalSeconds -lt $seconds)
  $script:QaStateOwned = $false
  Refuse 'NSIS uninstall has not completed; preserving remaining state'
}
function Assert-CleanupPath([string]$path, [string]$root) {
  $full = [IO.Path]::GetFullPath($path)
  $boundary = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  if (-not $full.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { Refuse 'cleanup target is outside the QA profile' }
  $walk = $full
  while ($walk -and $walk.Length -ge $boundary.Length - 1) {
    if (Test-Path -LiteralPath $walk) {
      if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Refuse 'cleanup target has a reparse point; preserving state' }
    }
    $walk = Split-Path -Parent $walk
  }
}
