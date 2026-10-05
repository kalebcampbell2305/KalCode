# One elevated, idempotent step that makes every main-PC gate worker able to run the pool hooks:
#  - slot 0 (kalcode-ci) and w1..w5 (kalcode-ci-w1..w5) join Performance Monitor Users, so the
#    admission hook can read the CPU/memory/disk counters (without them it saw no telemetry);
#  - the repo's current gate-worker-hook.ps1, gate-worker-pool.psm1 and the before/after .js job
#    hooks are installed into C:\ProgramData\KalCodeGatePool with the pool's inherited ACLs;
#  - the shared leases/reports/evidence/heavy folders keep the grants setup-gate-worker-pool.ps1 defines.
# Refuses while any gate job runs. Never changes runner registrations, labels or other services; it
# restarts an idle gate runner service only when its account newly joined the counter group (group
# membership applies at logon). Writes a hash receipt into the pool's reports folder.
#
# Usage (elevated):
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-gate-pool-hooks.ps1
param([string]$Report = '')
$ErrorActionPreference = 'Stop'
$pool = 'C:\ProgramData\KalCodeGatePool'
$reports = Join-Path $pool 'reports'
if (-not $Report) { $Report = Join-Path $reports ('hook-install-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json') }
$result = [ordered]@{ schema = 'kalcode-gate-hook-install/v1'; state = 'PREFLIGHT'; at = [DateTime]::UtcNow.ToString('o')
    errorCode = $null; files = @(); accounts = @(); restarted = @() }
function Refuse([string]$Code) { $result.errorCode = $Code; throw "Gate hook install refused: $Code" }
function Assert-Plain([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and
            ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Refuse 'reparse_path' }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
}
$workers = @(@{ slot = 0; account = 'kalcode-ci'; service = 'actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate'; root = 'C:\kalcode-ci\runner' }) +
    @(1..5 | ForEach-Object { @{ slot = $_; account = "kalcode-ci-w$_"; service = "actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate-w$_"
        root = "C:\kalcode-ci-pool\worker-w$_\runner" } })
function Assert-NoGateJob {
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'")) {
        if (-not $process.ExecutablePath) { Refuse 'unknown_job_process_owner' }
        foreach ($worker in $workers) {
            if ($process.ExecutablePath.StartsWith($worker.root + '\', [StringComparison]::OrdinalIgnoreCase)) { Refuse "gate_job_running_slot_$($worker.slot)" }
        }
    }
}
try {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'windows_uac_required' }
    if ([Environment]::MachineName -ne 'DESKTOP-KOOB7VV') { Refuse 'wrong_host' }
    if (-not (Test-Path -LiteralPath $pool -PathType Container)) { Refuse 'pool_not_installed' }
    Assert-Plain $pool
    Assert-NoGateJob

    # Shared folders and their grants, exactly as setup-gate-worker-pool.ps1 defines them.
    foreach ($worker in $workers) {
        $sid = (Get-LocalUser -Name $worker.account -ErrorAction Stop).SID.Value
        $worker.sid = $sid
        & icacls $pool /grant "*${sid}:(OI)(CI)RX" | Out-Null
        if ($LASTEXITCODE) { Refuse "pool_read_acl_slot_$($worker.slot)" }
        foreach ($name in @('leases', 'reports', 'evidence', 'heavy')) {
            $folder = Join-Path $pool $name; Assert-Plain $folder
            if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
            & icacls $folder /grant "*${sid}:(OI)(CI)M" | Out-Null
            if ($LASTEXITCODE) { Refuse "shared_acl_${name}_slot_$($worker.slot)" }
        }
    }

    # The repo's current hooks; each installed file takes the pool's inherited ACL.
    $copies = @(
        @{ source = 'gate-worker-pool.psm1'; target = 'gate-worker-pool.psm1' },
        @{ source = 'gate-worker-hook.ps1'; target = 'gate-worker-hook.ps1' },
        @{ source = 'gate-worker-job-hook.js'; target = 'before.js' },
        @{ source = 'gate-worker-job-hook.js'; target = 'after.js' }
    )
    foreach ($copy in $copies) {
        $source = Join-Path $PSScriptRoot $copy.source; Assert-Plain $source
        $target = Join-Path $pool $copy.target; Assert-Plain $target
        $before = if (Test-Path -LiteralPath $target) { (Get-FileHash -LiteralPath $target).Hash } else { $null }
        Copy-Item -LiteralPath $source -Destination $target -Force
        & icacls $target /reset | Out-Null
        if ($LASTEXITCODE) { Refuse "file_acl_$($copy.target)" }
        $after = (Get-FileHash -LiteralPath $target).Hash
        if ($after -ne (Get-FileHash -LiteralPath $source).Hash) { Refuse "copy_mismatch_$($copy.target)" }
        $result.files += [ordered]@{ file = $copy.target; previousSha256 = $before; sha256 = $after }
    }

    # Performance Monitor Users (S-1-5-32-558): read the performance counters the admission hook samples.
    foreach ($worker in $workers) {
        $account = Get-LocalUser -Name $worker.account -ErrorAction Stop
        $member = @(Get-LocalGroupMember -SID 'S-1-5-32-558' | Where-Object { $_.SID.Value -eq $account.SID.Value }).Count -eq 1
        if (-not $member) { Add-LocalGroupMember -SID 'S-1-5-32-558' -Member $account }
        if (@(Get-LocalGroupMember -SID 'S-1-5-32-558' | Where-Object { $_.SID.Value -eq $account.SID.Value }).Count -ne 1) {
            Refuse "performance_read_membership_unconfirmed_slot_$($worker.slot)"
        }
        $worker.added = -not $member
        $result.accounts += [ordered]@{ slot = $worker.slot; account = $worker.account; performanceReadGroup = 'S-1-5-32-558'; added = (-not $member) }
    }

    # A service picks up the new group only at its next logon; restart those still idle.
    foreach ($worker in @($workers | Where-Object { $_.added })) {
        $service = Get-CimInstance Win32_Service -Filter "Name='$($worker.service)'"
        if ($null -eq $service) { continue }
        Assert-NoGateJob
        Restart-Service -Name $worker.service
        (Get-Service -Name $worker.service).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
        $result.restarted += $worker.service
    }
    $result.state = 'INSTALLED'
} catch {
    $result.state = 'FAILED'
    if (-not $result.errorCode) { $result.errorCode = $_.Exception.Message }
} finally {
    $receipt = $result | ConvertTo-Json -Depth 5
    try {
        if (Test-Path -LiteralPath $reports) { Assert-Plain $Report; Set-Content -LiteralPath $Report -Value $receipt -Encoding UTF8 }
    } catch { Write-Warning "Receipt not written: $($_.Exception.Message)" }
    Write-Output $receipt
}
if ($result.state -ne 'INSTALLED') { exit 1 }
