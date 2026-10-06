# Lease sweep and previous-job tree selection against a private temporary lease directory.
# Never reads or writes C:\ProgramData\KalCodeGatePool, never looks up or stops real processes.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'gate-worker-pool.psm1') -Force
function Assert-Equal($actual, $expected, $label) {
    if ($actual -ne $expected) { throw "$label expected=$expected actual=$actual" }
}
$boot = [DateTime]::new(2026, 10, 6, 6, 0, 0, [DateTimeKind]::Utc)
function At([int]$Minutes) { $boot.AddMinutes($Minutes).ToString('o') }
# Fake process table: pid -> start ('' = alive with unreadable start; missing = exited).
$script:processes = @{}
$script:stopped = @()
$lookup = { param($ProcessId) if ($script:processes.ContainsKey([int]$ProcessId)) { $script:processes[[int]$ProcessId] } else { $null } }
$stop = { param($Entry, $ProtectedPids) $script:stopped += [pscustomobject]@{ Slot = $Entry.Slot; ProcessId = $Entry.ProcessId; Protected = @($ProtectedPids) }; @("$($Entry.ProcessId) Runner.Worker.exe") }
$root = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('KalCode-gate-leases-' + [Guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $root | Out-Null
function Write-Lease([int]$Slot, [int]$ProcessId, [string]$Started) {
    @{ slot = $Slot; pid = $ProcessId; started = $Started; run = "run-$ProcessId" } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $root "slot-$Slot.json") -Encoding UTF8
}
function Read-Lease([int]$Slot) {
    $path = Join-Path $root "slot-$Slot.json"
    if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } else { $null }
}
function Reset-Fixture {
    Get-ChildItem -LiteralPath $root -Filter 'slot-*.json' | Remove-Item
    $script:processes = @{}; $script:stopped = @()
}
function Sweep([int]$Slot, [string]$Phase, [int]$OwnerPid, [string]$OwnerStarted) {
    Invoke-GateWorkerLeaseSweep -LeaseDirectory $root -Slot $Slot -Phase $Phase -OwnerPid $OwnerPid -OwnerStarted $OwnerStarted `
        -BootTime $boot -ProcessStart $lookup -StopPreviousJob $stop 6>$null
}
try {
    # 1. Own slot, previous job's Runner.Worker still alive with its exact start: replaced in Before.
    Reset-Fixture
    Write-Lease 1 111 (At 10); $script:processes[111] = At 10
    Write-Lease 2 222 (At 20); $script:processes[222] = At 20
    $sweep = Sweep 1 'Before' 999 (At 60)
    Assert-Equal $sweep.Current $false 'A previous job is not the current job'
    Assert-Equal $sweep.Active 1 'Only the other slot counts against admission'
    Assert-Equal $null (Read-Lease 1) 'Own-slot previous-job lease removed in Before'
    Assert-Equal $script:stopped.Count 1 'Previous job tree stopped once'
    Assert-Equal $script:stopped[0].ProcessId 111 'Only the stale lease process tree is stopped'
    Assert-Equal ($script:stopped[0].Protected -contains 222) $true 'Another slot live lease is protected from the stop'
    Assert-Equal ($script:stopped[0].Protected -contains 999) $true 'The current job is protected from the stop'
    Set-GateWorkerLease -LeaseDirectory $root -Slot 1 -OwnerPid 999 -OwnerStarted (At 60) -Sample $null
    Assert-Equal (Read-Lease 1).pid 999 'New owner lease written for the slot'
    Assert-Equal (Read-Lease 1).started (At 60) 'New owner start recorded'
    Assert-Equal (Read-Lease 2).pid 222 'Other slot lease untouched'

    # The same job re-entering Before (gate.yml's admission step after the job hook) keeps its lease.
    $script:processes[999] = At 60
    $sweep = Sweep 1 'Before' 999 (At 60)
    Assert-Equal $sweep.Current $true 'Current job lease recognized'
    Assert-Equal (Read-Lease 1).pid 999 'Current job lease kept in Before'

    # Own slot owner alive but unreadable (another account reused the PID): replaced, never stopped.
    Reset-Fixture
    Write-Lease 1 111 (At 10); $script:processes[111] = ''
    $sweep = Sweep 1 'Before' 999 (At 60)
    Assert-Equal $null (Read-Lease 1) 'Unreadable own-slot lease replaced in Before'
    Assert-Equal $script:stopped.Count 0 'Unreadable ownership is never stopped'
    Assert-Equal $sweep.Active 0 'Replaced own lease does not count as active'

    # Corrupt own-slot lease is replaced in Before.
    Reset-Fixture
    Set-Content -LiteralPath (Join-Path $root 'slot-1.json') -Value '{not json' -Encoding UTF8
    $sweep = Sweep 1 'Before' 999 (At 60)
    Assert-Equal $null (Read-Lease 1) 'Corrupt own-slot lease replaced in Before'

    # 2. Other slots' live leases are untouched, readable or not.
    Reset-Fixture
    Write-Lease 2 222 (At 20); $script:processes[222] = At 20
    Write-Lease 3 333 (At 30); $script:processes[333] = ''
    foreach ($phase in @('Before', 'After')) {
        $sweep = Sweep 1 $phase 999 (At 60)
        Assert-Equal $sweep.Active 2 "Live other-slot leases count as active ($phase)"
        Assert-Equal (Read-Lease 2).pid 222 "Live other-slot lease kept ($phase)"
        Assert-Equal (Read-Lease 3).pid 333 "Unreadable other-slot lease kept ($phase)"
    }
    Assert-Equal $script:stopped.Count 0 'Other slots are never stopped'
    # Unchanged rules: an exited or reused owner frees another slot's lease.
    $script:processes.Remove(222); $script:processes[333] = At 31
    $sweep = Sweep 1 'Before' 999 (At 60)
    Assert-Equal $sweep.Active 0 'Exited and reused owners are not active'
    Assert-Equal $null (Read-Lease 2) 'Exited owner lease removed'
    Assert-Equal $null (Read-Lease 3) 'Reused PID lease removed'
    # A corrupt other-slot lease still fails closed.
    Set-Content -LiteralPath (Join-Path $root 'slot-4.json') -Value '{not json' -Encoding UTF8
    $rejected = $false; try { Sweep 1 'Before' 999 (At 60) | Out-Null } catch { $rejected = $true }
    Assert-Equal $rejected $true 'Corrupt other-slot lease is not silently removed'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $root 'slot-4.json')) $true 'Corrupt other-slot lease kept'

    # 3. Leases older than the last boot are stale for every slot, even when the PID is alive again.
    Reset-Fixture
    Write-Lease 1 111 (At -30); $script:processes[111] = ''
    Write-Lease 4 444 (At -30); $script:processes[444] = ''
    Write-Lease 5 555 (At -30); $script:processes[555] = At -30
    $sweep = Sweep 2 'Before' 999 (At 60)
    Assert-Equal $sweep.Active 0 'Pre-boot leases never count as active'
    foreach ($slot in 1, 4, 5) { Assert-Equal $null (Read-Lease $slot) "Pre-boot lease removed (slot $slot)" }
    Assert-Equal $script:stopped.Count 0 'Pre-boot PIDs belong to new processes and are never stopped'
    Reset-Fixture
    Write-Lease 1 111 (At -30); $script:processes[111] = ''
    $sweep = Sweep 1 'Before' 999 (At 60)
    Assert-Equal $null (Read-Lease 1) 'Pre-boot own-slot lease replaced (2026-10-06 w1 reboot)'
    Assert-Equal $script:stopped.Count 0 'Pre-boot own-slot PID is never stopped'
    # Without a readable boot time the rule is skipped, not guessed.
    Reset-Fixture
    Write-Lease 4 444 (At -30); $script:processes[444] = ''
    $sweep = Invoke-GateWorkerLeaseSweep -LeaseDirectory $root -Slot 1 -Phase Before -OwnerPid 999 -OwnerStarted (At 60) `
        -BootTime $null -ProcessStart $lookup -StopPreviousJob $stop 6>$null
    Assert-Equal $sweep.Active 1 'Unknown boot time keeps an unreadable live lease occupied'

    # 4. After removes only this job's own lease.
    Reset-Fixture
    Write-Lease 1 999 (At 60); $script:processes[999] = At 60
    Write-Lease 2 222 (At 20); $script:processes[222] = At 20
    $sweep = Sweep 1 'After' 999 (At 60)
    Assert-Equal $sweep.Current $true 'After recognizes its own lease'
    Assert-Equal $null (Read-Lease 1) 'After removes its own lease'
    Assert-Equal (Read-Lease 2).pid 222 'After keeps another slot lease'
    # After never replaces a same-slot lease that belongs to a different live job.
    Reset-Fixture
    Write-Lease 1 111 (At 10); $script:processes[111] = At 10
    $sweep = Sweep 1 'After' 999 (At 60)
    Assert-Equal $sweep.Current $false 'Different job is not this job'
    Assert-Equal (Read-Lease 1).pid 111 'After leaves a different job lease in place'
    Assert-Equal $script:stopped.Count 0 'After never stops processes'

    # Previous-job tree selection: only this slot's Runner.Worker and its own-account descendants.
    $t0 = [DateTime]::new(2026, 10, 6, 7, 0, 0, [DateTimeKind]::Utc)
    function P($id, $parent, $name, $owner, $minutes, $path = $null) {
        [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent; Name = $name; Owner = $owner
            CreationDate = $t0.AddMinutes($minutes); ExecutablePath = $path }
    }
    $runnerRoot = 'C:\kalcode-ci-pool\worker-w1\runner'
    $snapshot = @(
        (P 50 4 'Runner.Listener.exe' 'kalcode-ci-w1' -10 "$runnerRoot\bin\Runner.Listener.exe"),
        (P 111 50 'Runner.Worker.exe' 'kalcode-ci-w1' 0 "$runnerRoot\bin\Runner.Worker.exe"),
        (P 112 111 'node.exe' 'kalcode-ci-w1' 1),
        (P 113 112 'cargo.exe' 'kalcode-ci-w1' 2),
        (P 114 111 'Code.exe' 'Kaleb' 3),
        (P 117 114 'node.exe' 'Kaleb' 4),
        (P 115 111 'Runner.Worker.exe' 'kalcode-ci-w1' 5),
        (P 116 111 'svchost.exe' 'kalcode-ci-w1' -5),
        (P 118 111 'Runner.Listener.exe' 'kalcode-ci-w1' 6),
        (P 999 50 'Runner.Worker.exe' 'kalcode-ci-w1' 30 "$runnerRoot\bin\Runner.Worker.exe")
    )
    $tree = @(Select-GateWorkerPreviousJobTree -Processes $snapshot -RootPid 111 -RunnerRoot $runnerRoot -Account 'kalcode-ci-w1' -ProtectedPids @(115, 999))
    Assert-Equal (($tree | ForEach-Object { $_.ProcessId }) -join ',') '113,112,111' 'Leaves first; no user, protected, reused-PID or runner-service process'
    foreach ($case in @(
        @{ label = 'wrong slot root'; root = 'C:\kalcode-ci-pool\worker-w2\runner'; account = 'kalcode-ci-w1'; protected = @(); rootPid = 111 },
        @{ label = 'wrong account'; root = $runnerRoot; account = 'kalcode-ci-w2'; protected = @(); rootPid = 111 },
        @{ label = 'protected root'; root = $runnerRoot; account = 'kalcode-ci-w1'; protected = @(111); rootPid = 111 },
        @{ label = 'not a job worker'; root = $runnerRoot; account = 'kalcode-ci-w1'; protected = @(); rootPid = 50 },
        @{ label = 'missing process'; root = $runnerRoot; account = 'kalcode-ci-w1'; protected = @(); rootPid = 4242 }
    )) {
        $none = @(Select-GateWorkerPreviousJobTree -Processes $snapshot -RootPid $case.rootPid -RunnerRoot $case.root -Account $case.account -ProtectedPids $case.protected)
        Assert-Equal $none.Count 0 "Nothing selected: $($case.label)"
    }
} finally {
    # Only this script's freshly created fixture directory is removed.
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($root) -ne $parent -or [IO.Path]::GetFileName($root) -notmatch '^KalCode-gate-leases-[a-f0-9]{32}$') { throw 'Unexpected fixture cleanup path.' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Host 'PASS: gate leases: own-slot previous job replaced in Before, other slots kept, pre-boot leases stale, After removes only its own lease.'
