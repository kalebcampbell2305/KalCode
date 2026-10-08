<#
.SYNOPSIS
  Routes the elastic gate pool (owner, 2026-10-08: "optimize for the build PC and for PC2"): the build PC
  first, the second PC for overflow, so every gate job starts on the fastest free machine.

.DESCRIPTION
  Every pooled gate job requests the label kalcode-gate-pool. The build PC (Ryzen 9 9900X) runs the desktop
  half in ~16 min against ~50-77 min on the second PC (a laptop), so this governor:

  - BUILD PC FIRST. While the build PC has headroom it lends up to N idle build-PC workers (kalcode-win-gate,
    -w1..-w5). Headroom means, over the last two minutes: average CPU below 70%, more than 12 GB free RAM and
    more than 60 GB free on C:. A release build (build-windows / release-front-half, `cargo ... --release`,
    `tauri build` outside the gate workers' own checkouts) no longer blocks lending, since the release is
    built during every gate by design; it caps N at 2. Gates run below normal priority there, so release
    builds and the owner's agents still come first. N starts at 2, rises to 3 after a calm gate period (peak
    under 50% CPU) and falls back to 2 after a hot one (over 80%).
  - SECOND PC FOR OVERFLOW. Its gate runners (kalcode-win-gate-2, -2b, -2c) carry the pool label only for the
    queued pooled jobs no idle pooled build-PC worker can start right now, so a job never waits for a busy
    build PC. Its JS/web job requests kalcode-gate-pc2 directly and is unaffected.
  - FAIL-SAFE. When the governor stops (-Stop, or this loop exiting) the second PC's runners get the pool
    label back, and the release watcher re-pools them if this heartbeat goes stale, so gates never stall.

  A busy runner is never touched: its job finishes, and its label changes once it is idle. One instance per
  machine (a lock file held open for the process's life). It runs hidden and only calls `gh api`.

    Start (hidden):  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<this file>'
    One decision:    gate-pool-governor.ps1 -Once [-WhatIf]
    Stop:            gate-pool-governor.ps1 -Stop          (re-pools the second PC)
#>
[CmdletBinding()]
param(
    [string]$Repo = 'kalebcampbell2305/KalCode',
    [string]$StateDir = 'C:\ProgramData\KalCode\gate-pool-governor',
    [string]$Log = 'C:\Users\Kaleb\Downloads\KalCode\target\lanes\gate-pool-governor.log',
    [int]$IntervalSeconds = 30,
    [switch]$Once,
    [switch]$WhatIf,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$PoolLabel = 'kalcode-gate-pool'
$Workers = @('kalcode-win-gate', 'kalcode-win-gate-w1', 'kalcode-win-gate-w2', 'kalcode-win-gate-w3', 'kalcode-win-gate-w4', 'kalcode-win-gate-w5')
# The second PC's gate runners (at most three: a fourth overloaded the laptop, 2026-10-08).
$Pc2Runners = @('kalcode-win-gate-2', 'kalcode-win-gate-2b', 'kalcode-win-gate-2c')
# The gate workers' own checkouts: their builds are gate work, not release builds.
$GateRoots = @('C:\kalcode-ci\', 'C:\kalcode-ci-pool\')
$Limits = @{ CpuPercent = 70; FreeRamGb = 12; FreeDiskGb = 60; RaiseBelow = 50; LowerAbove = 80 }

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$heartbeat = Join-Path $StateDir 'heartbeat.json'

function Write-Log([string]$Message) {
    $line = '{0} | {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
    try { Add-Content -LiteralPath $Log -Value $line -Encoding utf8 } catch { }
    if ($Once -or $Stop) { Write-Host $line }
}

function Invoke-Gh {
    # Native-call wrapper: PS 5.1 turns a native stderr line into an error under 'Stop'.
    $ErrorActionPreference = 'Continue'
    $out = & gh @args 2>$null
    if ($LASTEXITCODE -ne 0) { throw "gh $($args[0..1] -join ' ') failed ($LASTEXITCODE)" }
    $out
}

function Get-GateRunners {
    # No double quotes in the filter: Windows PowerShell 5.1 mangles them in native arguments.
    $rows = Invoke-Gh api "repos/$Repo/actions/runners?per_page=100" --jq '.runners[] | [.id, .name, .status, .busy] + [.labels[].name] | @tsv'
    @($rows | ForEach-Object {
            $f = @("$_".Split("`t"))
            if ($f.Count -ge 4 -and ($Workers -contains $f[1] -or $Pc2Runners -contains $f[1])) {
                [pscustomobject]@{
                    Id = $f[0]; Name = $f[1]; Online = $f[2] -eq 'online'; Busy = $f[3] -eq 'true'
                    Pooled = (@($f | Select-Object -Skip 4) -contains $PoolLabel); Pc2 = $Pc2Runners -contains $f[1]
                    # The release kit parks a second-PC runner (only this label) while that PC's Windows update proof runs.
                    Parked = (@($f | Select-Object -Skip 4) -contains 'kalcode-gate-pc2-pending')
                }
            }
        })
}

function Set-Pooled($Runner, [bool]$On) {
    if (-not $WhatIf) {
        if ($On) { Invoke-Gh api -X POST "repos/$Repo/actions/runners/$($Runner.Id)/labels" -f "labels[]=$PoolLabel" | Out-Null }
        else { Invoke-Gh api -X DELETE "repos/$Repo/actions/runners/$($Runner.Id)/labels/$PoolLabel" | Out-Null }
    }
    $(if ($On) { '+' } else { '-' }) + $Runner.Name
}

function Get-QueuedPoolJobs {
    # Gate jobs that asked for the pool label and have no runner yet, across every queued or running gate run.
    $count = 0
    foreach ($status in 'queued', 'in_progress') {
        $ids = @(Invoke-Gh api "repos/$Repo/actions/workflows/gate.yml/runs?status=$status&per_page=20" --jq '.workflow_runs[].id')
        foreach ($id in $ids) {
            if (-not "$id".Trim()) { continue }
            $jobs = @(Invoke-Gh api "repos/$Repo/actions/runs/$id/jobs?per_page=50" --jq '.jobs[] | [.status] + .labels | @tsv')
            $count += @($jobs | Where-Object { $f = @("$_".Split("`t")); $f[0] -eq 'queued' -and ($f -contains $PoolLabel) }).Count
        }
    }
    $count
}

function Restore-Pc2 {
    # Fail-safe: the second PC takes every pooled job again.
    $done = @()
    foreach ($r in @(Get-GateRunners | Where-Object { $_.Pc2 -and -not $_.Parked -and -not $_.Pooled })) { $done += Set-Pooled $r $true }
    $done
}

if ($Stop) {
    if (Test-Path -LiteralPath $heartbeat) {
        $beat = Get-Content -LiteralPath $heartbeat -Raw | ConvertFrom-Json
        $proc = Get-Process -Id ([int]$beat.pid) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match '^(powershell|pwsh)$') { Stop-Process -Id $proc.Id -Force; "stopped governor pid $($proc.Id)" } else { 'no running governor' }
    } else { 'no running governor' }
    $restored = Restore-Pc2
    Write-Log "stopped; second PC re-pooled: $(if ($restored) { $restored -join ' ' } else { 'already pooled' })"
    return
}

function Test-ReleaseBuild {
    $pattern = 'build-windows\.ps1|release-front-half\.ps1|cargo(\.exe)?"?\s.*--release|tauri(\.cmd|\.js)?"?\s+build'
    foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId, CommandLine, ExecutablePath)) {
        $cmd = [string]$p.CommandLine
        if (-not $cmd -or $cmd -notmatch $pattern) { continue }
        $path = [string]$p.ExecutablePath
        $gate = $false
        foreach ($root in $GateRoots) { if ($cmd.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $gate = $true } }
        if (-not $gate) { return "pid $($p.ProcessId)" }
    }
    $null
}

