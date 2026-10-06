Set-StrictMode -Version Latest

function Get-GateWorkerPlan {
    param([ValidateRange(0,5)][int]$Slot, [string]$Root = 'C:\kalcode-ci-pool')
    $offset = $Slot * 20
    [pscustomobject]@{
        Slot = $Slot
        Name = $(if ($Slot -eq 0) { 'kalcode-win-gate' } else { "kalcode-win-gate-w$Slot" })
        Account = $(if ($Slot -eq 0) { 'kalcode-ci' } else { "kalcode-ci-w$Slot" })
        Root = $(if ($Slot -eq 0) { 'C:\kalcode-ci' } else { Join-Path $Root "worker-w$Slot" })
        Labels = 'kalcode-gate,kalcode-main-pc'
        RegistrationLabels = 'kalcode-gate-pool-staging,kalcode-main-pc'
        E2ePort = 4491 + $offset
        MailPort = 4492 + $offset
        InspectorPort = 9501 + $offset
        UiPort = 1591 + $offset
        CdpPort = 19333 + $Slot * 1000
    }
}

function Test-GateWorkerAdmission {
    param($Sample, [int]$Active = 0)
    # The original slot0 participates through future workflows; its current job stays untouched.
    # Native checks additionally need one of the workflow's three machine-wide heavy leases.
    if ($Active -ge 6) { return 'worker_slots_busy' }
    # Missing or unreadable telemetry never deadlocks the pool: with no other gate running, one gate
    # always runs (as the single-runner gate did). Only extra concurrent gates need real readings.
    $unreadable = $null
    if ($null -eq $Sample -or $null -eq $Sample.Cpu -or $null -eq $Sample.FreeGiB -or
        $null -eq $Sample.CommitPercent -or $null -eq $Sample.DiskQueue) { $unreadable = 'resource_data_unavailable' }
    else {
        foreach ($value in @($Sample.Cpu,$Sample.FreeGiB,$Sample.CommitPercent,$Sample.DiskQueue)) {
            if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { $unreadable = 'resource_data_invalid' }
        }
        if (-not $unreadable -and ($Sample.Cpu -lt 0 -or $Sample.Cpu -gt 100 -or
            $Sample.FreeGiB -lt 0 -or $Sample.CommitPercent -lt 0 -or $Sample.CommitPercent -gt 100 -or
            $Sample.DiskQueue -lt 0)) { $unreadable = 'resource_data_invalid' }
    }
    if ($unreadable) { if ($Active -eq 0) { return 'allowed_without_telemetry' } else { return $unreadable } }
    if ($Sample.FreeGiB -lt (16 + 2 * $Active) -or $Sample.CommitPercent -ge 85) { return 'memory_pressure' }
    if ($Sample.Cpu -ge 85) { return 'cpu_pressure' }
    if ($Sample.DiskQueue -ge 8) { return 'disk_pressure' }
    return 'allowed'
}

function Get-GateWorkerResources {
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
    $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop
    $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter "Name='_Total'" -ErrorAction Stop
    $missing=@()
    if ($null -eq $cpu -or $null -eq $cpu.PercentProcessorTime) { $missing+='PerfOS_Processor.PercentProcessorTime' }
    if ($null -eq $memory -or $null -eq $memory.AvailableMBytes) { $missing+='PerfOS_Memory.AvailableMBytes' }
    if ($null -eq $memory -or $null -eq $memory.PercentCommittedBytesInUse) { $missing+='PerfOS_Memory.PercentCommittedBytesInUse' }
    if ($null -eq $disk -or $null -eq $disk.CurrentDiskQueueLength) { $missing+='PerfDisk_LogicalDisk.CurrentDiskQueueLength' }
    if ($missing.Count) { Write-Host ('Gate resource counters unavailable: '+($missing -join ', ')); return $null }
    [pscustomobject]@{ Cpu = [double]$cpu.PercentProcessorTime; FreeGiB = [double]$memory.AvailableMBytes / 1024
        CommitPercent = [double]$memory.PercentCommittedBytesInUse; DiskQueue = [double]$disk.CurrentDiskQueueLength }
}

function Assert-GateWorkerHost {
    $machine = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    if ($machine.Name -ne 'DESKTOP-KOOB7VV' -or $machine.TotalPhysicalMemory -lt 56GB) {
        throw 'Gate workers belong only on the main 64 GB Windows PC (DESKTOP-KOOB7VV).'
    }
}

