# Read-only elevated inspection after a failed reviewed installer. No setup, ACL, account,
# service, tool execution, or retry occurs. Public output is an allowlisted summary only.
param(
    [Parameter(Mandatory=$true)][string]$InstallReceipt,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$InstallReceiptSha256,
    [Parameter(Mandatory=$true)][string]$SourceManifest,
    [Parameter(Mandatory=$true)][string]$Report,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
function Get-SafeLogFacts([string]$Text) {
    $codes = @()
    $patterns = [ordered]@{
        rustup_hash='rustup archive hash mismatch'
        runner_hash='Runner archive hash mismatch'
        tool_failed='Setup tool failed:'
        tool_missing='Setup tool is missing:'
        native_stderr='NativeCommandError'
        missing_method='does not contain a method named'
        access_denied='Access (is )?denied|UnauthorizedAccess'
        network_failure='could not resolve|remote name could not be resolved|timed out|Unable to connect|connection.*(failed|reset)|HTTP[^\r\n]*[45][0-9][0-9]'
        rustup_existing='Rust is already installed|existing Rust installation'
        disk_space='not enough space|disk full|40 GiB free'
        linker_missing='linker.*not found|link.exe.*not found'
        toolchain_missing='no default is configured|toolchain.*not installed'
        cargo_compile='could not compile|failed to compile'
        acl_failure='ACL failed|Cannot secure'
        partial_refusal='partial pool directory|partial worker container|pre-existing worker'
        token_request='Cannot obtain the short-lived runner registration token'
        service_logon='logon failure|logon as a service|log on as a service|error\s*1069'
        listener_start='Runner\.Listener|RunnerService|runner service'
        incorrect_function='Incorrect function'
    }
    foreach ($entry in $patterns.GetEnumerator()) { if ($Text -match $entry.Value) { $codes += $entry.Key } }
    $sourceLines = @([regex]::Matches($Text,'setup-gate-worker-pool\.ps1:(\d+)') | ForEach-Object { [int]$_.Groups[1].Value } | Select-Object -Unique)
    $toolFailures = @([regex]::Matches($Text,'Setup tool failed: (rustup-init\.exe|npm\.cmd|cargo\.exe|config\.cmd) \(exit (-?\d+)\)') | ForEach-Object {
        @{tool=$_.Groups[1].Value;exitCode=[int]$_.Groups[2].Value}
    })
    $method = $null
    if ($Text -match "does not contain a method named '(Trim|Split|WaitForExit|Refresh)'" ) { $method=$Matches[1] }
    $exceptions=@([regex]::Matches($Text,'\b(?:System\.)?(?:UnauthorizedAccessException|IOException|Win32Exception|DirectoryNotFoundException|FileNotFoundException|TypeInitializationException)\b') | ForEach-Object {$_.Value} | Select-Object -Unique)
    $errorNumbers=@([regex]::Matches($Text,'\b0x[0-9a-fA-F]{8}\b') | ForEach-Object {$_.Value} | Select-Object -Unique)
    $poolPaths=@([regex]::Matches($Text,'C:\\(?:kalcode-ci-pool|ProgramData\\KalCodeGatePool)(?:\\[A-Za-z0-9_. -]+)*') | ForEach-Object {$_.Value.TrimEnd(' ','.')} | Select-Object -Unique)
    return @{codes=$codes;sourceLines=$sourceLines;toolFailures=$toolFailures;missingKnownMethod=$method;exceptions=$exceptions;errorNumbers=$errorNumbers;poolPaths=$poolPaths;rawOutputIncluded=$false}
}
function Assert-Plain([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse_path' }
        }
        $parent=Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor=$parent
    }
}
function Assert-DiagnosticSourceInventory($Sources) {
    $required=@('setup-gate-worker-pool.ps1','gate-worker-pool.psm1','gate-worker-hook.ps1','test-gate-worker-pool.ps1')
    $allowed=$required+@('gate-worker-job-hook.js')
    if ($Sources.Count -notin @(4,5)) { throw 'source_inventory_invalid' }
    $seen=@{}
    foreach ($source in $Sources) {
        $name=[IO.Path]::GetFileName($source.Path)
        if ($name -cnotin $allowed -or $seen.ContainsKey($name) -or $source.Hash -notmatch '^[a-fA-F0-9]{64}$') { throw 'source_inventory_invalid' }
        $seen[$name]=$true
    }
    foreach ($name in $required) { if (-not $seen.ContainsKey($name)) { throw 'source_inventory_invalid' } }
}
$reportDirectory=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Report))
if ($reportDirectory -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($InstallReceipt)) -or [IO.Path]::GetExtension($Report) -ne '.json') { throw 'Report must be a new JSON beside the installation receipt.' }
Assert-Plain $Report
if (Test-Path -LiteralPath $Report) { throw 'Preserve previous diagnostic reports.' }
$result=[ordered]@{schema='kalcode-gate-worker-diagnostic/v1';state='PREFLIGHT';phase='authority';host=[Environment]::MachineName;at=[DateTime]::UtcNow.ToString('o');errorCode=$null;readOnly=$true;validateOnly=[bool]$ValidateOnly;logs=@();paths=@();sources=@();accounts=@();services=@();slotAccounts=@();slotServices=@();runnerLogs=@();serviceEvents=@();workerAcl=@();workerGroups=@()}
try {
    $principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $ValidateOnly -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'windows_uac_required' }
    if ([Environment]::MachineName -ne 'DESKTOP-KOOB7VV') { throw 'wrong_host' }
    $result.phase='provenance'
    Assert-Plain $InstallReceipt; Assert-Plain $SourceManifest
    if ((Get-FileHash -LiteralPath $InstallReceipt -Algorithm SHA256).Hash -ne $InstallReceiptSha256) { throw 'receipt_hash_changed' }
    $receipt=Get-Content -LiteralPath $InstallReceipt -Raw | ConvertFrom-Json
    if ($receipt.schema -ne 'kalcode-gate-worker-install/v1' -or $receipt.state -ne 'FAILED' -or $receipt.phase -ne 'installer') { throw 'not_failed_installer_receipt' }
    if ((Get-FileHash -LiteralPath $SourceManifest -Algorithm SHA256).Hash -ne $receipt.sourceManifestSha256) { throw 'manifest_hash_changed' }
    $stage=[IO.Path]::GetFullPath($receipt.protectedLogDirectory)
    if ($stage -notmatch '^C:\\ProgramData\\KalCodeGatePoolSetup-[a-f0-9]{32}$') { throw 'unexpected_log_directory' }
    if (-not $ValidateOnly) {
        Assert-Plain $stage
        $result.phase='logs'
        foreach ($name in @('stderr.log','stdout.log','wrapper-error.log')) {
            $path=Join-Path $stage $name
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                Assert-Plain $path
                $item=Get-Item -LiteralPath $path
                if ($item.Length -gt 16MB) { throw 'log_size_requires_review' }
                $result.logs += @{name=$name;length=$item.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash;facts=(Get-SafeLogFacts (Get-Content -LiteralPath $path -Raw))}
            }
        }
        $result.phase='sources'
        $sources=Get-Content -LiteralPath $SourceManifest -Raw | ConvertFrom-Json
        Assert-DiagnosticSourceInventory $sources
        foreach ($source in $sources) {
            $name=[IO.Path]::GetFileName($source.Path)
            $path=Join-Path $stage $name; Assert-Plain $path
            $result.sources += @{name=$name;stagedMatches=((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $source.Hash)}
        }
        $result.phase='inventory'
        foreach ($path in @($stage,'C:\ProgramData\KalCodeGatePool','C:\kalcode-ci-pool','C:\ProgramData\KalCodeGatePool\tools','C:\ProgramData\KalCodeGatePool\tools\rustup','C:\ProgramData\KalCodeGatePool\tools\cargo','C:\ProgramData\KalCodeGatePool\tools\npm','C:\ProgramData\KalCodeGatePool\installed.json','C:\ProgramData\KalCodeGatePool\tools\rustup-init.exe','C:\ProgramData\KalCodeGatePool\tools\cargo\bin\cargo.exe','C:\ProgramData\KalCodeGatePool\tools\cargo\bin\cargo-deny.exe','C:\ProgramData\KalCodeGatePool\tools\cargo\bin\cargo-audit.exe','C:\ProgramData\KalCodeGatePool\tools\npm\pnpm.cmd','C:\ProgramData\KalCodeGatePool\tools\actions-runner-win-x64-2.337.0.zip')) {
            # Inspect inventory leaves without dereferencing them. Rustup may legitimately
            # install cargo.exe as a link; reporting it must not abort the remaining audit.
            Assert-Plain (Split-Path -Parent $path)
            $entry=@{path=$path;exists=(Test-Path -LiteralPath $path)}
            if ($entry.exists) {
                $item=Get-Item -LiteralPath $path -Force
                $entry.directory=[bool]$item.PSIsContainer
                $entry.reparsePoint=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
                if ($entry.reparsePoint) { $entry.linkType=[string]$item.LinkType; $entry.followed=$false }
                else {
                    $entry.sddl=(Get-Acl -LiteralPath $path).Sddl
                    if (-not $item.PSIsContainer) { $entry.length=$item.Length; $entry.sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
                }
            }
            $result.paths += $entry
        }
        foreach ($worker in 2..4) {
            $account=Get-LocalUser -Name "kalcode-ci-$worker" -ErrorAction SilentlyContinue
            $result.accounts += @{worker=$worker;exists=($null -ne $account);sid=$(if ($account) {$account.SID.Value} else {$null})}
            $name="actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate-worker-$worker"
            $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
            $result.services += @{worker=$worker;exists=($null -ne $service);state=$service.State;account=$service.StartName}
        }
        foreach ($slot in 1..5) {
            $account=Get-LocalUser -Name "kalcode-ci-w$slot" -ErrorAction SilentlyContinue
            $result.slotAccounts += @{slot=$slot;exists=($null -ne $account);sid=$(if ($account) {$account.SID.Value} else {$null})}
            $name="actions.runner.kalebcampbell2305-KalCode.kalcode-win-gate-w$slot"
            $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
            $result.slotServices += @{slot=$slot;exists=($null -ne $service);state=$service.State;account=$service.StartName;exitCode=$service.ExitCode;serviceSpecificExitCode=$service.ServiceSpecificExitCode;startMode=$service.StartMode}
        }
        $result.phase='worker-startup'
        $workerRoot='C:\kalcode-ci-pool\worker-w1'
        $runnerRoot=Join-Path $workerRoot 'runner'
        foreach ($path in @('C:\kalcode-ci-pool',$workerRoot,$runnerRoot,(Join-Path $runnerRoot 'bin'))) {
            Assert-Plain $path
            if (Test-Path -LiteralPath $path) { $result.workerAcl += @{path=$path;sddl=(Get-Acl -LiteralPath $path).Sddl} }
        }
        $workerAccount=Get-LocalUser -Name 'kalcode-ci-w1' -ErrorAction SilentlyContinue
        if ($workerAccount) {
            foreach ($groupSid in @('S-1-5-32-544','S-1-5-32-545','S-1-5-32-558')) {
                $members=@(Get-LocalGroupMember -SID $groupSid -ErrorAction Stop)
                $result.workerGroups += @{groupSid=$groupSid;member=@($members | Where-Object {$_.SID.Value -eq $workerAccount.SID.Value}).Count -gt 0}
            }
        }
        $diagnostics=Join-Path $runnerRoot '_diag'
        Assert-Plain $diagnostics
        if (Test-Path -LiteralPath $diagnostics -PathType Container) {
            foreach ($file in @(Get-ChildItem -LiteralPath $diagnostics -File | Where-Object {$_.Name -match '^Runner_[0-9-]+\.log$' -and $_.LastWriteTimeUtc -ge [DateTime]::Parse($receipt.started).ToUniversalTime()} | Sort-Object LastWriteTimeUtc | Select-Object -Last 4)) {
                Assert-Plain $file.FullName
                if ($file.Length -gt 16MB) { throw 'log_size_requires_review' }
                $result.runnerLogs += @{name=$file.Name;length=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash;facts=(Get-SafeLogFacts (Get-Content -LiteralPath $file.FullName -Raw))}
            }
        }
        $since=[DateTime]::Parse($receipt.started).ToUniversalTime()
        foreach ($log in @('Application','System')) {
            $events=@(Get-WinEvent -FilterHashtable @{LogName=$log;StartTime=$since} -MaxEvents 200 -ErrorAction SilentlyContinue)
            foreach ($event in $events) {
                $allowed=($log -eq 'Application' -and (($event.ProviderName -eq 'ActionsRunnerService' -and $event.Id -in @(0,100)) -or $event.Id -in @(1000,1026))) -or ($log -eq 'System' -and $event.ProviderName -eq 'Service Control Manager' -and $event.Id -in @(7000,7001,7009,7011,7023,7031,7034,7045))
                if (-not $allowed -or $event.Message -notmatch 'kalcode-win-gate-w1|C:\\kalcode-ci-pool(?:\\worker-w1)?\b') { continue }
                $result.serviceEvents += @{log=$log;id=$event.Id;provider=$event.ProviderName;at=$event.TimeCreated.ToUniversalTime().ToString('o');facts=(Get-SafeLogFacts $event.Message)}
            }
        }
    }
    $result.state=$(if ($ValidateOnly) {'VERIFIED_NO_INSPECTION'} else {'INSPECTED'}); $result.phase='complete'
} catch {
    $result.state='FAILED'
    $known=@('windows_uac_required','wrong_host','receipt_hash_changed','manifest_hash_changed','not_failed_installer_receipt','unexpected_log_directory','reparse_path','log_size_requires_review','source_inventory_invalid')
    $result.errorCode=$(if ($_.Exception.Message -in $known) {$_.Exception.Message} else {$_.Exception.GetType().Name})
} finally {
    $temporary="$Report.$([Guid]::NewGuid().ToString('N')).tmp"
    $result | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $temporary -Encoding UTF8
    [IO.File]::Move($temporary,$Report)
}
if ($result.state -eq 'FAILED') { exit 1 }