# Single instance: the handle lives as long as this process.
$lockHandle = $null
if (-not $Once) {
    try { $lockHandle = [IO.File]::Open((Join-Path $StateDir 'governor.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { Write-Host 'gate-pool-governor is already running'; exit 0 }
}

$cpu = New-Object System.Collections.Generic.Queue[double]
$samples = [Math]::Max(1, [int](120 / $IntervalSeconds))
$learned = 2
$period = $null      # an ongoing gate period on this PC: its peak two-minute CPU average
$lastSummary = [DateTime]::MinValue
$lastState = ''
Write-Log "governor start pid $PID (build PC first, second PC for overflow; interval $IntervalSeconds s, N=$learned, whatif=$([bool]$WhatIf))"

try {
    while ($true) {
        try {
            $load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
            $cpu.Enqueue([double]$load); while ($cpu.Count -gt $samples) { [void]$cpu.Dequeue() }
            $avg = [Math]::Round((($cpu | Measure-Object -Average).Average), 1)
            $os = Get-CimInstance Win32_OperatingSystem
            $ramGb = [Math]::Round($os.FreePhysicalMemory / 1MB, 1)
            $diskGb = [Math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / 1GB, 1)
            $release = Test-ReleaseBuild
            $reasons = @()
            if ($cpu.Count -lt $samples -and -not $Once) { $reasons += 'warming up' }
            if ($avg -ge $Limits.CpuPercent) { $reasons += "cpu $avg%" }
            if ($ramGb -le $Limits.FreeRamGb) { $reasons += "ram $ramGb GB free" }
            if ($diskGb -le $Limits.FreeDiskGb) { $reasons += "C: $diskGb GB free" }
            $headroom = $reasons.Count -eq 0
            $target = if ($release) { [Math]::Min(2, $learned) } else { $learned }

            $runners = Get-GateRunners
            $build = @($runners | Where-Object { -not $_.Pc2 })
            $pc2 = @($runners | Where-Object { $_.Pc2 -and -not $_.Parked })
            $busy = @($build | Where-Object { $_.Busy -and $_.Pooled })
            # Learn N from whole gate periods on this PC.
            if ($busy.Count -gt 0) {
                if ($null -eq $period) { $period = @{ Start = Get-Date; Peak = $avg } } elseif ($avg -gt $period.Peak) { $period.Peak = $avg }
            } elseif ($null -ne $period) {
                $minutes = ((Get-Date) - $period.Start).TotalMinutes
                if ($minutes -ge 10 -and $period.Peak -lt $Limits.RaiseBelow -and $learned -lt 3) { $learned = 3; Write-Log "N=3: a $([int]$minutes)-min gate period peaked at $($period.Peak)% CPU" }
                elseif ($period.Peak -gt $Limits.LowerAbove -and $learned -gt 2) { $learned = 2; Write-Log "N=2: a gate period peaked at $($period.Peak)% CPU" }
                $period = $null
            }

            $actions = @()
            # Build PC first.
            $pooled = @($build | Where-Object { $_.Pooled })
            if ($headroom) {
                foreach ($r in @($build | Where-Object { $_.Online -and -not $_.Busy -and -not $_.Pooled } | Select-Object -First ([Math]::Max(0, $target - $pooled.Count)))) { $actions += Set-Pooled $r $true; $r.Pooled = $true }
                foreach ($r in @($pooled | Where-Object { -not $_.Busy } | Select-Object -First ([Math]::Max(0, $pooled.Count - $target)))) { $actions += Set-Pooled $r $false; $r.Pooled = $false }
            } else {
                foreach ($r in @($pooled | Where-Object { -not $_.Busy })) { $actions += Set-Pooled $r $false; $r.Pooled = $false }
            }
            # The second PC for whatever the build PC cannot start now.
            $queued = Get-QueuedPoolJobs
            $buildFree = @($build | Where-Object { $_.Online -and $_.Pooled -and -not $_.Busy }).Count
            $need = [Math]::Max(0, $queued - $buildFree)
            $pc2Idle = @($pc2 | Where-Object { $_.Online -and -not $_.Busy })
            $pc2IdlePooled = @($pc2Idle | Where-Object { $_.Pooled })
            if ($pc2IdlePooled.Count -lt $need) {
                foreach ($r in @($pc2Idle | Where-Object { -not $_.Pooled } | Select-Object -First ($need - $pc2IdlePooled.Count))) { $actions += Set-Pooled $r $true }
            } elseif ($pc2IdlePooled.Count -gt $need) {
                foreach ($r in @($pc2IdlePooled | Select-Object -First ($pc2IdlePooled.Count - $need))) { $actions += Set-Pooled $r $false }
            }

            $state = if ($headroom) { "build PC lending up to $target$(if ($release) { ' (release build running)' })" } else { "build PC busy: $($reasons -join '; ')" }
            $summary = "cpu2m $avg% ram $ramGb GB C: $diskGb GB; build pooled $(@($build | Where-Object { $_.Pooled }).Count) (busy $($busy.Count)); queued $queued; second PC overflow $need; $state"
            if ($actions.Count -gt 0) { Write-Log "$summary; $(if ($WhatIf) { 'WHATIF ' })$($actions -join ' ')" }
            elseif ($state -ne $lastState -or ((Get-Date) - $lastSummary).TotalMinutes -ge 10) { Write-Log $summary; $lastSummary = Get-Date }
            $lastState = $state
            [pscustomobject]@{
                pid = $PID; at = (Get-Date).ToUniversalTime().ToString('o'); target = $target; headroom = $headroom; reasons = $reasons
                release = [bool]$release; cpu2m = $avg; ramGb = $ramGb; diskGb = $diskGb; queued = $queued; pc2Overflow = $need
                pooled = @($runners | Where-Object { $_.Pooled } | ForEach-Object Name)
            } | ConvertTo-Json -Compress | Set-Content -LiteralPath $heartbeat -Encoding utf8
        } catch {
            Write-Log "error: $($_.Exception.Message)"
        }
        if ($Once) { break }
        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    if (-not $Once -and -not $WhatIf) {
        try { $restored = Restore-Pc2; if ($restored) { Write-Log "exiting; second PC re-pooled: $($restored -join ' ')" } } catch { }
    }
    if ($null -ne $lockHandle) { $lockHandle.Dispose() }
}
