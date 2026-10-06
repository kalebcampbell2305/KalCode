param([ValidateSet('Before','After')][string]$Phase = 'Before',
    [ValidateRange(-1,5)][int]$Slot = -1, [ValidateRange(1,3600)][int]$WaitSeconds = 1800)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'gate-worker-pool.psm1') -Force
Assert-GateWorkerHost
if ($Slot -eq -1) {
    if ($env:KALCODE_GATE_SLOT -notmatch '^[0-5]$') { throw 'Unregistered gate worker.' }
    $Slot = [int]$env:KALCODE_GATE_SLOT
}
$plan = Get-GateWorkerPlan -Slot $Slot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Name -ne "$env:COMPUTERNAME\$($plan.Account)") { throw 'Wrong gate worker account.' }
$pool = 'C:\ProgramData\KalCodeGatePool'
$leases = Join-Path $pool 'leases'

# Only the current runner job and its descendants are deprioritized; never touch user agents.
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
for ($i = 0; $i -lt 8 -and $owner.Name -ne 'Runner.Worker.exe'; $i++) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ParentProcessId)"
    if ($null -eq $owner) { throw 'Cannot establish runner job ownership.' }
}
if ($owner.Name -ne 'Runner.Worker.exe') { throw 'This hook requires a runner-owned job.' }
$ownerProcess = Get-Process -Id $owner.ProcessId -ErrorAction Stop
$started = $ownerProcess.StartTime.ToUniversalTime().ToString('o')
$ownerProcess.PriorityClass = 'BelowNormal'
$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
# A lease whose owner started before the last OS boot is stale, even when its PID was reused.
$bootTime = Get-GateWorkerBootTime
$lastReason = ''
do {
    $lock = $null
    try {
        try { $lock = [IO.File]::Open((Join-Path $leases 'admission.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if (($_.Exception.HResult -band 0xffff) -ne 32) { throw }
        }
        if ($null -ne $lock) {
            # This slot runs one job at a time: in Before, a lease for this slot that is not this job's is
            # replaced. Other slots' live leases are never removed; After removes only this job's lease.
            $sweep = Invoke-GateWorkerLeaseSweep -LeaseDirectory $leases -Slot $Slot -Phase $Phase `
                -OwnerPid $owner.ProcessId -OwnerStarted $started -BootTime $bootTime
            if ($sweep.Current -or $Phase -eq 'After') { exit 0 }
            $active = $sweep.Active
            $sample = $null
            try { $sample = Get-GateWorkerResources } catch { Write-Warning 'Resource sampling unavailable.' }
            $reason = Test-GateWorkerAdmission -Sample $sample -Active $active
            if ($reason -eq 'allowed_without_telemetry') {
                Write-Warning "Gate slot ${Slot}: resource telemetry is unreadable; admitting the only active gate without it."
            }
            if ($reason -eq 'allowed' -or $reason -eq 'allowed_without_telemetry') {
                Set-GateWorkerLease -LeaseDirectory $leases -Slot $Slot -OwnerPid $owner.ProcessId -OwnerStarted $started -Sample $sample
                Write-Host "Gate slot $Slot admitted; background priority, isolated ports/caches."
                exit 0
            }
            if ($reason -ne $lastReason) { Write-Host "Gate slot $Slot waiting: $reason (user agents take priority)."; $lastReason = $reason }
        }
    } finally { if ($null -ne $lock) { $lock.Dispose() } }
    Start-Sleep -Seconds 5
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Gate resource admission timed out; no checks were run and no success is claimed.'
