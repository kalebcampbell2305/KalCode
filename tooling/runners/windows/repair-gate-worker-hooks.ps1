# One bounded repair for the five newly installed, staging-only, idle pool services.
# Never reconfigures accounts/registrations or stops the original runner. No raw env logs.
param([Parameter(Mandatory=$true)][string]$Report)
$ErrorActionPreference='Stop'
if (Test-Path -LiteralPath $Report) { throw 'Preserve previous repair receipts.' }
$result=[ordered]@{schema='kalcode-gate-hook-repair/v1';state='PREFLIGHT';at=[DateTime]::UtcNow.ToString('o');errorCode=$null;workers=@();originalPreserved=$false}
function Refuse([string]$Code) { $result.errorCode=$Code; throw 'Gate hook repair refused; see sanitized receipt.' }
function Assert-Plain([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Refuse 'reparse_path' }
        }
        $parent=Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor=$parent
    }
}
function Get-HookEnvironment([string]$Text,[string]$Pool) {
    foreach ($entry in @(@{key='ACTIONS_RUNNER_HOOK_JOB_STARTED';phase='before'},@{key='ACTIONS_RUNNER_HOOK_JOB_COMPLETED';phase='after'})) {
        $old=$entry.key+'='+(Join-Path $Pool ($entry.phase+'.ps1'))
        $matchesFound=@([regex]::Matches($Text,'(?m)^'+$entry.key+'=[^\r\n]*'))
        if ($matchesFound.Count -ne 1 -or $matchesFound[0].Value -cne $old) { throw 'Unexpected existing hook entry.' }
        $match=$matchesFound[0]
        $replacement=$entry.key+'='+(Join-Path $Pool ($entry.phase+'.js'))
        $Text=$Text.Substring(0,$match.Index)+$replacement+$Text.Substring($match.Index+$match.Length)
    }
    return $Text
}
function Assert-Idle([string]$RunnerRoot) {
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'")) {
        if (-not $process.ExecutablePath) { Refuse 'unknown_job_process_owner' }
        if ($process.ExecutablePath.StartsWith($RunnerRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { Refuse 'new_worker_became_busy' }
    }
}
try {
    $principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'windows_uac_required' }
    if ([Environment]::MachineName -ne 'DESKTOP-KOOB7VV') { Refuse 'wrong_host' }
    (Get-Process -Id $PID).PriorityClass='BelowNormal'
    Assert-Plain $Report
    $pool='C:\ProgramData\KalCodeGatePool'; Assert-Plain $pool
    $expected=@{
        'gate-worker-pool.psm1'='5C1B76DD6E6F5BA190A6AFB350D8DCCA34BFD6802C2DA94F0F63B73E99A46D00'
        'gate-worker-hook.ps1'='D47CC32C84A8299D03057A31FC503C18D3CEC657F8BC91AC0970E709F9BF6F10'
    }
    foreach ($name in $expected.Keys) {
        $path=Join-Path $pool $name; Assert-Plain $path
        if ((Get-FileHash -LiteralPath $path).Hash -ne $expected[$name]) { Refuse 'protected_hook_source_changed' }
    }
    $replacementHashes=@{
        'gate-worker-job-hook.js'='BF15CF4A2C18BA1BECBC876B08DD639370EB0CD99FF69ED22082E55A62623568'
        'gate-worker-pool.psm1'='3D0304D8D130D927AF40C3BF1825EFB7EC077F6C4BCC31F86F30545072031070'
    }
    foreach ($name in $replacementHashes.Keys) {
        $path=Join-Path $PSScriptRoot $name; Assert-Plain $path
        if ((Get-FileHash -LiteralPath $path).Hash -ne $replacementHashes[$name]) { Refuse 'replacement_source_changed' }
    }
    $originalName='actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate'
    $original=Get-CimInstance Win32_Service -Filter "Name='$originalName'"
    if ($original.State -ne 'Running' -or $original.StartName -ne '.\kalcode-ci' -or $original.ProcessId -ne 10400) { Refuse 'original_service_changed' }
    $raw=& gh api repos/kalebcampbell2305/KalCode/actions/runners
    if ($LASTEXITCODE) { Refuse 'github_inventory_unavailable' }
    $inventory=($raw|Out-String)|ConvertFrom-Json
    $plans=@()
    foreach ($slot in 1..5) {
        $name="kalcode-win-gate-w$slot"
        $runner=@($inventory.runners|Where-Object {$_.name -eq $name})
        if ($runner.Count -ne 1 -or $runner[0].id -ne (26+$slot) -or $runner[0].status -ne 'online' -or $runner[0].busy -or
            'kalcode-main-pc' -notin $runner[0].labels.name -or 'kalcode-gate-pool-staging' -notin $runner[0].labels.name -or 'kalcode-gate' -in $runner[0].labels.name) { Refuse 'worker_not_idle_staging_identity' }
        $serviceName="actions.runner.kalebcampbell2305-KalCode.$name"
        $runnerRoot="C:\kalcode-ci-pool\worker-w$slot\runner"; Assert-Plain $runnerRoot
        Assert-Idle $runnerRoot
        $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
        if ($service.State -ne 'Running' -or $service.StartName -ne ".\kalcode-ci-w$slot" -or $service.PathName -ne ('"'+$runnerRoot+'\bin\RunnerService.exe"')) { Refuse 'service_identity_changed' }
        $environment=Join-Path $runnerRoot '.env'; Assert-Plain $environment
        $text=[IO.File]::ReadAllText($environment)
        if (@([regex]::Matches($text,'(?m)^KALCODE_GATE_SLOT='+$slot+'\r?$')).Count -ne 1) { Refuse 'slot_environment_changed' }
        $updated=Get-HookEnvironment $text $pool
        $account=Get-LocalUser -Name "kalcode-ci-w$slot" -ErrorAction Stop
        $member=@(Get-LocalGroupMember -SID 'S-1-5-32-558'|Where-Object {$_.SID.Value -eq $account.SID.Value}).Count -eq 1
        $plans += @{slot=$slot;name=$serviceName;root=$runnerRoot;environment=$environment;beforeHash=(Get-FileHash -LiteralPath $environment).Hash;text=$updated;account=$account;performanceReader=$member}
    }
    foreach ($phase in @('Before','After')) {
        $path=Join-Path $pool ($phase.ToLowerInvariant()+'.js'); Assert-Plain $path
        if (Test-Path -LiteralPath $path) { Refuse 'replacement_wrapper_already_exists' }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gate-worker-job-hook.js') -Destination $path
        if ((Get-FileHash -LiteralPath $path).Hash -ne $replacementHashes['gate-worker-job-hook.js']) { Refuse 'installed_wrapper_changed' }
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gate-worker-pool.psm1') -Destination (Join-Path $pool 'gate-worker-pool.psm1')
    if ((Get-FileHash -LiteralPath (Join-Path $pool 'gate-worker-pool.psm1')).Hash -ne $replacementHashes['gate-worker-pool.psm1']) { Refuse 'installed_sampler_changed' }
    foreach ($plan in $plans) {
        Assert-Idle $plan.root
        if ((Get-FileHash -LiteralPath $plan.environment).Hash -ne $plan.beforeHash) { Refuse 'environment_changed_during_repair' }
        [IO.File]::WriteAllText($plan.environment,$plan.text,[Text.Encoding]::ASCII)
        if (-not $plan.performanceReader) { Add-LocalGroupMember -SID 'S-1-5-32-558' -Member $plan.account }
        if (@(Get-LocalGroupMember -SID 'S-1-5-32-558'|Where-Object {$_.SID.Value -eq $plan.account.SID.Value}).Count -ne 1) { Refuse 'performance_read_membership_unconfirmed' }
        Restart-Service -Name $plan.name
        (Get-Service -Name $plan.name).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
        $result.workers += @{slot=$plan.slot;service=$plan.name;state='Running';beforeHash=$plan.beforeHash;afterHash=(Get-FileHash -LiteralPath $plan.environment).Hash;performanceReadGroup='S-1-5-32-558';performanceReadMembershipAdded=(-not $plan.performanceReader)}
    }
    $after=Get-CimInstance Win32_Service -Filter "Name='$originalName'"
    $result.originalPreserved=$after.State -eq $original.State -and $after.StartName -eq $original.StartName -and $after.ProcessId -eq $original.ProcessId
    if (-not $result.originalPreserved) { Refuse 'original_state_changed' }
    $result.state='REPAIRED_STAGING'
} catch {
    $result.state='FAILED'
    if (-not $result.errorCode) { $result.errorCode=$_.Exception.GetType().Name }
} finally {
    $result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $Report -Encoding UTF8
}
if ($result.state -ne 'REPAIRED_STAGING') { exit 1 }
