$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'release-runner-acl.psm1') -Force

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
$testRoot = Join-Path $tempBase "kalcode-release-runner-acl-$PID-$([guid]::NewGuid().ToString('N'))"
$outside = Join-Path $tempBase "kalcode-release-runner-outside-$PID-$([guid]::NewGuid().ToString('N'))"

function Assert-SafeTestPath {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($tempBase + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($full).StartsWith('kalcode-release-runner-', [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing unsafe test cleanup path: $full"
    }
    return $full
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    New-Item -ItemType Directory -Path $outside | Out-Null

    foreach ($unsafeCase in @('.', 'C:')) {
        $rejected = $false
        try { Assert-ApprovedReleaseRunnerRoot -Root $unsafeCase -ApprovedRoot $testRoot | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw "Unsafe path was accepted: $unsafeCase" }
    }
    foreach ($broadRoot in @([System.IO.Path]::GetPathRoot($testRoot), [Environment]::GetFolderPath('UserProfile'))) {
        $rejected = $false
        try { Assert-ApprovedReleaseRunnerRoot -Root $broadRoot -ApprovedRoot $broadRoot | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw "Broad root was accepted: $broadRoot" }
    }
    $arbitraryBefore = (Get-Acl -LiteralPath $outside).Sddl
    $rejected = $false
    try { Get-ReleaseRunnerAclInventory -Root $outside -ApprovedRoot $testRoot | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or (Get-Acl -LiteralPath $outside).Sddl -ne $arbitraryBefore) {
        throw 'An arbitrary non-approved directory was accepted or changed.'
    }
    $snapshotBypassRejected = $false
    try {
        Assert-ReleaseRunnerStopped -Root $outside -ApprovedRoot $outside -ProcessSnapshot @() -ProcessTreeSnapshot @() -ServiceSnapshot @()
    } catch { $snapshotBypassRejected = $_.Exception.Message -like '*disposable ACL regression root*' }
    if (-not $snapshotBypassRejected) { throw 'Injected process snapshots were accepted outside the disposable test root.' }

    $realParent = New-Item -ItemType Directory -Path (Join-Path $outside 'real-parent')
    $realRunner = New-Item -ItemType Directory -Path (Join-Path $realParent.FullName 'runner')
    [System.IO.File]::WriteAllText((Join-Path $realRunner.FullName 'sentinel.txt'), 'ancestor target sentinel')
    $ancestorJunction = Join-Path $testRoot 'ancestor-junction'
    New-Item -ItemType Junction -Path $ancestorJunction -Target $realParent.FullName | Out-Null
    $viaAncestor = Join-Path $ancestorJunction 'runner'
    $ancestorRejected = $false
    try { Get-ReleaseRunnerAclInventory -Root $viaAncestor -ApprovedRoot $viaAncestor | Out-Null } catch { $ancestorRejected = $_.Exception.Message -like '*reparse-point component*' }
    if (-not $ancestorRejected) { throw 'Release-runner inventory did not reject a junction ancestor.' }
    if ([System.IO.File]::ReadAllText((Join-Path $realRunner.FullName 'sentinel.txt')) -ne 'ancestor target sentinel') {
        throw 'Ancestor-junction rejection changed the outside target.'
    }
    [System.IO.Directory]::Delete($ancestorJunction)

    $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $weakAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $weakAcl.SetOwner($ownerSid)
    $weakAcl.SetAccessRuleProtection($true, $false)
    [void]$weakAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $ownerSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    ))
    [void]$weakAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-11'),
        [System.Security.AccessControl.FileSystemRights]::Modify,
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    ))
    Set-Acl -LiteralPath $testRoot -AclObject $weakAcl

    $nested = New-Item -ItemType Directory -Path (Join-Path $testRoot 'bin\nested') -Force
    $credential = Join-Path $testRoot '.credentials'
    $guard = Join-Path $testRoot 'release-job-guard.ps1'
    $nestedFile = Join-Path $nested.FullName 'runner.bin'
    [System.IO.File]::WriteAllText($credential, 'fake credential sentinel')
    [System.IO.File]::WriteAllText($guard, 'fake guard sentinel')
    [System.IO.File]::WriteAllText($nestedFile, 'fake binary sentinel')
    $before = @{
        Credential = [System.IO.File]::ReadAllText($credential)
        Guard = [System.IO.File]::ReadAllText($guard)
        Nested = [System.IO.File]::ReadAllText($nestedFile)
    }

    Assert-ApprovedReleaseRunnerRoot -Root $testRoot -ApprovedRoot $testRoot | Out-Null
    Set-ReleaseRunnerOwnerOnlyAcl -Root $testRoot -ApprovedRoot $testRoot -ProcessSnapshot @() -ProcessTreeSnapshot @() -ServiceSnapshot @()
    $status = Assert-ReleaseRunnerOwnerOnlyAcl -Root $testRoot -ApprovedRoot $testRoot
    if ($status.ItemCount -ne 6) { throw "Unexpected verified item count: $($status.ItemCount)" }
    if ([System.IO.File]::ReadAllText($credential) -ne $before.Credential -or
        [System.IO.File]::ReadAllText($guard) -ne $before.Guard -or
        [System.IO.File]::ReadAllText($nestedFile) -ne $before.Nested) {
        throw 'ACL repair changed file contents.'
    }

    $outsideSentinel = Join-Path $outside 'sentinel.txt'
    [System.IO.File]::WriteAllText($outsideSentinel, 'outside sentinel')
    $junction = Join-Path $testRoot 'escape-junction'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    $reparseRejected = $false
    try { Get-ReleaseRunnerAclInventory -Root $testRoot -ApprovedRoot $testRoot | Out-Null } catch { $reparseRejected = $_.Exception.Message -like '*reparse point*' }
    if (-not $reparseRejected) { throw 'Release-runner inventory did not reject a junction.' }
    if ([System.IO.File]::ReadAllText($outsideSentinel) -ne 'outside sentinel') { throw 'Junction rejection changed the outside target.' }
    [System.IO.Directory]::Delete($junction)

    $trustedService = [pscustomobject]@{ Name = 'actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate'; State = 'Running'; ProcessId = 900 }
    $gateListener = [pscustomobject]@{ Name = 'Runner.Listener'; Id = 901; Path = $null }
    $gateTree = @([pscustomobject]@{ ProcessId = 901; ParentProcessId = 900 })
    Assert-ReleaseRunnerStopped -Root $testRoot -ApprovedRoot $testRoot -ProcessSnapshot @($gateListener) -ProcessTreeSnapshot $gateTree -ServiceSnapshot @($trustedService)

    $orphanRejected = $false
    try {
        Assert-ReleaseRunnerStopped -Root $testRoot -ApprovedRoot $testRoot -ProcessSnapshot @($gateListener) -ProcessTreeSnapshot @() -ServiceSnapshot @($trustedService)
    } catch { $orphanRejected = $_.Exception.Message -like '*Cannot prove*' }
    if (-not $orphanRejected) { throw 'A runner process with an unavailable path failed open.' }

    $gateWorker = [pscustomobject]@{ Name = 'Runner.Worker'; Id = 903; Path = $null }
    $workerTree = @([pscustomobject]@{ ProcessId = 903; ParentProcessId = 901 }, [pscustomobject]@{ ProcessId = 901; ParentProcessId = 900 })
    $activeWorkerRejected = $false
    try {
        Assert-ReleaseRunnerStopped -Root $testRoot -ApprovedRoot $testRoot -ProcessSnapshot @($gateWorker) -ProcessTreeSnapshot $workerTree -ServiceSnapshot @($trustedService)
    } catch { $activeWorkerRejected = $_.Exception.Message -like '*Actions runner job*' }
    if (-not $activeWorkerRejected) { throw 'An active trusted-lineage gate worker was accepted.' }

    $releaseProcess = [pscustomobject]@{ Name = 'Runner.Listener'; Id = 902; Path = (Join-Path $testRoot 'bin\Runner.Listener.exe') }
    $activeReleaseRejected = $false
    try {
        Assert-ReleaseRunnerStopped -Root $testRoot -ApprovedRoot $testRoot -ProcessSnapshot @($releaseProcess) -ProcessTreeSnapshot @() -ServiceSnapshot @($trustedService)
    } catch { $activeReleaseRejected = $_.Exception.Message -like '*Stop the release runner*' }
    if (-not $activeReleaseRejected) { throw 'An active release-runner process was accepted.' }

    Write-Host "PASS release-runner ACL: $($status.ItemCount) items protected; unsafe roots and junction traversal rejected; ambiguous processes fail closed; contents preserved."
} finally {
    foreach ($path in @($testRoot, $outside)) {
        $safe = Assert-SafeTestPath -Path $path
        if (Test-Path -LiteralPath $safe) {
            $item = Get-Item -LiteralPath $safe -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing recursive cleanup of reparse point: $safe"
            }
            Remove-Item -LiteralPath $safe -Recurse -Force
        }
    }
}
