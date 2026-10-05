# Gate workspace hygiene on a self-hosted pool worker. Runs as the worker's own account, so it
# only ever sees (and can only stop) that account's processes; the owner and other workers are
# untouched.
#   -Phase Stop   stop processes left behind under this worker's runner _work directory by a
#                 cancelled or killed job (test binaries, rustc, node), keeping this job's own tree.
#   -Phase Reset  make the checkout the exact event SHA while keeping the warm Cargo target and
#                 node_modules: checkout runs with clean:false because `git clean -ffdx` deleted the
#                 warm target and failed on DLLs an orphan still held (gate 37362947496).
param([Parameter(Mandatory = $true)][ValidateSet('Stop', 'Reset')][string]$Phase)
$ErrorActionPreference = 'Stop'

function Get-WorkRoot {
    $workspace = if ($env:RUNNER_WORKSPACE) { $env:RUNNER_WORKSPACE } else { Split-Path -Parent $env:GITHUB_WORKSPACE }
    if (-not $workspace) { throw 'Runner workspace is unknown' }
    # <runner>\_work\<repo> -> <runner>\_work
    return ([IO.Path]::GetFullPath((Split-Path -Parent $workspace))).TrimEnd('\') + '\'
}

function Stop-WorkspaceOrphans {
    $root = Get-WorkRoot
    if ($root -notmatch '\\_work\\$') { throw "Refusing to clean outside a runner _work directory: $root" }
    $all = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($process in $all) { $byId[[int]$process.ProcessId] = $process }
    # This step's own ancestry (powershell -> Runner.Worker -> ...) is the live job; never stop it.
    $keep = @{}
    $cursor = $byId[[int]$PID]
    for ($i = 0; $i -lt 16 -and $null -ne $cursor; $i++) {
        $keep[[int]$cursor.ProcessId] = $true
        $cursor = $byId[[int]$cursor.ParentProcessId]
    }
    $stopped = 0
    foreach ($process in $all) {
        $id = [int]$process.ProcessId
        if ($keep.ContainsKey($id)) { continue }
        if ($process.Name -match '^(Runner\.(Worker|Listener)|RunnerService)\.exe$') { continue }
        # ExecutablePath/CommandLine are only readable for this account's own processes.
        $exe = [string]$process.ExecutablePath
        $command = [string]$process.CommandLine
        if (-not $exe) { continue }
        $underRoot = $exe.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or
            ($command -and $command.IndexOf($root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -ge 0)
        if (-not $underRoot) { continue }
        Write-Output "Stopping orphan $id $($process.Name) left under $root"
        $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & taskkill.exe /T /F /PID $id 2>&1 | Out-Null
        $ErrorActionPreference = $previous
        $stopped++
    }
    Write-Output "Workspace orphans stopped: $stopped"
}

function Reset-ExactCheckout {
    if ($env:GITHUB_SHA -notmatch '^[0-9a-f]{40}$') { throw 'GITHUB_SHA is not an immutable commit' }
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & git reset --hard --quiet $env:GITHUB_SHA
    $resetExit = $LASTEXITCODE
    # Everything untracked or ignored goes except the warm caches; a locked file inside them can
    # never fail the gate, and stale build outputs elsewhere (apps/desktop/dist, reports) are removed.
    & git clean -ffdxq -e target/ -e node_modules/
    $ErrorActionPreference = $previous
    if ($resetExit) { throw "git reset --hard $env:GITHUB_SHA failed ($resetExit)" }
    # A previous run's evidence must never be uploaded as this run's.
    Remove-Item -LiteralPath (Join-Path (Get-Location) 'target\gate-evidence.json') -Force -ErrorAction SilentlyContinue
    $head = (& git rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -or $head -ne $env:GITHUB_SHA) { throw 'Checkout does not match the immutable event SHA' }
    $dirty = (& git status --porcelain --untracked-files=no | Out-String).Trim()
    if ($dirty) { throw "Tracked files differ from $env:GITHUB_SHA after reset" }
    Write-Output "Checkout is exactly $env:GITHUB_SHA (warm target and node_modules kept)."
}

if ($Phase -eq 'Stop') { Stop-WorkspaceOrphans } else { Reset-ExactCheckout }
