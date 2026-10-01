# Installs or refreshes the KalCode release runner on the owner's Windows PC (run as the owner;
# no elevation). This runner runs as the owner because the release needs the owner's Azure
# signing login, the DPAPI-protected updater key and Wrangler. It is fenced by
# release-job-guard.ps1, installed beside the runner (outside any checkout) and wired as the
# runner's pre-job hook, so only release.yml from main can run here.
#
# Usage: powershell -ExecutionPolicy Bypass -File setup-release-runner.ps1 [-RegistrationToken <token>]
# A token is needed only to (re)register; get one with
#   gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token

param(
    [string]$RegistrationToken,
    [string]$RunnerVersion = '2.337.0',
    [string]$Runner = 'C:\actions-runner-kalcode'
)

$ErrorActionPreference = 'Stop'
$aclModule = Join-Path $PSScriptRoot 'release-runner-acl.psm1'
Import-Module $aclModule -Force
$approvedRunner = 'C:\actions-runner-kalcode'

Assert-ApprovedReleaseRunnerRoot -Root $Runner -ApprovedRoot $approvedRunner | Out-Null
New-Item -ItemType Directory -Force -Path $Runner | Out-Null
Assert-ReleaseRunnerStopped -Root $Runner -ApprovedRoot $approvedRunner
# Protect the directory before downloading or creating registration state so every
# new object inherits an owner-only ACL. Reapply and verify after setup because an
# archive or runner command can bring its own descriptors.
Set-ReleaseRunnerOwnerOnlyAcl -Root $Runner -ApprovedRoot $approvedRunner
if (-not (Test-Path (Join-Path $Runner 'config.cmd'))) {
    $zip = Join-Path $env:TEMP "actions-runner-win-x64-$RunnerVersion.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $zip
    Expand-Archive -Force -Path $zip -DestinationPath $Runner
}

# The guard lives with the runner, not in a checkout a job could modify.
$guard = Join-Path $Runner 'release-job-guard.ps1'
Copy-Item -Force (Join-Path $PSScriptRoot 'release-job-guard.ps1') $guard
$envFile = Join-Path $Runner '.env'
$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' }) }
$lines += "ACTIONS_RUNNER_HOOK_JOB_STARTED=$guard"
$lines | Set-Content -Encoding ascii -Path $envFile

if ($RegistrationToken) {
    Push-Location $Runner
    try {
        & .\config.cmd --unattended --replace `
            --url https://github.com/kalebcampbell2305/KalCode --token $RegistrationToken `
            --name kalcode-win-release --labels kalcode-release --work _work
        if ($LASTEXITCODE -ne 0) { throw "runner configuration failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

# Start at sign-in, in the owner's session (DPAPI and the Azure login belong to it).
$startup = [Environment]::GetFolderPath('Startup')
"@start `"KalCode release runner`" /min `"$Runner\run.cmd`"" |
    Set-Content -Encoding ascii -Path (Join-Path $startup 'kalcode-release-runner.cmd')
Set-ReleaseRunnerOwnerOnlyAcl -Root $Runner -ApprovedRoot $approvedRunner
$aclStatus = Assert-ReleaseRunnerOwnerOnlyAcl -Root $Runner -ApprovedRoot $approvedRunner
Write-Host "Release runner ready at $Runner (guard: $guard). It starts at sign-in; start it now with $Runner\run.cmd."
Write-Host "Release runner ACL verified for $($aclStatus.ItemCount) items."
