# Fixture-only tests: load function declarations via AST; never invoke the collector entrypoint.
$ErrorActionPreference='Stop'
$collector=Join-Path $PSScriptRoot 'collect-installed-identity.ps1'
if(!(Test-Path -LiteralPath $collector)){throw 'RED: QA2 lifecycle collector is not implemented'}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($collector,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Collector must parse without errors'}
foreach($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
 . ([scriptblock]::Create($fn.Extent.Text))
}
$realWriteReceipt=${function:Write-Receipt}
$script:count=0
function Check([string]$name,[scriptblock]$body){& $body;$script:count++;Write-Host "PASS $name"}
function Equal($actual,$expected){if($actual -cne $expected){throw "Expected [$expected], got [$actual]"}}
function Reject([scriptblock]$action){$threw=$false;try{& $action | Out-Null}catch{$threw=$true};if(!$threw){throw 'Expected rejection'}}
$goodContext=@{sid='S-1-5-21-3404246868-1146769781-4289962219-1008';user='kalcodeqa2';profile='C:\Users\kalcodeqa2';elevated=$false;administratorMember=$false}
Check 'exact standard QA2 identity accepted' {Assert-Qa2Context $goodContext}
foreach($mutation in @(@('sid','S-1-5-21-3404246868-1146769781-4289962219-1009'),@('user','kalcodeqa6'),@('profile','C:\Users\kalcodeqa2-other'),@('elevated',$true),@('administratorMember',$true))){
 Check "reject context $($mutation[0])" {$bad=$goodContext.Clone();$bad[$mutation[0]]=$mutation[1];Reject {Assert-Qa2Context $bad}}
}
Check 'baseline pins select original signed embedded payload' {
 $p=Get-ReleasePin '0.1.4'
 Equal $p.commit '0ee34938d6543bba3679cb008174231d0e9544ec'
 Equal $p.installer '4d4d8897ab376b5532e3940d79c13a2a2674614ade729ace211dba7f662ebb70'
 Equal $p.exe '6d23263f74597aa83866be04c910460f6cecbbc64b207d7f4c24e1d73d7a6af4'
 Equal $p.guardian '0aa8f901a518a7c64b46d62660e5b22aa622cd3cd8094c8ee1b648a829969c7a'
}
Check 'candidate selects final 8d6c133 rather than same-version historical bytes' {
 $p=Get-ReleasePin '0.1.5'
 Equal $p.commit '8d6c133ce720281fe74b3bebd3ec0d9227c39ed4'
 Equal $p.installer '5cb6261894cc84caa711e5e18623ba545d0a9901a2406909d1836ec9082e6f5d'
 Equal $p.exe 'f0aea6713e21554a17503612551dec4c1e8a4cf28daef352f9a2a7a93f6c8a47'
 Equal $p.guardian '37d8086142a810760e4250c2d3a920cdfedd148d0498c931418a989100180be7'
}
Check 'unsupported version refused' {Reject {Get-ReleasePin '0.1.6'}}
# Replace only OS boundaries. No fixture points at or reads a real user profile.
$script:profile='C:\Users\kalcodeqa2'
$script:reparse=$null
$script:missing=$false
$script:journalText='{}'
$script:length=1
function Test-Path {param($LiteralPath,$PathType) return !$script:missing}
function Get-Item {param($LiteralPath,[switch]$Force) return [pscustomobject]@{Attributes=$(if($LiteralPath -eq $script:reparse){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal});Length=$script:length;VersionInfo=@{ProductVersion='0.1.5'}}}
function Get-Content {param($LiteralPath,[switch]$Raw) return $script:journalText}
Check 'normal profile file accepted' {Equal (SafeProfilePath 'C:\Users\kalcodeqa2\AppData\Local\KalCode\kalcode.exe') 'C:\Users\kalcodeqa2\AppData\Local\KalCode\kalcode.exe'}
Check 'outside profile refused' {Reject {SafeProfilePath 'C:\Users\kalcodeqa6\kalcode.exe'}}
Check 'dot traversal refused' {Reject {SafeProfilePath 'C:\Users\kalcodeqa2\..\kalcodeqa6\kalcode.exe'}}
Check 'parent reparse refused' {$script:reparse='C:\Users\kalcodeqa2\AppData';Reject {SafeProfilePath 'C:\Users\kalcodeqa2\AppData\Local\KalCode\kalcode.exe'};$script:reparse=$null}
$script:publisherOid='1.3.6.1.4.1.311.97.208143396.135769116.211620001.449325895'
$script:fileHash='f0aea6713e21554a17503612551dec4c1e8a4cf28daef352f9a2a7a93f6c8a47'
$script:signatureStatus='Valid';$script:timestamp=$true;$script:publicTrust=$true;$script:publisher=$script:publisherOid
function Get-FileHash {param($LiteralPath,$Algorithm) @{Hash=$script:fileHash}}
function Get-AuthenticodeSignature {
 param($LiteralPath)
 $oids=New-Object Security.Cryptography.OidCollection
 [void]$oids.Add((New-Object Security.Cryptography.Oid($script:publisher)))
 if($script:publicTrust){[void]$oids.Add((New-Object Security.Cryptography.Oid('1.3.6.1.4.1.311.97.1.0')))}
 $extension=New-Object Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($oids,$false)
 return @{Status=$script:signatureStatus;TimeStamperCertificate=$(if($script:timestamp){@{}}else{$null});SignerCertificate=@{Extensions=@($extension);Subject='fixture';Thumbprint='fixture'}}
}
function FixtureReport {
 $file=SignedFile 'C:\Users\kalcodeqa2\AppData\Local\KalCode\kalcode.exe' 'f0aea6713e21554a17503612551dec4c1e8a4cf28daef352f9a2a7a93f6c8a47'
 return @{registrationVersion='0.1.5';app=$file;guardian=$file}
}
Check 'exact signed installed identity accepted' {Equal (Test-InstalledIdentity (FixtureReport) '0.1.5') $true}
foreach($case in @('hash','signature','timestamp','publisher','trust','missing','version')){
 Check "reject installed $case mismatch" {
  switch($case){hash{$script:fileHash='0'*64}signature{$script:signatureStatus='NotTrusted'}timestamp{$script:timestamp=$false}publisher{$script:publisher='1.2.3.4'}trust{$script:publicTrust=$false}missing{$script:missing=$true}}
  $r=FixtureReport;if($case -eq 'version'){$r.registrationVersion='0.1.4'}
  Equal (Test-InstalledIdentity $r '0.1.5') $false
  $script:fileHash='f0aea6713e21554a17503612551dec4c1e8a4cf28daef352f9a2a7a93f6c8a47';$script:signatureStatus='Valid';$script:timestamp=$true;$script:publisher=$script:publisherOid;$script:publicTrust=$true;$script:missing=$false
 }
}
Check 'journal projects only bounded safe fields' {
 $script:journalText='{"channel":"stable","lastSuccessfulVersion":"0.1.5","lastFailure":null,"secret":"must-not-copy","installAttempt":{"kind":"upgrade","fromVersion":"0.1.4","toVersion":"0.1.5","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","secret":"must-not-copy"}}'
 $j=Get-SafeJournal 'C:\Users\kalcodeqa2\AppData\Roaming\com.kalcode.desktop\updates\updater.json'
 Equal $j.channel 'stable';Equal $j.installAttempt.toVersion '0.1.5';Equal ($j.ContainsKey('secret')) $false;Equal ($j.installAttempt.ContainsKey('secret')) $false
}
Check 'oversized journal refused' {$script:length=65537;Reject {Get-SafeJournal 'C:\Users\kalcodeqa2\journal.json'};$script:length=1}
Check 'malformed journal refused' {$script:journalText='{';Reject {Get-SafeJournal 'C:\Users\kalcodeqa2\journal.json'}}
Check 'unsafe journal strings suppressed' {$script:journalText='{"channel":"private","lastSuccessfulVersion":"secret","installAttempt":{"kind":"secret","fromVersion":"secret","toVersion":"secret","sha256":"secret"}}';$j=Get-SafeJournal 'C:\Users\kalcodeqa2\journal.json';Equal $j.channel 'unknown';Equal $j.lastSuccessfulVersion $null;Equal $j.installAttempt.sha256 $null}
Check 'missing journal distinguished from successful lifecycle' {$script:missing=$true;$j=Get-SafeJournal 'C:\Users\kalcodeqa2\journal.json';Equal $j.exists $false;$script:missing=$false}
Check 'receipt root rejects linked parents' {$script:reparse='C:\Fixture';Reject {Assert-ReceiptRoot 'C:\Fixture\Receipts'};$script:reparse=$null}
Check 'receipt root rejects missing output directory' {$script:missing=$true;Reject {Assert-ReceiptRoot 'C:\Fixture\Receipts'};$script:missing=$false}
# Integration executes the real entrypoint statements with OS boundaries replaced.
# Require a separate shortcut boundary before executing, so COM can never reach a real profile.
if(!$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ShortcutIdentity'},$false)){throw 'RED: entrypoint shortcut boundary unavailable for safe OS fixture'}
$entryStatements=@($ast.EndBlock.Statements | Where-Object {$_.Extent.StartOffset -gt ($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false) | Select-Object -Last 1).Extent.EndOffset})
# Last statement is the real process exit: test its success/failure through report status below.
$entry=[scriptblock]::Create("`$PSScriptRoot='C:\Fixture\Receipts'`n"+(($entryStatements | Select-Object -SkipLast 1 | ForEach-Object {$_.Extent.Text}) -join "`n"))
function Get-Qa2Context {return $script:fixtureContext}
function Get-ItemProperty {param($LiteralPath) Equal $LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode';return @{InstallLocation='C:\Users\kalcodeqa2\AppData\Local\KalCode';DisplayVersion=$script:fixtureVersion}}
function Get-ShortcutIdentity {param($exe) return @(@{exists=$true;target=$exe;targetMatchesInstalledApp=$true})}
function Get-FileHash {param($LiteralPath,$Algorithm) $p=Get-ReleasePin $script:fixtureVersion;return @{Hash=$(if($LiteralPath.EndsWith('kalcode-provider-guardian.exe')){$p.guardian}else{$p.exe})}}
function Get-Item {param($LiteralPath,[switch]$Force) return @{Attributes=[IO.FileAttributes]::Normal;Length=1;VersionInfo=@{ProductVersion=$script:fixtureVersion}}}
function Write-Receipt {param($directory,$report) $script:captured=$report;return 'fixture-only.json'}
$script:fixtureContext=$goodContext.Clone();$script:journalText='{}'
$env:APPDATA='C:\Users\kalcodeqa2\AppData\Roaming' # Child fixture process only; OS reads remain mocked.
foreach($v in @('0.1.4','0.1.5')){
 Check "real entrypoint binds $v report from mocked OS" {
  $script:fixtureVersion=$v;$ExpectedVersion=$v;$script:captured=$null
  & $entry
  Equal $script:captured.status 'installed-identity-matched';Equal $script:captured.applicationExecuted $false
  Equal $script:captured.expectedCommit $(if($v -eq '0.1.4'){'0ee34938d6543bba3679cb008174231d0e9544ec'}else{'8d6c133ce720281fe74b3bebd3ec0d9227c39ed4'})
 }
}
Check 'entrypoint rejects wrong SID before producing receipt' {$script:fixtureContext.sid='wrong';$script:captured=$null;$ExpectedVersion='0.1.5';Reject {& $entry};Equal $script:captured $null;$script:fixtureContext=$goodContext.Clone()}
Check 'entrypoint error uses constant safe failure rather than raw payload' {$script:journalText='{SECRET';$ExpectedVersion='0.1.5';& $entry;Equal $script:captured.status 'pending-error';Equal $script:captured.error 'Installed identity collection failed; preserve state for Primary review';$script:journalText='{}'}
# Real receipt I/O stays inside a uniquely created fixture directory beside this test.
Remove-Item Function:\Test-Path,Function:\Get-Item,Function:\Get-Content
Set-Item Function:\Write-Receipt $realWriteReceipt
Check 'receipt writing creates distinct files and preserves first observation' {
 $fixtureDir=Join-Path $PSScriptRoot ('.fixture-'+[Guid]::NewGuid().ToString('N'))
 if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($fixtureDir)) -ine $PSScriptRoot){throw 'Fixture escaped test directory'}
 New-Item -ItemType Directory -Path $fixtureDir | Out-Null
 $first=$null;$second=$null
 try{
  $first=Write-Receipt $fixtureDir @{expectedVersion='0.1.4';status='fixture-baseline'}
  $second=Write-Receipt $fixtureDir @{expectedVersion='0.1.5';status='fixture-candidate'}
  Equal ($first -ne $second) $true
  Equal ((Get-Content -Raw -LiteralPath $first | ConvertFrom-Json).status) 'fixture-baseline'
  Equal ((Get-Content -Raw -LiteralPath $second | ConvertFrom-Json).status) 'fixture-candidate'
 }finally{
  foreach($file in @($first,$second)){if($file){Remove-Item -LiteralPath $file}}
  Remove-Item -LiteralPath $fixtureDir
 }
}
Write-Host "PASS $script:count fixture cases; no real OS identity/profile collection"
