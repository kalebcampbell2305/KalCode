# Pre-job hook for the credentialed release runner (runs as the owner, next to the signing
# login and the DPAPI updater key). Labels are not access control on a personal-account repo:
# any branch's workflow could ask for this runner. The runner runs this hook before every job
# (ACTIONS_RUNNER_HOOK_JOB_STARTED in the runner's .env, which workflows cannot change), and a
# non-zero exit fails the job before any of its steps run.
#
# Only the release workflow from main, started by a push to main or a manual dispatch on main,
# may run here. The values are set by GitHub for the job, not by the workflow.

$repo = 'kalebcampbell2305/KalCode'
$allowed = @(
    "$repo/.github/workflows/release.yml@refs/heads/main"
)
$ok = $env:GITHUB_REPOSITORY -eq $repo `
    -and $env:GITHUB_REF -eq 'refs/heads/main' `
    -and @('push', 'workflow_dispatch') -contains $env:GITHUB_EVENT_NAME `
    -and $allowed -contains $env:GITHUB_WORKFLOW_REF
if (-not $ok) {
    Write-Host "::error::Refused: the release runner only runs release.yml from main (got $($env:GITHUB_WORKFLOW_REF), event $($env:GITHUB_EVENT_NAME), ref $($env:GITHUB_REF))."
    exit 1
}
Write-Host "Release runner guard: allowed $($env:GITHUB_WORKFLOW_REF) for $($env:GITHUB_SHA)."
