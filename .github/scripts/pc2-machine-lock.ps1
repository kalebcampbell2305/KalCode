# The second PC's machine lock: its gate halves and its Windows update proof never overlap.
#
# The second PC (KALEBSLAPTOP) runs two gate runners (kalcode-win-gate-2, -2b) and the update-proof runner
# (kalcode-win-desktop-qa). A gate half and the proof running together slowed both into timeouts (the
# DiffView and tooling-unit failures of 2026-10-05), and with two gate runners the machine is rarely idle,
# so the "never dispatch the proof during a gate half" rule needs a lock, not timing.
#
# A reader/writer lock made of OS file-sharing modes in C:\ProgramData\KalCodePC2\locks (created, with
# Modify for every runner account, by tooling/runners/windows/add-gate-runner-pc2.ps1):
#   - a gate half holds gate.lock SHARED (read access, FileShare.Read), so both gate runners can hold it;
#   - the update proof holds gate.lock EXCLUSIVE (FileShare.None), so it waits for in-flight gate halves,
#     and no gate half starts while it runs;
#   - the proof has priority ("the Feed proof wins"): it first holds qa-intent.lock exclusively for its
#     whole wait and run, and a gate half does not take a new shared hold while that intent is held.
# Handles live in the calling step's own process, so the lock is released when the step finishes, fails,
# is cancelled or is killed. A stale lock is impossible. Waits are bounded and fail with the reason.
# Without the lock folder (a PC not yet set up) both callers warn and proceed, as before this lock existed.
#
#   . .github/scripts/pc2-machine-lock.ps1
#   $lock = Enter-Pc2MachineLock -Mode Shared      # or Exclusive
#   try { ... } finally { Exit-Pc2MachineLock $lock }

function Enter-Pc2MachineLock {
    param(
        [Parameter(Mandatory)][ValidateSet('Shared', 'Exclusive')][string]$Mode,
        [int]$TimeoutMinutes = 90,
        [string]$Directory = 'C:\ProgramData\KalCodePC2\locks',
        [int]$PollMilliseconds = 2000
    )
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        Write-Host "::warning::The second PC's machine lock folder ($Directory) is missing; running without the lock."
        return $null
    }
    $gate = Join-Path $Directory 'gate.lock'
    $intent = Join-Path $Directory 'qa-intent.lock'
    $deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
    $announced = $false
    $intentHandle = $null
    while ($true) {
        try {
            if ($Mode -eq 'Exclusive') {
                # Priority first: from now on no gate half takes a new shared hold.
                if ($null -eq $intentHandle) { $intentHandle = [IO.File]::Open($intent, 'OpenOrCreate', 'ReadWrite', 'None') }
                $handle = [IO.File]::Open($gate, 'OpenOrCreate', 'ReadWrite', 'None')
            } else {
                # A held proof intent refuses this open (it shares nothing): wait behind the proof.
                ([IO.File]::Open($intent, 'OpenOrCreate', 'Read', 'ReadWrite')).Dispose()
                $handle = [IO.File]::Open($gate, 'OpenOrCreate', 'Read', 'Read')
            }
            Write-Host "The second PC's machine lock is held ($($Mode.ToLower()))."
            return [pscustomobject]@{ Mode = $Mode; Handle = $handle; Intent = $intentHandle }
        } catch [System.UnauthorizedAccessException] {
            # A runner account without rights on the folder must not block its job forever.
            if ($null -ne $intentHandle) { $intentHandle.Dispose() }
            Write-Host "::warning::No access to the second PC's machine lock ($($_.Exception.Message)); running without the lock."
            return $null
        } catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) {
                if ($null -ne $intentHandle) { $intentHandle.Dispose() }
                $holder = if ($Mode -eq 'Exclusive') { 'gate halves' } else { 'the Windows update proof' }
                throw "The second PC's machine lock was still held by $holder after $TimeoutMinutes minutes."
            }
            if (-not $announced) {
                $other = if ($Mode -eq 'Exclusive') { 'running gate halves to finish' } else { 'the Windows update proof to finish' }
                Write-Host "Waiting for $other on this PC (machine lock)."
                $announced = $true
            }
            Start-Sleep -Milliseconds $PollMilliseconds
        }
    }
}

function Exit-Pc2MachineLock {
    param($Lock)
    if ($null -eq $Lock) { return }
    if ($null -ne $Lock.Handle) { $Lock.Handle.Dispose() }
    if ($null -ne $Lock.Intent) { $Lock.Intent.Dispose() }
}
