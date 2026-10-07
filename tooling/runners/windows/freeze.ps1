# Resumable suspend/resume of a process TREE, for keeping a lane gate off a starved CPU without
# killing anyone's work. During a lane gate the coordinator may freeze OTHER sessions' heavy non-gate
# build trees (e.g. a Codex `cargo test` compiling the same crate as the gate's native job) and resume
# them the moment the gate's required jobs are green. Suspend is reversible (NtSuspendProcess), so this
# honours the Resource Governor rule: throttle/pause background work, never kill active work, and never
# touch user-requested coding agents' own responsiveness beyond the explicit roots passed in.
#
# It NEVER freezes KalCode itself, a gate runner (Runner.Worker/Listener), or this shell, even if one
# is a descendant of a given root - KalCode hosts the sessions, so a root's tree can include it.
#
# Owner-approved mechanism (2026-10-06): used to freeze noisy Codex build trees during lane gates and
# resume after. Re-confirm the roots each time (PIDs change after a reboot); pass the session/build
# root PIDs, not KalCode.
#
# Usage (from the build PC):
#   freeze.ps1 suspend -Roots 38428 12044      # suspend those trees, record them
#   freeze.ps1 resume                           # resume everything recorded by the last suspend
param(
    [Parameter(Mandatory)][ValidateSet('suspend', 'resume')][string]$Action,
    [int[]]$Roots
)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace KcFreeze -Name Nt -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
'@
$state = Join-Path $PSScriptRoot "frozen-pids.txt"
$PROCESS_SUSPEND_RESUME = 0x0800
function Invoke-Nt([int]$procId, [string]$what) {
    $h = [KcFreeze.Nt]::OpenProcess($PROCESS_SUSPEND_RESUME, $false, $procId)
    if ($h -eq [IntPtr]::Zero) { return "skip $procId (cannot open)" }
    try { $rc = if ($what -eq 'suspend') { [KcFreeze.Nt]::NtSuspendProcess($h) } else { [KcFreeze.Nt]::NtResumeProcess($h) }; "$what $procId rc=$rc" }
    finally { [void][KcFreeze.Nt]::CloseHandle($h) }
}
if ($Action -eq 'suspend') {
    if (-not $Roots) { throw 'suspend needs -Roots <pid>...' }
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
    $tree = New-Object System.Collections.Generic.List[object]
    $queue = New-Object System.Collections.Queue
    foreach ($r in $Roots) { $p = $all | Where-Object ProcessId -eq $r; if ($p) { $queue.Enqueue($p) } else { "root $r not found" } }
    while ($queue.Count) { $p = $queue.Dequeue(); $tree.Add($p); $all | Where-Object { $_.ParentProcessId -eq $p.ProcessId -and $_.ProcessId -ne $p.ProcessId } | ForEach-Object { $queue.Enqueue($_) } }
    # Never freeze KalCode itself, the gate's runner, or this shell.
    $tree = $tree | Where-Object { $_.Name -notmatch '^(kalcode|Runner\.(Worker|Listener))\.exe$' -and $_.ProcessId -ne $PID }
    $tree | ForEach-Object { "$($_.ProcessId) $($_.Name)" } | Add-Content -Path $state
    foreach ($p in $tree) { Invoke-Nt $p.ProcessId 'suspend' }
    "FROZE $(@($tree).Count) processes; list in $state"
} else {
    if (-not (Test-Path $state)) { 'nothing frozen'; exit 0 }
    $ids = Get-Content $state | ForEach-Object { [int]($_ -split ' ')[0] } | Sort-Object -Unique
    foreach ($i in $ids) { Invoke-Nt $i 'resume' }
    Move-Item $state "$state.resumed-$((Get-Date).ToUniversalTime().ToString('HHmmss'))"
    "RESUMED $($ids.Count) processes"
}
