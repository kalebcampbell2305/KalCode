# Add five isolated workers beside the original main-PC runner. Planning is read-only; -Install requires normal Windows UAC.
# Never resets/reconfigures the existing kalcode-ci account, runner, service, or checkout.
param(
    [switch]$Install,
    [switch]$FetchRegistrationToken,
    [Security.SecureString]$RegistrationToken,
    [string]$ResumeDiagnostic,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ResumeDiagnosticSha256,
    [string]$ToolsManifest,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ToolsManifestSha256,
    [string]$ResumeServiceState,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ResumeServiceStateSha256,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$RunnerVersion = '2.337.0',
    [string]$RunnerSha256,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$PnpmVersion = '10.33.2'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'gate-worker-pool.psm1') -Force
Assert-GateWorkerHost
$plans = @(1..5 | ForEach-Object { Get-GateWorkerPlan -Slot $_ })
$allPlans = $plans
if (-not $Install) { $plans | ConvertTo-Json -Depth 4; exit 0 }
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Installation needs an elevated PowerShell approved through Windows UAC. Planning does not.'
}
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
if ($RunnerSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Provide the official runner archive SHA256 before installation.' }
if ($FetchRegistrationToken -and $null -ne $RegistrationToken) { throw 'Choose one registration token input.' }
if (-not $FetchRegistrationToken -and ($null -eq $RegistrationToken -or $RegistrationToken.Length -eq 0)) {
    throw 'Use -FetchRegistrationToken in the elevated owner shell, or provide a short-lived token as SecureString.'
}

$pool = 'C:\ProgramData\KalCodeGatePool'
$workerContainer = 'C:\kalcode-ci-pool'
$tools = Join-Path $pool 'tools'
$leaseRoot = Join-Path $pool 'leases'
$reportRoot = Join-Path $pool 'reports'
$evidenceRoot = Join-Path $pool 'evidence'
$heavyRoot = Join-Path $pool 'heavy'
$marker = Join-Path $pool 'installed.json'
function Invoke-GateSetupTool([string]$File, [string[]]$ToolArguments) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Setup tool is missing: $File" }
    $priorPreference = $ErrorActionPreference
    try {
        # Windows PowerShell can classify ordinary native progress on stderr as an error.
        # Native exit status remains authoritative; never turn a failed command into success.
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = $null
        & $File @ToolArguments
        $toolExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $priorPreference }
    if ($null -eq $toolExit -or $toolExit -ne 0) { throw "Setup tool failed: $([IO.Path]::GetFileName($File)) (exit $toolExit)" }
}
function Assert-OrdinaryPath([string]$Path) {
    $itemPath = [IO.Path]::GetFullPath($Path)
    while ($itemPath) {
        if (Test-Path -LiteralPath $itemPath) {
            $item = Get-Item -LiteralPath $itemPath -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse path refused: $itemPath" }
        }
        $parent = Split-Path -Parent $itemPath
        if ($parent -eq $itemPath) { break }
        $itemPath = $parent
    }
}
function ConvertFrom-GateChecksumResponse($Content) {
    $text = if ($Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($Content) } else { [string]$Content }
    $hash = ($text.Trim() -split '\s+')[0]
    if ($hash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid official checksum response.' }
    return $hash
}
function Install-ApprovedCargoTools([string]$Destination) {
    Assert-OrdinaryPath $ToolsManifest
    if (-not $ToolsManifestSha256 -or (Get-FileHash -LiteralPath $ToolsManifest -Algorithm SHA256).Hash -ne $ToolsManifestSha256) { throw 'Approved tool manifest hash changed.' }
    $manifest=Get-Content -LiteralPath $ToolsManifest -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 'kalcode-gate-cargo-tools/v1' -or $manifest.tools.Count -ne 2) { throw 'Exactly two approved Cargo tools are required.' }
    $versions=@{'cargo-deny.exe'='cargo-deny 0.20.2';'cargo-audit.exe'='cargo-audit 0.22.2'}
    $seen=@{}
    foreach ($tool in $manifest.tools) {
        if ($tool.name -cnotin @($versions.Keys) -or $seen.ContainsKey([string]$tool.name) -or
            $tool.version -cne $versions[$tool.name] -or $tool.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Approved tool identity differs.' }
        $seen[$tool.name]=$true
        # Only administrator-staged bytes are used here; never read owner config or caches.
        $source=Join-Path (Join-Path $PSScriptRoot 'approved-cargo-tools') $tool.name
        Assert-OrdinaryPath $source
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $tool.sha256) { throw 'Staged tool bytes changed.' }
    }
    foreach ($tool in $manifest.tools) {
        $source=Join-Path (Join-Path $PSScriptRoot 'approved-cargo-tools') $tool.name
        $target=Join-Path $Destination $tool.name
        Assert-OrdinaryPath $target
        if (Test-Path -LiteralPath $target) { throw 'Approved tool destination already exists; inspect before replacement.' }
        Copy-Item -LiteralPath $source -Destination $target
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $tool.sha256) { throw 'Installed tool bytes changed.' }
        $version=(& $target --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $version -cne $tool.version) { throw 'Installed tool version differs.' }
    }
}
function Assert-InspectedPreToolResume {
    Assert-OrdinaryPath $ResumeDiagnostic
    if ((Get-FileHash -LiteralPath $ResumeDiagnostic -Algorithm SHA256).Hash -ne $ResumeDiagnosticSha256) { throw 'Resume diagnostic hash changed.' }
    $inspection = Get-Content -LiteralPath $ResumeDiagnostic -Raw | ConvertFrom-Json
    if ($inspection.schema -ne 'kalcode-gate-worker-diagnostic/v1' -or $inspection.state -ne 'INSPECTED' -or
        $inspection.host -ne 'DESKTOP-KOOB7VV' -or @($inspection.logs | Where-Object { $_.name -eq 'stderr.log' -and $_.facts.missingKnownMethod -eq 'Trim' }).Count -ne 1 -or
        $inspection.sources.Count -ne 4 -or @($inspection.sources | Where-Object { -not $_.stagedMatches }).Count -ne 0 -or
        $inspection.accounts.Count -ne 3 -or $inspection.services.Count -ne 3 -or
        @($inspection.accounts + $inspection.services | Where-Object { $_.exists }).Count -ne 0) { throw 'Only the inspected pre-tool checksum failure can resume.' }
    foreach ($path in @($pool,$workerContainer,$tools,(Join-Path $tools 'rustup-init.exe'))) {
        $proof = @($inspection.paths | Where-Object { $_.path -eq $path })
        Assert-OrdinaryPath $path
        if ($proof.Count -ne 1 -or -not $proof[0].exists -or -not (Test-Path -LiteralPath $path) -or (Get-Acl -LiteralPath $path).Sddl -ne $proof[0].sddl) { throw 'Inspected path or ACL changed.' }
        if (-not $proof[0].directory -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $proof[0].sha256) { throw 'Inspected tool changed.' }
    }
    if (@(Get-ChildItem -LiteralPath $workerContainer -Force).Count -ne 0) { throw 'Worker container is no longer empty.' }
    $toolEntries = @(Get-ChildItem -LiteralPath $tools -Force)
    if ($toolEntries.Count -ne 1 -or $toolEntries[0].Name -ne 'rustup-init.exe') { throw 'Unexpected partial tool state; resume refused.' }
    $expected = @('tools','leases','reports','evidence','gate-worker-pool.psm1','gate-worker-hook.ps1','before.cmd','after.cmd')
    $entries = @(Get-ChildItem -LiteralPath $pool -Force)
    if ($entries.Count -ne $expected.Count -or @($entries | Where-Object { $_.Name -notin $expected }).Count -ne 0) { throw 'Unexpected pool state; resume refused.' }
    $originalSid = (Get-LocalUser -Name 'kalcode-ci' -ErrorAction Stop).SID.Value
    $observerSid = (Get-LocalUser -Name 'Kaleb' -ErrorAction Stop).SID.Value
    foreach ($entry in $entries) {
        Assert-OrdinaryPath $entry.FullName
        $acl = Get-Acl -LiteralPath $entry.FullName
        if ($acl.Owner -notin @('BUILTIN\Administrators','S-1-5-32-544')) { throw 'Unexpected partial pool owner.' }
        foreach ($ace in $acl.Access) {
            $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            $writable = ([int]$ace.FileSystemRights -band 0xD0156) -ne 0
            $sharedWriter = $sid -eq $originalSid -and $entry.Name -in @('leases','reports','evidence')
            if ($ace.AccessControlType -ne 'Allow' -or $sid -notin @('S-1-5-18','S-1-5-32-544',$originalSid,$observerSid) -or
                ($writable -and $sid -notin @('S-1-5-18','S-1-5-32-544') -and -not $sharedWriter) -or
                ($sid -eq $observerSid -and $entry.Name -ne 'reports')) { throw 'Unexpected partial pool ACL.' }
        }
    }
    foreach ($shared in @($leaseRoot,$reportRoot,$evidenceRoot)) {
        if (@(Get-ChildItem -LiteralPath $shared -Force).Count -ne 0) { throw 'Pool is in use; resume refused.' }
    }
    # The old four-worker source was staged but never used by any new service. Verify
    # its exact inspected bytes before installing the reviewed six-slot implementation.
    $inspectedSources = @{
        'gate-worker-pool.psm1'='A6F881C6D22EC029B7FBBE284E1F7C58B58E37E6330AED0E6FFB8F9A99F26829'
        'gate-worker-hook.ps1'='76435CBDD9A9F4BD6D5807C79C2CBDEF3DE7653D12DC4ACB08ECEAFF8CC66B67'
    }
    foreach ($name in $inspectedSources.Keys) {
        if ((Get-FileHash -LiteralPath (Join-Path $pool $name)).Hash -ne $inspectedSources[$name]) { throw 'Inspected protected pool source differs.' }
    }
    foreach ($phase in @('Before','After')) {
        $expectedCommand = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0gate-worker-hook.ps1" -Phase ' + $phase
        $commands = @(Get-Content -LiteralPath (Join-Path $pool ($phase.ToLowerInvariant() + '.cmd')))
        if ($commands.Count -ne 2 -or $commands[0] -cne $expectedCommand -or $commands[1] -cne 'exit /b %errorlevel%') { throw 'Protected hook command differs.' }
    }
    foreach ($plan in $plans) {
        if ((Get-LocalUser -Name $plan.Account -ErrorAction SilentlyContinue) -or
            (Get-Service -Name "actions.runner.kalebcampbell2305-KalCode.$($plan.Name)" -ErrorAction SilentlyContinue)) { throw 'Worker account or service exists; resume refused.' }
    }
    foreach ($oldWorker in 2..4) {
        if ((Get-LocalUser -Name "kalcode-ci-$oldWorker" -ErrorAction SilentlyContinue) -or
            (Get-Service -Name "actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate-worker-$oldWorker" -ErrorAction SilentlyContinue)) { throw 'Prior worker identity exists; resume refused.' }
    }
}
function Assert-FirstServiceResume {
    Assert-OrdinaryPath $ResumeServiceState
    if (-not $ResumeServiceStateSha256 -or (Get-FileHash -LiteralPath $ResumeServiceState).Hash -ne $ResumeServiceStateSha256) { throw 'Service continuation manifest changed.' }
    $state=Get-Content -LiteralPath $ResumeServiceState -Raw | ConvertFrom-Json
    if ($state.schema -ne 'kalcode-gate-first-service-resume/v1' -or $state.host -ne 'DESKTOP-KOOB7VV' -or $state.slot -ne 1 -or $state.runnerId -ne 27) { throw 'Unexpected service continuation identity.' }
    $receiptPath=Join-Path $PSScriptRoot 'resume-service-receipt.json'
    $sourcesPath=Join-Path $PSScriptRoot 'resume-service-sources.json'
    foreach ($pair in @(@{path=$receiptPath;hash=$state.failedReceipt.sha256},@{path=$sourcesPath;hash=$state.failedSources.sha256})) {
        Assert-OrdinaryPath $pair.path
        if ((Get-FileHash -LiteralPath $pair.path).Hash -ne $pair.hash) { throw 'Service continuation provenance changed.' }
    }
    $failed=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($failed.state -ne 'FAILED' -or $failed.phase -ne 'installer' -or $failed.exitCode -ne 1 -or
        $failed.sourceManifestSha256 -ne $state.failedSources.sha256 -or $failed.runnerSha256 -ne $RunnerSha256 -or
        $failed.protectedLogDirectory -notmatch '^C:\\ProgramData\\KalCodeGatePoolSetup-[a-f0-9]{32}$') { throw 'Unexpected failed installer receipt.' }
    $failedSources=Get-Content -LiteralPath $sourcesPath -Raw | ConvertFrom-Json
    if ($failedSources.Count -ne 4) { throw 'Unexpected failed source inventory.' }
    foreach ($source in $failedSources) {
        $name=[IO.Path]::GetFileName($source.Path)
        if ($name -notin @('setup-gate-worker-pool.ps1','gate-worker-pool.psm1','gate-worker-hook.ps1','test-gate-worker-pool.ps1')) { throw 'Unexpected failed source name.' }
        $oldPath=Join-Path $failed.protectedLogDirectory $name; Assert-OrdinaryPath $oldPath
        if ((Get-FileHash -LiteralPath $oldPath).Hash -ne $source.Hash) { throw 'Failed staged source changed.' }
        if ($name -in @('gate-worker-pool.psm1','gate-worker-hook.ps1')) {
            $protected=Join-Path $pool $name; Assert-OrdinaryPath $protected
            if ((Get-FileHash -LiteralPath $protected).Hash -ne $source.Hash) { throw 'Prepared protected source changed.' }
        }
    }
    if ((Get-Acl -LiteralPath $workerContainer).Sddl -cne $state.parentSddl -or
        (Get-Acl -LiteralPath $pool).Sddl -cne $state.poolSddl) { throw 'Inspected parent or pool ACL changed.' }
    $first=Get-GateWorkerPlan -Slot 1
    $account=Get-LocalUser -Name $first.Account -ErrorAction Stop
    if ($account.SID.Value -ne $state.accountSid -or -not $account.Enabled) { throw 'First worker account changed.' }
    $serviceName="actions.runner.kalebcampbell2305-KalCode.$($first.Name)"
    $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    $expectedExe='"' + (Join-Path $first.Root 'runner\bin\RunnerService.exe') + '"'
    if ($null -eq $service -or $service.State -ne 'Stopped' -or $service.ProcessId -ne 0 -or $service.StartName -ne ".\$($first.Account)" -or $service.PathName -ne $expectedExe) { throw 'First worker service changed.' }
    $runnerSettings=Join-Path $first.Root 'runner\.runner'; Assert-OrdinaryPath $runnerSettings
    $registration=Get-Content -LiteralPath $runnerSettings -Raw | ConvertFrom-Json
    if ($registration.agentId -ne $state.runnerId -or $registration.agentName -ne $first.Name -or $registration.gitHubUrl.TrimEnd('/') -ne 'https://github.com/kalebcampbell2305/KalCode') { throw 'First worker registration changed.' }
    $original=Get-CimInstance Win32_Service -Filter "Name='actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate'"
    foreach ($key in @('Name','State','StartName','PathName','ProcessId')) {
        if ($original.$key -ne $state.originalService.$key) { throw 'Original runner identity or state changed; no repair attempted.' }
    }
    if (Test-Path -LiteralPath $marker) { throw 'Completed pool cannot use partial continuation.' }
    $roots=@(Get-ChildItem -LiteralPath $workerContainer -Force)
    if ($roots.Count -ne 1 -or $roots[0].Name -ne 'worker-w1') { throw 'Unexpected partial worker roots.' }
    foreach ($plan in @($plans | Where-Object {$_.Slot -ne 1})) {
        if ((Get-LocalUser -Name $plan.Account -ErrorAction SilentlyContinue) -or
            (Get-Service -Name "actions.runner.kalebcampbell2305-KalCode.$($plan.Name)" -ErrorAction SilentlyContinue)) { throw 'Another partial worker exists.' }
    }
    foreach ($shared in @($leaseRoot,$heavyRoot,$reportRoot,$evidenceRoot)) {
        Assert-OrdinaryPath $shared
        if (@(Get-ChildItem -LiteralPath $shared -Force).Count -ne 0) { throw 'Prepared pool is in use; no repair attempted.' }
    }
    $prepared=@{
        "actions-runner-win-x64-$RunnerVersion.zip"=$RunnerSha256
        'cargo\bin\cargo-deny.exe'='C2D046F2FF2616B06B02B1D02F0F1CC5AFA4EF72477D51457CA6D3E8D9E99DBE'
        'cargo\bin\cargo-audit.exe'='FA45E38A91807A508239E725C773B512685A8B9A5C8905749EAA937B9081B9E7'
        'rustup-init.exe'='6F4BEF66261261FCB43131BE8720BAB817D403A09EDEC7455C371974B90BDB7E'
    }
    foreach ($relative in $prepared.Keys) {
        $path=Join-Path $tools $relative; Assert-OrdinaryPath $path
        if ((Get-FileHash -LiteralPath $path).Hash -ne $prepared[$relative]) { throw 'Prepared tool or archive changed.' }
    }
    return $state
}
Assert-OrdinaryPath $pool
Assert-OrdinaryPath $workerContainer
foreach ($tool in @('C:\Program Files\nodejs\node.exe','C:\Program Files\nodejs\npm.cmd','C:\Program Files\Git\cmd\git.exe')) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Required system tool missing: $tool" }
    Assert-OrdinaryPath $tool
}
if (Test-Path -LiteralPath $marker) {
    $prior = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($prior.machine -ne 'DESKTOP-KOOB7VV' -or $prior.runnerVersion -ne $RunnerVersion) { throw 'Installed pool identity differs; explicit upgrade review required.' }
    foreach ($plan in $plans) {
        $service = Get-Service -Name "actions.runner.kalebcampbell2305-KalCode.$($plan.Name)" -ErrorAction Stop
        if ($service.Status -ne 'Running') { throw "Existing worker $($plan.Slot) needs diagnosis; installer will not reset/restart it." }
    }
    Write-Host 'The five additional gate services already exist and are running; nothing changed.'
    exit 0
}
if ($ResumeServiceState) {
    if ($ResumeDiagnostic -or $ToolsManifest) { throw 'Continuation modes cannot be combined.' }
    $serviceState=Assert-FirstServiceResume
    $plans=@($plans | Where-Object {$_.Slot -ne 1})
} elseif ($ResumeDiagnostic) {
    if (-not $ResumeDiagnosticSha256) { throw 'A reviewed diagnostic hash is required to resume.' }
    Assert-InspectedPreToolResume
} else {
    if ($ResumeDiagnosticSha256) { throw 'Resume diagnostic path is required.' }
    if (Test-Path -LiteralPath $pool) { throw 'Unrecognized or partial pool directory already exists; inspect it before installation. Nothing will be overwritten.' }
    if (Test-Path -LiteralPath $workerContainer) { throw 'Unrecognized or partial worker container already exists; nothing will be overwritten.' }
}
if ($ToolsManifestSha256 -and -not $ToolsManifest) { throw 'Approved tools manifest path is required.' }
if ($ResumeServiceStateSha256 -and -not $ResumeServiceState) { throw 'Service continuation path is required.' }
foreach ($plan in $plans) {
    if ((Get-LocalUser -Name $plan.Account -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $plan.Root)) {
        throw "Unfinished or pre-existing worker $($plan.Slot); inspect it before retrying. No account passwords are reset."
    }
}
if ((Get-PSDrive C).Free -lt 40GB) { throw 'At least 40 GiB free is required before provisioning tools and isolated workers.' }
if (-not $ResumeServiceState) {
if (-not $ResumeDiagnostic) {
New-Item -ItemType Directory -Path $pool,$tools,$leaseRoot,$reportRoot,$evidenceRoot,$workerContainer -Force | Out-Null
& icacls $pool /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Cannot secure the pool root.' }
& icacls $workerContainer /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Cannot secure the worker container.' }
$originalSid = (Get-LocalUser -Name 'kalcode-ci' -ErrorAction Stop).SID.Value
& icacls $pool /grant "*${originalSid}:(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE) { throw 'Original worker pool-read ACL failed.' }
& icacls $leaseRoot /grant "*${originalSid}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE) { throw 'Original worker lease ACL failed.' }
foreach ($shared in @($reportRoot,$evidenceRoot)) {
    & icacls $shared /grant "*${originalSid}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE) { throw 'Original worker shared evidence ACL failed.' }
}
$observerSid = (Get-LocalUser -Name 'Kaleb' -ErrorAction Stop).SID.Value
& icacls $reportRoot /grant "*${observerSid}:(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE) { throw 'Sanitized report observer ACL failed.' }
}
# Fresh install or the specifically inspected empty pre-tool state only. The original
# runner directory, service, account, environment and active job remain untouched.
New-Item -ItemType Directory -Path $heavyRoot | Out-Null
$originalSid = (Get-LocalUser -Name 'kalcode-ci' -ErrorAction Stop).SID.Value
& icacls $heavyRoot /grant "*${originalSid}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE) { throw 'Original worker heavy-lease ACL failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gate-worker-pool.psm1') -Destination $pool
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gate-worker-hook.ps1') -Destination $pool
@('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0gate-worker-hook.ps1" -Phase Before','exit /b %errorlevel%') |
    Set-Content -LiteralPath (Join-Path $pool 'before.cmd') -Encoding ascii
@('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0gate-worker-hook.ps1" -Phase After','exit /b %errorlevel%') |
    Set-Content -LiteralPath (Join-Path $pool 'after.cmd') -Encoding ascii
} else {
    # Root-only read/traverse, with no inheritance into other workers' private trees.
    & icacls $workerContainer /grant "*$($serviceState.accountSid):RX" | Out-Null
    if ($LASTEXITCODE) { throw 'First worker parent traversal ACL failed.' }
    $firstService='actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate-w1'
    Start-Service -Name $firstService
    (Get-Service -Name $firstService).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
}

