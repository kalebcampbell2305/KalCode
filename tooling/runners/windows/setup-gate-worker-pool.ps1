# Add five isolated workers beside the original main-PC runner. Planning is read-only; -Install requires normal Windows UAC.
# Never resets/reconfigures the existing kalcode-ci account, runner, service, or checkout.
param(
    [switch]$Install,
    [switch]$FetchRegistrationToken,
    [Security.SecureString]$RegistrationToken,
    [string]$ResumeDiagnostic,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ResumeDiagnosticSha256,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$RunnerVersion = '2.337.0',
    [string]$RunnerSha256,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$PnpmVersion = '10.33.2'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'gate-worker-pool.psm1') -Force
Assert-GateWorkerHost
$plans = @(1..5 | ForEach-Object { Get-GateWorkerPlan -Slot $_ })
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
if ($ResumeDiagnostic) {
    if (-not $ResumeDiagnosticSha256) { throw 'A reviewed diagnostic hash is required to resume.' }
    Assert-InspectedPreToolResume
} else {
    if ($ResumeDiagnosticSha256) { throw 'Resume diagnostic path is required.' }
    if (Test-Path -LiteralPath $pool) { throw 'Unrecognized or partial pool directory already exists; inspect it before installation. Nothing will be overwritten.' }
    if (Test-Path -LiteralPath $workerContainer) { throw 'Unrecognized or partial worker container already exists; nothing will be overwritten.' }
}
foreach ($plan in $plans) {
    if ((Get-LocalUser -Name $plan.Account -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $plan.Root)) {
        throw "Unfinished or pre-existing worker $($plan.Slot); inspect it before retrying. No account passwords are reset."
    }
}
if ((Get-PSDrive C).Free -lt 40GB) { throw 'At least 40 GiB free is required before provisioning tools and isolated workers.' }
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

# Install one administrator-owned toolchain, read-only to worker accounts. Build caches remain
# per worker. This does not borrow the owner's credentials, existing runner cache, or release cache.
$rustupDir = Join-Path $tools 'rustup'
$toolCargo = Join-Path $tools 'cargo'
$npm = Join-Path $tools 'npm'
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
    Invoke-GateSetupTool $cargo @('install','cargo-deny','--version','0.20.2','--locked','--jobs','2','--root',$toolCargo)
    Invoke-GateSetupTool $cargo @('install','cargo-audit','--version','0.22.2','--locked','--jobs','2','--root',$toolCargo)
} finally { $env:RUSTUP_HOME = $savedRustup; $env:CARGO_HOME = $savedCargo }
$archive = Join-Path $tools "actions-runner-win-x64-$RunnerVersion.zip"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $archive
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $RunnerSha256) { throw 'Runner archive hash mismatch.' }

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
        $runner = Join-Path $plan.Root 'runner'; $home = Join-Path $plan.Root 'home'; $temp = Join-Path $home 'tmp'
        New-Item -ItemType Directory -Path $runner,$home,$temp -Force | Out-Null
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
            "RUSTUP_HOME=$rustupDir", "CARGO_HOME=$(Join-Path $home 'cargo')", "PNPM_HOME=$npm"
            "npm_config_cache=$(Join-Path $home 'npm-cache')", "PLAYWRIGHT_BROWSERS_PATH=$(Join-Path $home 'ms-playwright')"
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
    installed = [DateTime]::UtcNow.ToString('o'); workers = $plans; preservedExistingWorker = $true } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $marker -Encoding UTF8
Write-Host 'Five workers installed with staging labels. Activate kalcode-gate only after the compatible pool workflow is ready and obsolete queued workflows cannot be assigned. Preserve the active original gate.'
Write-Host 'Verify all six online identities, isolated ports, pressure waits, and four overlapping lightweight jobs before claiming the pool operational.'
