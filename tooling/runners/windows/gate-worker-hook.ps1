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
$leasePath = Join-Path $leases "slot-$Slot.json"

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
$lastReason = ''
do {
    $lock = $null
    try {
        try { $lock = [IO.File]::Open((Join-Path $leases 'admission.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if (($_.Exception.HResult -band 0xffff) -ne 32) { throw }
        }
        if ($null -ne $lock) {
            $active = 0
            foreach ($file in Get-ChildItem $leases -Filter 'slot-*.json') {
                $lease = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
                $process = Get-Process -Id $lease.pid -ErrorAction SilentlyContinue
                if ($null -eq $process) {
                    Remove-Item -LiteralPath $file.FullName
                    continue
                }
                # Unreadable ownership is occupied, never a reason to remove another live lease.
                $sameProcess = $true
                try { $sameProcess = $process.StartTime.ToUniversalTime().ToString('o') -eq $lease.started }
                catch { $sameProcess = $true }
                if (-not $sameProcess) { Remove-Item -LiteralPath $file.FullName; continue }
                if ($file.FullName -eq $leasePath -and $lease.pid -eq $owner.ProcessId -and $lease.started -eq $started) {
                    if ($Phase -eq 'After') { Remove-Item -LiteralPath $file.FullName; exit 0 }
                    exit 0
                }
                $active++
            }
            if ($Phase -eq 'After') { exit 0 }
            $sample = $null
            try { $sample = Get-GateWorkerResources } catch { Write-Warning 'Resource sampling unavailable.' }
            $reason = Test-GateWorkerAdmission -Sample $sample -Active $active
            if ($reason -eq 'allowed_without_telemetry') {
                Write-Warning "Gate slot ${Slot}: resource telemetry is unreadable; admitting the only active gate without it."
            }
            if ($reason -eq 'allowed' -or $reason -eq 'allowed_without_telemetry') {
                if (Test-Path -LiteralPath $leasePath) { throw 'Worker already has a different active job.' }
                [ordered]@{ slot = $Slot; pid = $owner.ProcessId; started = $started
                    admitted = [DateTime]::UtcNow.ToString('o'); sample = $sample
                    sha = $env:GITHUB_SHA; run = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; hostName = 'DESKTOP-KOOB7VV' } |
                    ConvertTo-Json -Compress | Set-Content -LiteralPath $leasePath -Encoding UTF8
                Write-Host "Gate slot $Slot admitted; background priority, isolated ports/caches."
                exit 0
            }
            if ($reason -ne $lastReason) { Write-Host "Gate slot $Slot waiting: $reason (user agents take priority)."; $lastReason = $reason }
        }
    } finally { if ($null -ne $lock) { $lock.Dispose() } }
    Start-Sleep -Seconds 5
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Gate resource admission timed out; no checks were run and no success is claimed.'
