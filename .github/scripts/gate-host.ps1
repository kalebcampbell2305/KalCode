# Which gate machine runs this job, and its fixed per-runner resources (owner, 2026-10-08: an elastic gate
# pool; the second PC is always in it, the build PC joins only while it has headroom, as
# tooling/runners/windows/gate-pool-governor.ps1 decides). Any trusted runner may take any gate job, so
# every machine-specific choice of a job comes from here, keyed by the runner's own name.
#
#   . .github/scripts/gate-host.ps1
#   $gateHost = Get-GateHost          # Machine = 'pc2' | 'main-pc'
#
# PC2 (KALEBSLAPTOP): kalcode-win-gate-2, -2b, -2c, -2d; port block 4691.. plus 20 per runner, locks in
#   C:\ProgramData\KalCodePC2\locks (one Rust gate at a time, and the Windows update proof's machine lock).
# Build PC: kalcode-win-gate and -w1..-w5 (the worker pool); ports from gate-worker-pool.psm1, the pool's
#   admission hook, three heavy tokens and its report/evidence folders.

$script:Pc2GateRunners = @('kalcode-win-gate-2', 'kalcode-win-gate-2b', 'kalcode-win-gate-2c', 'kalcode-win-gate-2d')

function Get-GateHost {
    param([string]$RunnerName = $env:RUNNER_NAME)
    $pc2 = [Array]::IndexOf($script:Pc2GateRunners, $RunnerName)
    if ($pc2 -ge 0) {
        $offset = 20 * $pc2
        return [pscustomobject]@{
            Machine = 'pc2'
            Slot = $pc2
            E2ePort = 4691 + $offset
            MailPort = 4692 + $offset
            InspectorPort = 9701 + $offset
            UiPort = 1791 + $offset
            CdpPort = 39333 + $offset
            # desktop-ui and desktop-native-e2e never overlap across this PC's jobs (machine-lock.mjs), in the
            # folder every PC2 runner account can write (tooling/runners/windows/add-gate-runner-pc2.ps1).
            LockDir = 'C:\ProgramData\KalCodePC2\locks'
            Env = @()
        }
    }
    if ($RunnerName -match '^kalcode-win-gate(-w[1-5])?$') {
        Import-Module ./tooling/runners/windows/gate-worker-pool.psm1 -Force
        Assert-GateWorkerHost
        $slot = if ($RunnerName -eq 'kalcode-win-gate') { 0 } else { [int]$RunnerName.Substring($RunnerName.Length - 1) }
        if ($env:KALCODE_GATE_SLOT -and $env:KALCODE_GATE_SLOT -ne [string]$slot) { throw 'Runner name does not match its configured slot' }
        $ports = Get-GateWorkerPlan -Slot $slot
        return [pscustomobject]@{
            Machine = 'main-pc'
            Slot = $slot
            E2ePort = $ports.E2ePort
            MailPort = $ports.MailPort
            InspectorPort = $ports.InspectorPort
            UiPort = $ports.UiPort
            CdpPort = $ports.CdpPort
            LockDir = 'C:\ProgramData\KalCodeGatePool\heavy'
            Env = @(
                "KALCODE_GATE_SLOT=$slot",
                'KALCODE_GATE_REPORT_DIR=C:\ProgramData\KalCodeGatePool\reports',
                'KALCODE_GATE_EVIDENCE_DIR=C:\ProgramData\KalCodeGatePool\evidence'
            )
        }
    }
    throw "Unknown gate runner: $RunnerName"
}

# GITHUB_ENV lines for a job on this host: its ports, lock folder and machine.
function Get-GateHostEnv($GateHost) {
    @(
        "KALCODE_GATE_MACHINE=$($GateHost.Machine)",
        "KALCODE_E2E_PORT=$($GateHost.E2ePort)", "KALCODE_E2E_MAIL_PORT=$($GateHost.MailPort)",
        "KALCODE_E2E_INSPECTOR_PORT=$($GateHost.InspectorPort)", "KALCODE_UI_TEST_PORT=$($GateHost.UiPort)",
        "KALCODE_E2E_CDP_PORT=$($GateHost.CdpPort)",
        "KALCODE_GATE_LOCK_DIR=$($GateHost.LockDir)"
    ) + @($GateHost.Env)
}
