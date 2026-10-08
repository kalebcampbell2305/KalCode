<#
.SYNOPSIS
  The build PC's share of the elastic gate pool (owner, 2026-10-08): lend idle build-PC gate workers to the
  pool only while this PC has headroom.

.DESCRIPTION
  Every gate job requests the label kalcode-gate-pool. The second PC's gate runners always carry it; this
  governor adds it to up to N idle build-PC workers (kalcode-win-gate, -w1..-w5) while the build PC is idle,
  and takes it back from idle workers as soon as it is not. A busy worker is never touched: its running job
  finishes, and the label comes off once it is idle. Release builds, signing and the owner's agents always
  come first on this PC.

  Idle means, over the last two minutes: average CPU below 55%, more than 16 GB free RAM, more than 60 GB
  free on C:, and no release build running (build-windows / release-front-half, `cargo ... --release`, or
  `tauri build`) outside the gate workers' own checkouts. N starts at 2; it rises to 3 once a whole gate
  period on this PC stays under 50% CPU, and falls back to 2 if one goes above 80%.

  One instance per machine: the lock file is held open for the process's life, so a second copy exits and a
  dead one never leaves it held. A heartbeat file says what it last saw. It runs hidden, opens no console
  windows and only calls `gh api` (the owner's GitHub CLI sign-in).

    Start (hidden):  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<this file>'
    One decision:    gate-pool-governor.ps1 -Once [-WhatIf]
    Stop:            gate-pool-governor.ps1 -Stop
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
# The gate workers' own checkouts: their builds are gate work, not release builds.
$GateRoots = @('C:\kalcode-ci\', 'C:\kalcode-ci-pool\')
$Limits = @{ CpuPercent = 55; FreeRamGb = 16; FreeDiskGb = 60; RaiseBelow = 50; LowerAbove = 80 }

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$heartbeat = Join-Path $StateDir 'heartbeat.json'

if ($Stop) {
    if (Test-Path -LiteralPath $heartbeat) {
        $beat = Get-Content -LiteralPath $heartbeat -Raw | ConvertFrom-Json
        $proc = Get-Process -Id ([int]$beat.pid) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match '^(powershell|pwsh)$') { Stop-Process -Id $proc.Id -Force; "stopped governor pid $($proc.Id)" } else { 'no running governor' }
    } else { 'no running governor' }
    return
}

function Write-Log([string]$Message) {
    $line = '{0} | {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
    try { Add-Content -LiteralPath $Log -Value $line -Encoding utf8 } catch { }
    if ($Once) { Write-Host $line }
}

function Invoke-Gh {
    # Native-call wrapper: PS 5.1 turns a native stderr line into an error under 'Stop'.
    $ErrorActionPreference = 'Continue'
    $out = & gh @args 2>$null
    if ($LASTEXITCODE -ne 0) { throw "gh $($args[0..1] -join ' ') failed ($LASTEXITCODE)" }
    $out
}

function Get-BuildPcRunners {
    # No double quotes in the filter: Windows PowerShell 5.1 mangles them in native arguments.
    $rows = Invoke-Gh api "repos/$Repo/actions/runners?per_page=100" --jq '.runners[] | [.id, .name, .status, .busy] + [.labels[].name] | @tsv'
    @($rows | ForEach-Object {
            $f = @("$_".Split("`t"))
            if ($f.Count -ge 4 -and $Workers -contains $f[1]) {
                [pscustomobject]@{ Id = $f[0]; Name = $f[1]; Online = $f[2] -eq 'online'; Busy = $f[3] -eq 'true'; Pooled = (@($f | Select-Object -Skip 4) -contains $PoolLabel) }
            }
        })
}

function Test-ReleaseBuild {
    $pattern = 'build-windows\.ps1|release-front-half\.ps1|cargo(\.exe)?"?\s.*--release|tauri(\.cmd|\.js)?"?\s+build'
    foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId, CommandLine, ExecutablePath)) {
        $cmd = [string]$p.CommandLine
        if (-not $cmd -or $cmd -notmatch $pattern) { continue }
        $path = [string]$p.ExecutablePath
        $gate = $false
        foreach ($root in $GateRoots) { if ($cmd.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $gate = $true } }
        if (-not $gate) { return "pid $($p.ProcessId): $($cmd.Substring(0, [Math]::Min(100, $cmd.Length)))" }
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
$target = 2
$period = $null      # an ongoing gate period on this PC: its peak two-minute CPU average
$lastSummary = [DateTime]::MinValue
$lastState = ''
Write-Log "governor start pid $PID (interval $IntervalSeconds s, N=$target, whatif=$([bool]$WhatIf))"

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
        if ($release) { $reasons += "release build ($release)" }
        $idle = $reasons.Count -eq 0

        $runners = Get-BuildPcRunners
        $busy = @($runners | Where-Object { $_.Busy -and $_.Pooled })
        # Learn N from whole gate periods on this PC.
        if ($busy.Count -gt 0) {
            if ($null -eq $period) { $period = @{ Start = Get-Date; Peak = $avg } } elseif ($avg -gt $period.Peak) { $period.Peak = $avg }
        } elseif ($null -ne $period) {
            $minutes = ((Get-Date) - $period.Start).TotalMinutes
            if ($minutes -ge 10 -and $period.Peak -lt $Limits.RaiseBelow -and $target -lt 3) { $target = 3; Write-Log "N=3: a $([int]$minutes)-min gate period peaked at $($period.Peak)% CPU" }
            elseif ($period.Peak -gt $Limits.LowerAbove -and $target -gt 2) { $target = 2; Write-Log "N=2: a gate period peaked at $($period.Peak)% CPU" }
            $period = $null
        }

        $pooled = @($runners | Where-Object { $_.Pooled })
        $actions = @()
        if ($idle) {
            $missing = $target - $pooled.Count
            foreach ($r in @($runners | Where-Object { $_.Online -and -not $_.Busy -and -not $_.Pooled } | Select-Object -First ([Math]::Max(0, $missing)))) {
                if (-not $WhatIf) { Invoke-Gh api -X POST "repos/$Repo/actions/runners/$($r.Id)/labels" -f "labels[]=$PoolLabel" | Out-Null }
                $actions += "+$($r.Name)"
            }
            # Above N (N fell to 2): return the extra idle ones.
            $extra = $pooled.Count - $target
            foreach ($r in @($pooled | Where-Object { -not $_.Busy } | Select-Object -First ([Math]::Max(0, $extra)))) {
                if (-not $WhatIf) { Invoke-Gh api -X DELETE "repos/$Repo/actions/runners/$($r.Id)/labels/$PoolLabel" | Out-Null }
                $actions += "-$($r.Name)"
            }
        } else {
            foreach ($r in @($pooled | Where-Object { -not $_.Busy })) {
                if (-not $WhatIf) { Invoke-Gh api -X DELETE "repos/$Repo/actions/runners/$($r.Id)/labels/$PoolLabel" | Out-Null }
                $actions += "-$($r.Name)"
            }
        }

        $state = if ($idle) { "idle: lending up to $target" } else { "busy: $($reasons -join '; ')" }
        $summary = "cpu2m $avg% ram $ramGb GB C: $diskGb GB; pooled $($pooled.Count) (busy $($busy.Count)); $state"
        if ($actions.Count -gt 0) { Write-Log "$summary; $(if ($WhatIf) { 'WHATIF ' })$($actions -join ' ')" }
        elseif ($state -ne $lastState -or ((Get-Date) - $lastSummary).TotalMinutes -ge 10) { Write-Log $summary; $lastSummary = Get-Date }
        $lastState = $state
        [pscustomobject]@{ pid = $PID; at = (Get-Date).ToUniversalTime().ToString('o'); target = $target; idle = $idle; reasons = $reasons; cpu2m = $avg; ramGb = $ramGb; diskGb = $diskGb; pooled = @($pooled | ForEach-Object Name) } |
            ConvertTo-Json -Compress | Set-Content -LiteralPath $heartbeat -Encoding utf8
    } catch {
        Write-Log "error: $($_.Exception.Message)"
    }
    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}
if ($null -ne $lockHandle) { $lockHandle.Dispose() }
