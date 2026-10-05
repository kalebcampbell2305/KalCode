# Compatibility entry point for the canonical six-slot pool. No arguments prints a plan.
# Install forwards to the hash-bound UAC wrapper. Plaintext registration tokens, account
# resets and replacing/restarting existing runners are unsupported. Tokens are fetched
# inside the elevated staged installer, never passed in launch arguments.
param(
    [switch]$Install,
    [string]$SourceManifest,
    [string]$SourceManifestSha256,
    [string]$RunnerSha256,
    [string]$Receipt,
    [string]$ResumeDiagnostic,
    [string]$ResumeDiagnosticSha256,
    [string]$ToolsManifest,
    [string]$ToolsManifestSha256,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
if (-not $Install) {
    & (Join-Path $PSScriptRoot 'setup-gate-worker-pool.ps1')
    exit $LASTEXITCODE
}
$parameters=@{SourceManifest=$SourceManifest;SourceManifestSha256=$SourceManifestSha256;RunnerSha256=$RunnerSha256;Receipt=$Receipt}
if ($ResumeDiagnostic) { $parameters.ResumeDiagnostic=$ResumeDiagnostic; $parameters.ResumeDiagnosticSha256=$ResumeDiagnosticSha256 }
if ($ToolsManifest -or $ToolsManifestSha256) { $parameters.ToolsManifest=$ToolsManifest; $parameters.ToolsManifestSha256=$ToolsManifestSha256 }
if ($ValidateOnly) { $parameters.ValidateOnly=$true }
& (Join-Path $PSScriptRoot 'invoke-gate-worker-pool-install.ps1') @parameters
exit $LASTEXITCODE
