Set-StrictMode -Version Latest

$script:ApprovedReleaseRunnerRoot = 'C:\actions-runner-kalcode'
$script:TrustedGateServiceName = 'actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate'

function Assert-NoReparsePathComponents {
    param([Parameter(Mandatory)][string]$Path)

    $pathRoot = [System.IO.Path]::GetPathRoot($Path)
    $current = $pathRoot
    $relative = $Path.Substring($pathRoot.Length)
    foreach ($segment in @($relative.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries))) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { break }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Release-runner path contains a reparse-point component: $current"
        }
    }
}

function Assert-ApprovedReleaseRunnerRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$ApprovedRoot = $script:ApprovedReleaseRunnerRoot
    )

    foreach ($candidate in @($Root, $ApprovedRoot)) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate -notmatch '^[A-Za-z]:[\\/]') {
            throw "Release-runner root must be a fully qualified local path: $candidate"
        }
    }
    $full = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $approved = [System.IO.Path]::GetFullPath($ApprovedRoot).TrimEnd([char[]]@('\', '/'))
    $raw = $Root.TrimEnd([char[]]@('\', '/'))
    $driveRoot = [System.IO.Path]::GetPathRoot($full).TrimEnd([char[]]@('\', '/'))
    if (-not $raw.Equals($full, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release-runner root must be canonical, without relative segments: $Root"
    }
    if ($full.Equals($driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a volume root as the release-runner directory: $full"
    }
    if (-not $full.Equals($approved, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release-runner root is not the approved install directory: $full"
    }

    $broadRoots = @(
        [Environment]::GetFolderPath('UserProfile'),
        [Environment]::GetFolderPath('Windows'),
        [Environment]::GetFolderPath('ProgramFiles'),
        [Environment]::GetFolderPath('ProgramFilesX86'),
        (Join-Path ([System.IO.Path]::GetPathRoot($full)) 'Users')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($broadRoot in $broadRoots) {
        $broadFull = [System.IO.Path]::GetFullPath($broadRoot).TrimEnd([char[]]@('\', '/'))
        if ($full.Equals($broadFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing a broad system or profile root as the release-runner directory: $full"
        }
    }

    Assert-NoReparsePathComponents -Path $full
    return $full
}

function Get-CanonicalRunnerRoot {
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$ApprovedRoot = $script:ApprovedReleaseRunnerRoot
    )

    $full = Assert-ApprovedReleaseRunnerRoot -Root $Root -ApprovedRoot $ApprovedRoot

    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        throw "Release-runner root is not a directory: $full"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release-runner root must not be a reparse point: $full"
    }

    $actual = [System.IO.Path]::GetFullPath($item.FullName).TrimEnd([char[]]@('\', '/'))
    if (-not $actual.Equals($full, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release-runner path did not resolve exactly: expected $full, got $actual"
    }
    return $actual
}

function Test-PathInsideRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )

    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.Equals($Root, [System.StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ReleaseRunnerAclInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$ApprovedRoot = $script:ApprovedReleaseRunnerRoot
    )

    $canonicalRoot = Get-CanonicalRunnerRoot -Root $Root -ApprovedRoot $ApprovedRoot
    $items = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
    $stack = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
    $stack.Push([System.IO.DirectoryInfo](Get-Item -LiteralPath $canonicalRoot -Force))

    while ($stack.Count -gt 0) {
        $directory = $stack.Pop()
        if (-not (Test-PathInsideRoot -Path $directory.FullName -Root $canonicalRoot)) {
            throw "Release-runner inventory escaped its root: $($directory.FullName)"
        }
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Release-runner tree contains a reparse point: $($directory.FullName)"
        }
        $items.Add($directory)

        foreach ($child in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
            if (-not (Test-PathInsideRoot -Path $child.FullName -Root $canonicalRoot)) {
                throw "Release-runner inventory escaped its root: $($child.FullName)"
            }
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Release-runner tree contains a reparse point: $($child.FullName)"
            }
            if ($child.PSIsContainer) {
                $stack.Push([System.IO.DirectoryInfo]$child)
            } else {
                $items.Add($child)
            }
        }
    }

    return @($items)
}

function Assert-ReleaseRunnerStopped {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$ApprovedRoot = $script:ApprovedReleaseRunnerRoot,
        [object[]]$ProcessSnapshot,
        [object[]]$ProcessTreeSnapshot,
        [object[]]$ServiceSnapshot
    )

    $canonicalRoot = Get-CanonicalRunnerRoot -Root $Root -ApprovedRoot $ApprovedRoot
    $injected = $PSBoundParameters.ContainsKey('ProcessSnapshot') -or
        $PSBoundParameters.ContainsKey('ProcessTreeSnapshot') -or
        $PSBoundParameters.ContainsKey('ServiceSnapshot')
    if ($injected -and (-not $PSBoundParameters.ContainsKey('ProcessSnapshot') -or
        -not $PSBoundParameters.ContainsKey('ProcessTreeSnapshot') -or
        -not $PSBoundParameters.ContainsKey('ServiceSnapshot'))) {
        throw 'Process safety snapshots must be supplied together.'
    }
    if ($injected) {
        $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
        if (-not (Test-PathInsideRoot -Path $canonicalRoot -Root $tempRoot) -or
            -not ([System.IO.Path]::GetFileName($canonicalRoot).StartsWith('kalcode-release-runner-acl-', [System.StringComparison]::OrdinalIgnoreCase))) {
            throw 'Injected process snapshots are allowed only for the disposable ACL regression root.'
        }
    }

    if (-not $injected) {
        $ProcessSnapshot = @()
        foreach ($processName in @('Runner.Listener', 'Runner.Worker')) {
            foreach ($process in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
                $processPath = $null
                try { $processPath = $process.Path } catch { }
                $ProcessSnapshot += [pscustomobject]@{ Name = $process.ProcessName; Id = $process.Id; Path = $processPath }
            }
        }
        $ProcessTreeSnapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object { $_.Name -in @('Runner.Listener.exe', 'Runner.Worker.exe') } |
            Select-Object Name, ProcessId, ParentProcessId)
        $ServiceSnapshot = @(Get-CimInstance Win32_Service -ErrorAction Stop |
            Where-Object { $_.Name -eq $script:TrustedGateServiceName } |
            Select-Object Name, State, ProcessId)
    }

    $trustedPids = @($ServiceSnapshot | Where-Object {
        $_.Name -eq $script:TrustedGateServiceName -and $_.State -eq 'Running' -and [int]$_.ProcessId -gt 0
    } | ForEach-Object { [int]$_.ProcessId })
    $parents = @{}
    foreach ($entry in @($ProcessTreeSnapshot)) { $parents[[int]$entry.ProcessId] = [int]$entry.ParentProcessId }

    foreach ($process in @($ProcessSnapshot)) {
        if ([string]$process.Name -like 'Runner.Worker*') {
            throw "Wait for every Actions runner job to become idle before changing release-runner ACLs (worker process $($process.Id))."
        }
        $processPath = $process.Path
        if ($processPath) {
            $processPath = $null
            try { $processPath = [System.IO.Path]::GetFullPath([string]$process.Path) } catch { }
        }
        if ($processPath -and (Test-PathInsideRoot -Path $processPath -Root $canonicalRoot)) {
            throw "Stop the release runner before changing its ACLs (process $($process.Id))."
        }
        if ($processPath) { continue }

        $parentPid = if ($parents.ContainsKey([int]$process.Id)) { [int]$parents[[int]$process.Id] } else { 0 }
        if ($parentPid -notin $trustedPids) {
            throw "Cannot prove that listener process $($process.Id) belongs directly to the isolated idle gate service; refusing ACL changes."
        }
    }
}

function Get-AllowedReleaseRunnerSids {
    param([Parameter(Mandatory)][System.Security.Principal.SecurityIdentifier]$OwnerSid)

    return @(
        $OwnerSid,
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )
}

function New-OwnerOnlySecurityDescriptor {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Security.Principal.SecurityIdentifier]$OwnerSid,
        [Parameter(Mandatory)][bool]$IsDirectory
    )

    # Start from Get-Acl rather than a blank descriptor. Set-Acl otherwise tries to
    # write an empty SACL as well and requires SeSecurityPrivilege, which an owner
    # session intentionally does not have.
    $security = Get-Acl -LiteralPath $Path
    if ($IsDirectory) {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($security.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
        $security.RemoveAccessRuleSpecific($existingRule)
    }
    if ($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $OwnerSid.Value) {
        $security.SetOwner($OwnerSid)
    }

    foreach ($sid in @(Get-AllowedReleaseRunnerSids -OwnerSid $OwnerSid)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($rule)
    }
    return $security
}

function Set-ItemOwnerOnlySecurityDescriptor {
    param(
        [Parameter(Mandatory)][System.IO.FileSystemInfo]$Item,
        [Parameter(Mandatory)][System.Security.Principal.SecurityIdentifier]$OwnerSid
    )

    $descriptor = New-OwnerOnlySecurityDescriptor -Path $Item.FullName -OwnerSid $OwnerSid -IsDirectory $Item.PSIsContainer
    # The strongly typed methods persist the DACL/owner sections represented by
    # the descriptor without asking for SeSecurityPrivilege to write a SACL.
    if ($Item.PSIsContainer) {
        ([System.IO.DirectoryInfo]$Item).SetAccessControl($descriptor)
    } else {
        ([System.IO.FileInfo]$Item).SetAccessControl($descriptor)
    }
}

function Set-ReleaseRunnerOwnerOnlyAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$ApprovedRoot = $script:ApprovedReleaseRunnerRoot,
        [System.Security.Principal.SecurityIdentifier]$OwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
        [Parameter(DontShow)][object[]]$ProcessSnapshot,
        [Parameter(DontShow)][object[]]$ProcessTreeSnapshot,
        [Parameter(DontShow)][object[]]$ServiceSnapshot
    )

    $stopArgs = @{ Root = $Root; ApprovedRoot = $ApprovedRoot }
    foreach ($name in @('ProcessSnapshot', 'ProcessTreeSnapshot', 'ServiceSnapshot')) {
        if ($PSBoundParameters.ContainsKey($name)) { $stopArgs[$name] = $PSBoundParameters[$name] }
    }
    Assert-ReleaseRunnerStopped @stopArgs
    $items = @(Get-ReleaseRunnerAclInventory -Root $Root -ApprovedRoot $ApprovedRoot)
    $canonicalRoot = Get-CanonicalRunnerRoot -Root $Root -ApprovedRoot $ApprovedRoot
    $rootItem = $items | Where-Object { $_.FullName -eq $canonicalRoot } | Select-Object -First 1
    if (-not $rootItem) { throw 'Release-runner root was absent from its ACL inventory.' }

    # Secure the root first so new children inherit the restricted descriptor, then
    # replace every existing child ACL explicitly. The second inventory detects a
    # reparse point or object created while the update was in progress.
    Assert-ReleaseRunnerStopped @stopArgs
    $rootItem = [System.IO.DirectoryInfo](Get-Item -LiteralPath $canonicalRoot -Force -ErrorAction Stop)
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Release-runner root became a reparse point before its ACL update.'
    }
    Set-ItemOwnerOnlySecurityDescriptor -Item $rootItem -OwnerSid $OwnerSid
    $items = @(Get-ReleaseRunnerAclInventory -Root $Root -ApprovedRoot $ApprovedRoot)
    $rootItem = $items | Where-Object { $_.FullName -eq $canonicalRoot } | Select-Object -First 1
    if (-not $rootItem) { throw 'Release-runner root disappeared during its ACL update.' }
    foreach ($item in @($items | Where-Object { $_.FullName -ne $rootItem.FullName } | Sort-Object { $_.FullName.Length })) {
        Set-ItemOwnerOnlySecurityDescriptor -Item $item -OwnerSid $OwnerSid
    }

    Assert-ReleaseRunnerOwnerOnlyAcl -Root $Root -ApprovedRoot $ApprovedRoot -OwnerSid $OwnerSid | Out-Null
}

function Assert-ReleaseRunnerOwnerOnlyAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$ApprovedRoot = $script:ApprovedReleaseRunnerRoot,
        [System.Security.Principal.SecurityIdentifier]$OwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    )

    $allowed = @{}
    foreach ($sid in @(Get-AllowedReleaseRunnerSids -OwnerSid $OwnerSid)) { $allowed[$sid.Value] = $true }
    $items = @(Get-ReleaseRunnerAclInventory -Root $Root -ApprovedRoot $ApprovedRoot)

    foreach ($item in $items) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $actualOwner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
        if ($actualOwner.Value -ne $OwnerSid.Value) {
            throw "Unexpected owner on release-runner item: $($item.FullName)"
        }
        if (-not $acl.AreAccessRulesProtected) {
            throw "ACL inheritance remains enabled on release-runner item: $($item.FullName)"
        }

        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne $allowed.Count) {
            throw "Unexpected ACL rule count on release-runner item: $($item.FullName)"
        }
        $seen = @{}
        foreach ($rule in $rules) {
            if (-not $allowed.ContainsKey($rule.IdentityReference.Value) -or
                $seen.ContainsKey($rule.IdentityReference.Value) -or
                $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                $rule.IsInherited -or
                $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
                throw "Unexpected ACL rule on release-runner item: $($item.FullName)"
            }
            $seen[$rule.IdentityReference.Value] = $true
            $expectedInheritance = if ($item.PSIsContainer) {
                [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
            } else {
                [System.Security.AccessControl.InheritanceFlags]::None
            }
            if ($rule.InheritanceFlags -ne $expectedInheritance -or
                $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
                throw "Unexpected ACL inheritance flags on release-runner item: $($item.FullName)"
            }
        }
    }

    return [pscustomobject]@{
        Root = Get-CanonicalRunnerRoot -Root $Root -ApprovedRoot $ApprovedRoot
        ItemCount = $items.Count
        OwnerSid = $OwnerSid.Value
        Protected = $true
    }
}

Export-ModuleMember -Function @(
    'Assert-ApprovedReleaseRunnerRoot',
    'Get-ReleaseRunnerAclInventory',
    'Assert-ReleaseRunnerStopped',
    'Set-ReleaseRunnerOwnerOnlyAcl',
    'Assert-ReleaseRunnerOwnerOnlyAcl'
)