# Install one administrator-owned toolchain, read-only to worker accounts. Build caches remain
# per worker. This does not borrow the owner's credentials, existing runner cache, or release cache.
$rustupDir = Join-Path $tools 'rustup'
$toolCargo = Join-Path $tools 'cargo'
$npm = Join-Path $tools 'npm'
if (-not $ResumeServiceState) {
$savedRustup = $env:RUSTUP_HOME; $savedCargo = $env:CARGO_HOME
try {
    $env:RUSTUP_HOME = $rustupDir; $env:CARGO_HOME = $toolCargo
    $rustup = Join-Path $tools 'rustup-init.exe'
    $rustupUrl = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
    if (-not $ResumeDiagnostic) { Invoke-WebRequest -UseBasicParsing -Uri $rustupUrl -OutFile $rustup }
    $expectedRustup = ConvertFrom-GateChecksumResponse (Invoke-WebRequest -UseBasicParsing -Uri "$rustupUrl.sha256").Content
    if ($expectedRustup -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $rustup -Algorithm SHA256).Hash -ne $expectedRustup) { throw 'rustup archive hash mismatch.' }
    Invoke-GateSetupTool $rustup @('-y','--no-modify-path','--profile','minimal','--default-toolchain','stable','-c','rustfmt','-c','clippy')
    Invoke-GateSetupTool 'C:\Program Files\nodejs\npm.cmd' @('install','--global','--prefix',$npm,"pnpm@$PnpmVersion")
    $cargo = Join-Path $toolCargo 'bin\cargo.exe'
    if ($ToolsManifest) {
        # Supplied evidence must validate. Never fall back to compilation on a mismatch.
        Install-ApprovedCargoTools (Join-Path $toolCargo 'bin')
    } else {
        Invoke-GateSetupTool $cargo @('install','cargo-deny','--version','0.20.2','--locked','--jobs','2','--root',$toolCargo)
        Invoke-GateSetupTool $cargo @('install','cargo-audit','--version','0.22.2','--locked','--jobs','2','--root',$toolCargo)
    }
} finally { $env:RUSTUP_HOME = $savedRustup; $env:CARGO_HOME = $savedCargo }
$archive = Join-Path $tools "actions-runner-win-x64-$RunnerVersion.zip"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $archive
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $RunnerSha256) { throw 'Runner archive hash mismatch.' }
} else { $archive=Join-Path $tools "actions-runner-win-x64-$RunnerVersion.zip" }

