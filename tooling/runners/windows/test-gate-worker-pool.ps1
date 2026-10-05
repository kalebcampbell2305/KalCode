$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'gate-worker-pool.psm1') -Force
function Assert-Equal($actual,$expected,$label) {
    if ($actual -ne $expected) { throw "$label expected=$expected actual=$actual" }
}
$plans = @(1..5 | ForEach-Object { Get-GateWorkerPlan -Slot $_ })
Assert-Equal $plans.Count 5 'Add exactly five workers to existing slot0'
$ports = @(4491,4492,9501,1591,19333)
foreach ($plan in $plans) {
    Assert-Equal $plan.Name "kalcode-win-gate-w$($plan.Slot)" 'Unique main-PC identity'
    Assert-Equal $plan.Labels 'kalcode-gate,kalcode-main-pc' 'Main-only labels'
    Assert-Equal $plan.RegistrationLabels 'kalcode-gate-pool-staging,kalcode-main-pc' 'Old queued gates cannot start before activation'
    $ports += @($plan.E2ePort,$plan.MailPort,$plan.InspectorPort,$plan.UiPort,$plan.CdpPort)
}
Assert-Equal (@($ports | Select-Object -Unique).Count) 30 'All six workers have disjoint ports'
Assert-Equal (@($plans.Account | Select-Object -Unique).Count) 5 'New workers have separate OS accounts'
$browserPorts = @(0..5 | ForEach-Object { $base=(Get-GateWorkerPlan -Slot $_).CdpPort; 100..180 | ForEach-Object { $base + $_ } })
Assert-Equal (@($browserPorts | Select-Object -Unique).Count) 486 'Native Browser child port ranges cannot collide between slots'
Assert-Equal (@($plans.Root | Select-Object -Unique).Count) 5 'Separate worker checkouts and caches'
$healthy = @{Cpu=10.0;FreeGiB=32.0;CommitPercent=40.0;DiskQueue=0.0}
foreach ($active in 0..5) { Assert-Equal (Test-GateWorkerAdmission $healthy $active) 'allowed' 'Six workers fit healthy host' }
Assert-Equal (Test-GateWorkerAdmission $healthy 6) 'worker_slots_busy' 'Additional jobs queue without cancelling others'
Assert-Equal (Get-GateWorkerPlan 0).Account 'kalcode-ci' 'Original worker identity is preserved'
Assert-Equal (Test-GateWorkerAdmission $null) 'resource_data_unavailable' 'Unknown readings never fabricate capacity'
foreach ($case in @(
    @{key='Cpu';value=85;reason='cpu_pressure'},
    @{key='FreeGiB';value=15;reason='memory_pressure'},
    @{key='CommitPercent';value=85;reason='memory_pressure'},
    @{key='DiskQueue';value=8;reason='disk_pressure'},
    @{key='Cpu';value=-1;reason='resource_data_invalid'},
    @{key='FreeGiB';value=[double]::NaN;reason='resource_data_invalid'},
    @{key='CommitPercent';value=[double]::PositiveInfinity;reason='resource_data_invalid'}
)) {
    $sample=$healthy.Clone();$sample[$case.key]=$case.value
    Assert-Equal (Test-GateWorkerAdmission $sample) $case.reason "Pressure:$($case.key)"
}
$reserved=$healthy.Clone();$reserved.FreeGiB=19
Assert-Equal (Test-GateWorkerAdmission $reserved 2) 'memory_pressure' 'Reserve headroom for newly admitted jobs and user agents'
foreach ($file in @('gate-worker-pool.psm1','gate-worker-hook.ps1','setup-gate-worker-pool.ps1','invoke-gate-worker-pool-install.ps1','diagnose-gate-worker-pool.ps1','add-gate-workers.ps1')) {
    $tokens=$null;$parseErrors=$null
    $fileAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
    $reservedWrites=$fileAst.FindAll({param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
        $node.Left.VariablePath.UserPath -imatch '^(HOME|HOST|PID|CODEX_HOME)$'
    },$true)
    if ($reservedWrites.Count) { throw "Reserved process variable assignment in $file : $($reservedWrites.Extent.Text -join ', ')" }
}
$wrapperAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'invoke-gate-worker-pool-install.ps1'),[ref]$tokens,[ref]$parseErrors)
foreach ($name in @('Assert-OrdinaryToolPath','Read-ApprovedCargoTools')) {
    $definition=$wrapperAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)
    Invoke-Expression $definition.Extent.Text
}
$temporaryRoot=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('KalCode-approved-tools-' + [Guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
    $manifestPath=Join-Path $temporaryRoot 'tools.json'
    $entries=@()
    foreach ($tool in @(@{name='cargo-deny.exe';version='cargo-deny 0.20.2'},@{name='cargo-audit.exe';version='cargo-audit 0.22.2'})) {
        $path=Join-Path $temporaryRoot $tool.name
        # Data-only fixtures exercise manifest/hash/path validation; never execute these files.
        [IO.File]::WriteAllText($path,'manifest validation fixture: ' + $tool.name)
        $entries += @{name=$tool.name;version=$tool.version;path=$path;sha256=(Get-FileHash -LiteralPath $path).Hash}
    }
    $base=@{schema='kalcode-gate-cargo-tools/v1';tools=$entries} | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($manifestPath,$base)
    Assert-Equal (@(Read-ApprovedCargoTools $manifestPath (Get-FileHash -LiteralPath $manifestPath).Hash).Count) 2 'Exactly two pinned tools accepted'
    foreach ($case in @('duplicate','version','bytes','relative','third-tool','wrong-manifest-hash','wrong-name-case')) {
        $data=$base | ConvertFrom-Json
        switch ($case) {
            duplicate { $data.tools[1]=$data.tools[0] }
            version { $data.tools[0].version='cargo-deny 0.0.0' }
            bytes { $data.tools[0].sha256='0' * 64 }
            relative { $data.tools[0].path='cargo-deny.exe' }
            third-tool { $data.tools += $data.tools[0] }
            wrong-name-case { $data.tools[0].name='CARGO-DENY.EXE' }
        }
        [IO.File]::WriteAllText($manifestPath,($data | ConvertTo-Json -Depth 4))
        $hash=(Get-FileHash -LiteralPath $manifestPath).Hash
        if ($case -eq 'wrong-manifest-hash') { $hash='0' * 64 }
        $rejected=$false
        try { Read-ApprovedCargoTools $manifestPath $hash | Out-Null } catch { $rejected=$true }
        Assert-Equal $rejected $true "Untrusted tool manifest rejected: $case"
    }
} finally {
    # Only this function's freshly created data-only fixture directory is removed.
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($temporaryRoot) -ne $parent -or [IO.Path]::GetFileName($temporaryRoot) -notmatch '^KalCode-approved-tools-[a-f0-9]{32}$') { throw 'Unexpected fixture cleanup path.' }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
}
Write-Host 'PASS: worker plans, 30 isolated base ports, pressure admission, approved tool manifests, and PowerShell syntax.'