function Get-GateWorkerBootTime {
    # Null when unreadable: the before-boot rule is then skipped, never guessed.
    try { return (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime() } catch { return $null }
}

function Get-GateLeaseProcessStart {
    # $null: no such process. '': alive, but its start time is unreadable (another account's process).
    param([int]$ProcessId)
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    try { return $process.StartTime.ToUniversalTime().ToString('o') } catch { return '' }
}

function ConvertTo-GateLeaseInstant($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
    $parsed = [DateTime]::MinValue
    if ([DateTime]::TryParse([string]$Value, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) { return $parsed.ToUniversalTime() }
    return $null
}

function Get-GateLeaseField($Lease, [string]$Name) {
    if ($null -eq $Lease) { return $null }
    $property = $Lease.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Select-GateWorkerPreviousJobTree {
    # Pure selection over a process snapshot: the previous job's Runner.Worker.exe for this slot and the
    # descendants this slot's own account runs, leaves first. Anything else (another slot's live lease,
    # the current job, the interactive user, a reused PID, runner services) is never selected.
    param([object[]]$Processes, [int]$RootPid, [string]$RunnerRoot, [string]$Account, [int[]]$ProtectedPids = @(),
        [scriptblock]$OwnerOf = { param($Process) $Process.Owner })
    $byId = @{}; $children = @{}
    foreach ($process in $Processes) {
        $byId[[int]$process.ProcessId] = $process
        $parent = [int]$process.ParentProcessId
        if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }
        $children[$parent] += $process
    }
    $root = $byId[$RootPid]
    $prefix = $RunnerRoot.TrimEnd('\') + '\'
    if ($null -eq $root -or $root.Name -ne 'Runner.Worker.exe' -or $ProtectedPids -contains $RootPid -or
        -not $root.ExecutablePath -or -not ([string]$root.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        (& $OwnerOf $root) -ne $Account) { return @() }
    $selected = @($root); $queue = New-Object System.Collections.Queue; $queue.Enqueue($root)
    while ($queue.Count) {
        $parent = $queue.Dequeue()
        if (-not $children.ContainsKey([int]$parent.ProcessId)) { continue }
        foreach ($child in $children[[int]$parent.ProcessId]) {
            # A child created before its parent is a reused parent PID, not part of this tree.
            if ($child.CreationDate -lt $parent.CreationDate -or $ProtectedPids -contains [int]$child.ProcessId -or
                $child.Name -match '^(Runner\.Listener|RunnerService)\.exe$' -or (& $OwnerOf $child) -ne $Account) { continue }
            $selected += $child; $queue.Enqueue($child)
        }
    }
    [array]::Reverse($selected)
    return $selected
}

function Stop-GateWorkerPreviousJob {
    # Stops the leftover process tree of this slot's previous job, only after re-proving the lease's exact
    # process (pid + start time) is this slot's Runner.Worker.exe under this slot's own account.
    param([ValidateRange(0,5)][int]$Slot, [int]$ProcessId, [string]$Started, [int[]]$ProtectedPids = @())
    if ((Get-GateLeaseProcessStart -ProcessId $ProcessId) -cne $Started) { return @() }
    $plan = Get-GateWorkerPlan -Slot $Slot
    $tree = Select-GateWorkerPreviousJobTree -Processes @(Get-CimInstance Win32_Process -ErrorAction Stop) -RootPid $ProcessId `
        -RunnerRoot (Join-Path $plan.Root 'runner') -Account $plan.Account -ProtectedPids $ProtectedPids -OwnerOf {
            param($Process)
            $result = Invoke-CimMethod -InputObject $Process -MethodName GetOwner -ErrorAction SilentlyContinue
            if ($null -ne $result -and $result.ReturnValue -eq 0) { $result.User } else { $null }
        }
    foreach ($process in $tree) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    return @($tree | ForEach-Object { "$($_.ProcessId) $($_.Name)" })
}

function Invoke-GateWorkerLeaseSweep {
    # One pass over the per-slot leases, run under admission.lock. A runner slot executes one job at a
    # time, so in Before any lease for this slot that is not the current job's belongs to a job that is
    # already over: it is replaced (and its leftover tree stopped when provably this slot's). Leases of
    # other slots are removed only when their owner is gone, its PID was reused, or it predates the
    # last OS boot; a live (or unreadable) other-slot lease always counts as active.
    param([Parameter(Mandatory = $true)][string]$LeaseDirectory, [ValidateRange(0,5)][int]$Slot,
        [ValidateSet('Before','After')][string]$Phase, [int]$OwnerPid, [string]$OwnerStarted, $BootTime,
        [scriptblock]$ProcessStart = { param($ProcessId) Get-GateLeaseProcessStart -ProcessId $ProcessId },
        [scriptblock]$StopPreviousJob = { param($Entry, $ProtectedPids)
            Stop-GateWorkerPreviousJob -Slot $Entry.Slot -ProcessId $Entry.ProcessId -Started $Entry.Started -ProtectedPids $ProtectedPids })
    $ownName = "slot-$Slot.json"
    $boot = ConvertTo-GateLeaseInstant $BootTime
    $entries = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $LeaseDirectory -Filter 'slot-*.json')) {
        $own = $file.Name -eq $ownName
        $entry = [pscustomobject]@{ Path = $file.FullName; Own = $own; Slot = $null; ProcessId = $null; Started = $null
            Run = $null; State = 'active'; Reason = $null; StopTree = $false }
        if ($file.Name -match '^slot-([0-5])\.json$') { $entry.Slot = [int]$Matches[1] }
        $lease = $null
        try { $lease = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json }
        catch { if (-not ($own -and $Phase -eq 'Before')) { throw } }
        $leasePid = 0
        if ($null -ne $lease) { [void][int]::TryParse([string](Get-GateLeaseField $lease 'pid'), [ref]$leasePid) }
        if ($leasePid -le 0) {
            if (-not ($own -and $Phase -eq 'Before')) { throw "Unreadable gate lease $($file.Name)." }
            $entry.State = 'stale'; $entry.Reason = 'unreadable_lease'; $entries += $entry; continue
        }
        $entry.ProcessId = $leasePid
        $entry.Started = [string](Get-GateLeaseField $lease 'started')
        $entry.Run = Get-GateLeaseField $lease 'run'
        if ($own -and $entry.ProcessId -eq $OwnerPid -and $entry.Started -ceq $OwnerStarted) {
            $entry.State = 'current'; $entries += $entry; continue
        }
        $leaseStart = ConvertTo-GateLeaseInstant $entry.Started
        $observedStart = & $ProcessStart $entry.ProcessId
        if ($null -ne $boot -and $null -ne $leaseStart -and $leaseStart -lt $boot) {
            $entry.State = 'stale'; $entry.Reason = 'started_before_boot'
        } elseif ($null -eq $observedStart) {
            $entry.State = 'stale'; $entry.Reason = 'process_exited'
        } elseif ($observedStart -ne '' -and $observedStart -cne $entry.Started) {
            $entry.State = 'stale'; $entry.Reason = 'process_reused'
        } elseif ($own -and $Phase -eq 'Before') {
            # Unreadable ownership is never stopped; a process of this slot's own account is always readable.
            $entry.State = 'stale'; $entry.Reason = 'previous_job'; $entry.StopTree = $observedStart -ne ''
        }
        $entries += $entry
    }
    $active = @($entries | Where-Object { $_.State -eq 'active' })
    $protected = @(@($active | ForEach-Object { $_.ProcessId }) + $OwnerPid)
    $current = $false
    foreach ($entry in $entries) {
        if ($entry.State -eq 'current') {
            $current = $true
            if ($Phase -eq 'After') { Remove-Item -LiteralPath $entry.Path }
            continue
        }
        if ($entry.State -ne 'stale') { continue }
        $line = "Gate slot $($entry.Slot): removing stale lease ($($entry.Reason); pid $($entry.ProcessId), started $($entry.Started), run $($entry.Run))"
        if ($entry.Own -and $Phase -eq 'Before') { $line += "; new owner pid $OwnerPid, started $OwnerStarted" }
        Write-Host "$line."
        if ($entry.StopTree) {
            try {
                $stopped = @(& $StopPreviousJob $entry $protected)
                if ($stopped.Count) { Write-Host "Gate slot $($entry.Slot): stopped previous job processes: $($stopped -join ', ')." }
            } catch { Write-Warning "Gate slot $($entry.Slot): previous job processes not stopped: $($_.Exception.Message)" }
        }
        Remove-Item -LiteralPath $entry.Path
    }
    [pscustomobject]@{ Current = $current; Active = $active.Count; Entries = $entries }
}

function Set-GateWorkerLease {
    param([Parameter(Mandatory = $true)][string]$LeaseDirectory, [ValidateRange(0,5)][int]$Slot,
        [int]$OwnerPid, [string]$OwnerStarted, $Sample)
    $leasePath = Join-Path $LeaseDirectory "slot-$Slot.json"
    # The sweep under the same admission.lock already replaced any previous-job lease for this slot.
    if (Test-Path -LiteralPath $leasePath) { throw 'Worker already has a different active job.' }
    [ordered]@{ slot = $Slot; pid = $OwnerPid; started = $OwnerStarted
        admitted = [DateTime]::UtcNow.ToString('o'); sample = $Sample
        sha = $env:GITHUB_SHA; run = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; hostName = 'DESKTOP-KOOB7VV' } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $leasePath -Encoding UTF8
}

Export-ModuleMember -Function Get-GateWorkerPlan, Test-GateWorkerAdmission, Get-GateWorkerResources, Assert-GateWorkerHost,
    Get-GateWorkerBootTime, Get-GateLeaseProcessStart, Select-GateWorkerPreviousJobTree, Stop-GateWorkerPreviousJob,
    Invoke-GateWorkerLeaseSweep, Set-GateWorkerLease