if ($FetchRegistrationToken) {
    # Request only after tools are prepared, so the short-lived token does not expire during
    # setup. gh uses the already-authorized owner's existing auth; no credential file is copied.
    $registrationRaw = & gh api --method POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token
    if ($LASTEXITCODE -or [string]::IsNullOrWhiteSpace($registrationRaw)) { throw 'Cannot obtain the short-lived runner registration token.' }
    $RegistrationToken = ConvertTo-SecureString $registrationRaw.Trim() -AsPlainText -Force
    $registrationRaw = $null
}
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($RegistrationToken)
$priorToken = $env:ACTIONS_RUNNER_INPUT_TOKEN
$priorPassword = $env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD
try {
    # Runner reads secret inputs from its supported ACTIONS_RUNNER_INPUT_* environment. Never
    # put these in argv, .env, the manifest, source, or a transcript.
    $env:ACTIONS_RUNNER_INPUT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
    foreach ($plan in $plans) {
        $bytes = New-Object byte[] 48
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $password = 'Kc9!' + [Convert]::ToBase64String($bytes)
        $secure = ConvertTo-SecureString $password -AsPlainText -Force
        New-LocalUser -Name $plan.Account -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -Description 'KalCode main-PC optional gate worker' | Out-Null
        $sid = (Get-LocalUser -Name $plan.Account).SID.Value
        & icacls $workerContainer /grant "*${sid}:RX" | Out-Null
        if ($LASTEXITCODE) { throw 'Worker parent traversal ACL failed.' }
        $runner = Join-Path $plan.Root 'runner'; $workerHome = Join-Path $plan.Root 'home'; $temp = Join-Path $workerHome 'tmp'
        New-Item -ItemType Directory -Path $runner,$workerHome,$temp -Force | Out-Null
        & icacls $plan.Root /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' "*${sid}:(OI)(CI)M" | Out-Null
        if ($LASTEXITCODE) { throw 'Worker root ACL failed.' }
        & icacls $pool /grant "*${sid}:(OI)(CI)RX" | Out-Null
        if ($LASTEXITCODE) { throw 'Pool tools ACL failed.' }
        & icacls $leaseRoot /grant "*${sid}:(OI)(CI)M" | Out-Null
        if ($LASTEXITCODE) { throw 'Pool lease ACL failed.' }
        foreach ($shared in @($reportRoot,$evidenceRoot,$heavyRoot)) {
            & icacls $shared /grant "*${sid}:(OI)(CI)M" | Out-Null
            if ($LASTEXITCODE) { throw 'Pool reports/evidence ACL failed.' }
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $runner
        @(
            "RUSTUP_HOME=$rustupDir", "CARGO_HOME=$(Join-Path $workerHome 'cargo')", "PNPM_HOME=$npm"
            "npm_config_cache=$(Join-Path $workerHome 'npm-cache')", "PLAYWRIGHT_BROWSERS_PATH=$(Join-Path $workerHome 'ms-playwright')"
            "TEMP=$temp", "TMP=$temp", "KALCODE_GATE_SLOT=$($plan.Slot)", "KALCODE_GATE_WORKER_ROOT=$($plan.Root)"
            "KALCODE_GATE_POOL_ROOT=$pool", 'KALCODE_GATE_CONCURRENCY=2', 'KALCODE_GATE_JOBS=2', 'CARGO_BUILD_JOBS=2', 'VITEST_MAX_WORKERS=2'
            "KALCODE_GATE_LOCK_DIR=$heavyRoot", 'KALCODE_GATE_HEAVY_SLOTS=3', 'KALCODE_GATE_MIN_FREE_GB=10'
            "KALCODE_GATE_REPORT_DIR=$reportRoot", "KALCODE_GATE_EVIDENCE_DIR=$evidenceRoot"
            "KALCODE_E2E_PORT=$($plan.E2ePort)", "KALCODE_E2E_MAIL_PORT=$($plan.MailPort)"
            "KALCODE_E2E_INSPECTOR_PORT=$($plan.InspectorPort)", "KALCODE_UI_TEST_PORT=$($plan.UiPort)"
            "KALCODE_E2E_CDP_PORT=$($plan.CdpPort)"
            "ACTIONS_RUNNER_HOOK_JOB_STARTED=$(Join-Path $pool 'before.cmd')"
            "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$(Join-Path $pool 'after.cmd')"
            "PATH=$(Join-Path $toolCargo 'bin');$npm;C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Program Files\Git\usr\bin;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"
            'GIT_CONFIG_NOSYSTEM=1'
        ) | Set-Content -LiteralPath (Join-Path $runner '.env') -Encoding ascii
        $env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD = $password
        Push-Location $runner
        try {
            Invoke-GateSetupTool (Join-Path $runner 'config.cmd') @('--unattended','--url','https://github.com/kalebcampbell2305/KalCode','--name',$plan.Name,'--labels',$plan.RegistrationLabels,'--work','_work','--runasservice','--windowslogonaccount',".\$($plan.Account)")
        } finally { Pop-Location; $env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD = $null; $password = $null }
    }
} finally {
    $env:ACTIONS_RUNNER_INPUT_TOKEN = $priorToken
    $env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD = $priorPassword
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
}
[ordered]@{ machine = 'DESKTOP-KOOB7VV'; runnerVersion = $RunnerVersion; runnerSha256 = $RunnerSha256
    installed = [DateTime]::UtcNow.ToString('o'); workers = $allPlans; preservedExistingWorker = $true } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $marker -Encoding UTF8
Write-Host 'Five workers installed with staging labels. Activate kalcode-gate only after the compatible pool workflow is ready and obsolete queued workflows cannot be assigned. Preserve the active original gate.'
Write-Host 'Verify all six online identities, isolated ports, pressure waits, and four overlapping lightweight jobs before claiming the pool operational.'
