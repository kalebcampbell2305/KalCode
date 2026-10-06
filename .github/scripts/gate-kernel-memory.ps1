# Refuses to start a gate on a machine whose kernel nonpaged pool has grown past what its sockets and file
# I/O can rely on, and warns before that. A file-system filter leaked kernel FILE objects on the build PC
# (nonpaged pool 3.78 GB after ~37 h, growing ~2.6 MB/min while gates ran), and the UI suite then failed
# with net::ERR_NO_BUFFER_SPACE (WSAENOBUFS, run 37417037628). Only a restart frees that memory, so a
# clear refusal here beats a random socket failure 20 minutes into a gate.
#
#   .github/scripts/gate-kernel-memory.ps1                      # reads the live counter
#   .github/scripts/gate-kernel-memory.ps1 -NonpagedBytes 7GB   # tests
param([long]$NonpagedBytes = -1, [long]$WarnBytes = 2GB, [long]$RefuseBytes = 6GB)
$ErrorActionPreference = 'Stop'
if ($NonpagedBytes -lt 0) {
    try {
        $NonpagedBytes = [long](Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).PoolNonpagedBytes
    } catch {
        Write-Output "::warning::Could not read the kernel nonpaged pool size ($($_.Exception.Message)); not checked."
        exit 0
    }
}
$gb = [math]::Round($NonpagedBytes / 1GB, 2)
$machine = $env:COMPUTERNAME
if ($NonpagedBytes -ge $RefuseBytes) {
    Write-Output "::error::$machine's kernel nonpaged pool is $gb GB (limit $([math]::Round($RefuseBytes / 1GB, 1)) GB): a driver is leaking kernel memory and network connections fail at random (ERR_NO_BUFFER_SPACE). Restart $machine, then rerun this gate. C:\kc-handoff\build-pc-maintenance.ps1 captures which driver leaks."
    exit 1
}
if ($NonpagedBytes -ge $WarnBytes) {
    Write-Output "::warning::$machine's kernel nonpaged pool is $gb GB (warns at $([math]::Round($WarnBytes / 1GB, 1)) GB, refuses at $([math]::Round($RefuseBytes / 1GB, 1)) GB). A driver is leaking kernel memory; restart $machine between lanes."
    exit 0
}
Write-Output "Kernel nonpaged pool $gb GB on $machine."
exit 0
