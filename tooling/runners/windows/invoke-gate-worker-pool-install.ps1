# Run through normal Windows UAC. Tokens/passwords never appear in launch arguments.
# Readable receipts contain only stages, codes and hashes; raw output is administrator-only.
param(
    [Parameter(Mandatory=$true)][string]$SourceManifest,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$SourceManifestSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$RunnerSha256,
    [Parameter(Mandatory=$true)][string]$Receipt,
    [string]$ResumeDiagnostic,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ResumeDiagnosticSha256,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetExtension($Receipt) -ne '.json' -or
    [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Receipt)) -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($SourceManifest))) {
    throw 'The new JSON receipt must be beside the reviewed source manifest.'
}
if (Test-Path -LiteralPath $Receipt) { throw 'Use a new receipt path; preserve earlier attempts.' }
$result = [ordered]@{ schema='kalcode-gate-worker-install/v1'; state='PREFLIGHT'; phase='authority'; host=[Environment]::MachineName
    started=[DateTime]::UtcNow.ToString('o'); finished=$null; sourceManifestSha256=$SourceManifestSha256
    runnerSha256=$RunnerSha256; pid=$null; exitCode=$null; errorCode=$null; protectedLogDirectory=$null
    workers=@(); activeOriginalRunnerModified=$false; productionChecksPassed=$false; validateOnly=[bool]$ValidateOnly }
function Save-Result {
    $temporary = "$Receipt.$([Guid]::NewGuid().ToString('N')).tmp"
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
    if (Test-Path -LiteralPath $Receipt) { [IO.File]::Replace($temporary,$Receipt,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$Receipt) }
}
function Refuse([string]$Code) { $result.errorCode=$Code; throw 'Gate worker setup refused; inspect the sanitized receipt.' }
Save-Result
$stage = $null
try {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $ValidateOnly -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'windows_uac_required' }
    if ([Environment]::MachineName -ne 'DESKTOP-KOOB7VV') { Refuse 'wrong_host' }
    $result.phase='manifest'; Save-Result
    if ((Get-FileHash -LiteralPath $SourceManifest -Algorithm SHA256).Hash -ne $SourceManifestSha256) { Refuse 'manifest_hash_changed' }
    $allowed = @('setup-gate-worker-pool.ps1','gate-worker-pool.psm1','gate-worker-hook.ps1','test-gate-worker-pool.ps1')
    # Windows PowerShell 5.1 preserves a JSON array as one pipeline object. Assign directly;
    # wrapping the pipeline in @() would turn four source records into one nested array.
    $sources = Get-Content -LiteralPath $SourceManifest -Raw | ConvertFrom-Json
    if ($null -eq $sources -or $sources.Count -ne $allowed.Count) { Refuse 'source_inventory_count' }
    $result.phase='sources'; Save-Result
    $seen = @{}
    foreach ($source in $sources) {
        $name = [IO.Path]::GetFileName($source.Path)
        if ($name -notin $allowed -or $seen.ContainsKey($name) -or $source.Hash -notmatch '^[a-fA-F0-9]{64}$') { Refuse 'source_inventory_invalid' }
        if ((Get-FileHash -LiteralPath $source.Path -Algorithm SHA256).Hash -ne $source.Hash) { Refuse 'source_hash_changed' }
        $seen[$name] = $true
    }
    if ($ResumeDiagnostic) {
        if (-not $ResumeDiagnosticSha256 -or (Get-FileHash -LiteralPath $ResumeDiagnostic -Algorithm SHA256).Hash -ne $ResumeDiagnosticSha256) { Refuse 'resume_diagnostic_hash_changed' }
    } elseif ($ResumeDiagnosticSha256) { Refuse 'resume_diagnostic_path_missing' }
    if ($ValidateOnly) {
        $result.state='VERIFIED_NO_INSTALL'; $result.phase='complete'
    } else {
        $result.phase='stage'; Save-Result
        $stage = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('KalCodeGatePoolSetup-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage | Out-Null
        & icacls $stage /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE) { Refuse 'setup_acl_failed' }
        $result.protectedLogDirectory=$stage
        foreach ($source in $sources) {
            $destination = Join-Path $stage ([IO.Path]::GetFileName($source.Path))
            Copy-Item -LiteralPath $source.Path -Destination $destination
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $source.Hash) { Refuse 'staged_source_hash_changed' }
        }
        $result.phase='installer'; Save-Result
        $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $stage 'setup-gate-worker-pool.ps1'),'-Install','-FetchRegistrationToken','-RunnerSha256',$RunnerSha256)
        if ($ResumeDiagnostic) {
            $stagedDiagnostic=Join-Path $stage 'resume-diagnostic.json'
            Copy-Item -LiteralPath $ResumeDiagnostic -Destination $stagedDiagnostic
            if ((Get-FileHash -LiteralPath $stagedDiagnostic -Algorithm SHA256).Hash -ne $ResumeDiagnosticSha256) { Refuse 'staged_diagnostic_hash_changed' }
            $arguments += @('-ResumeDiagnostic',$stagedDiagnostic,'-ResumeDiagnosticSha256',$ResumeDiagnosticSha256)
        }
        $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stage 'stdout.log') -RedirectStandardError (Join-Path $stage 'stderr.log')
        $null = $process.Handle
        $result.pid=$process.Id; $result.state='INSTALLING'; Save-Result
        $process.WaitForExit(); $process.Refresh()
        $result.exitCode=$process.ExitCode
        if ($null -eq $process.ExitCode -or $process.ExitCode -ne 0) { Refuse 'installer_failed' }
        $result.phase='services'; Save-Result
        foreach ($slot in 1..5) {
            $name = "actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate-w$slot"
            $service = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction Stop
            if ($null -eq $service -or $service.State -ne 'Running' -or $service.StartName -ne ".\kalcode-ci-w$slot") { Refuse 'service_identity_or_state' }
            $result.workers += @{slot=$slot;service=$service.Name;state=$service.State;account=$service.StartName}
        }
        $result.state='INSTALLED_STAGED'; $result.phase='complete'
    }
} catch {
    $result.state='FAILED'
    if ($null -eq $result.errorCode) { $result.errorCode=$_.Exception.GetType().Name }
    if ($null -ne $stage -and (Test-Path -LiteralPath $stage)) { $_ | Out-String | Add-Content -LiteralPath (Join-Path $stage 'wrapper-error.log') }
} finally { $result.finished=[DateTime]::UtcNow.ToString('o'); Save-Result }
if ($result.state -notin @('INSTALLED_STAGED','VERIFIED_NO_INSTALL')) { exit 1 }
