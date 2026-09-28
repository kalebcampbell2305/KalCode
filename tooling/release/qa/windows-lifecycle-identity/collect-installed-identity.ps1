param([Parameter(Mandatory=$true)][ValidateSet('0.1.4','0.1.5')][string]$ExpectedVersion)
$ErrorActionPreference='Stop'
function Get-Qa2Context {
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $principal=New-Object Security.Principal.WindowsPrincipal($identity)
 return @{sid=$identity.User.Value;user=$env:USERNAME;profile=$env:USERPROFILE;elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);administratorMember=(@($identity.Groups | ForEach-Object {$_.Value}) -contains 'S-1-5-32-544')}
}
function Assert-Qa2Context($context){
 if($context.sid -cne 'S-1-5-21-3404246868-1146769781-4289962219-1008'){throw 'Unexpected QA account identity'}
 if($context.user -ine 'kalcodeqa2'){throw 'Only kalcodeqa2 may collect lifecycle identity'}
 if($context.elevated -ne $false){throw 'Use a standard non-elevated QA2 session'}
 if($context.administratorMember -ne $false){throw 'QA2 must remain a standard account'}
 if([IO.Path]::GetFullPath([string]$context.profile).TrimEnd('\') -ine 'C:\Users\kalcodeqa2'){throw 'Unexpected QA profile location'}
}
function Get-ReleasePin([string]$version){
 switch($version){
  '0.1.4' {return @{commit='0ee34938d6543bba3679cb008174231d0e9544ec';installer='4d4d8897ab376b5532e3940d79c13a2a2674614ade729ace211dba7f662ebb70';exe='6d23263f74597aa83866be04c910460f6cecbbc64b207d7f4c24e1d73d7a6af4';guardian='0aa8f901a518a7c64b46d62660e5b22aa622cd3cd8094c8ee1b648a829969c7a'}}
  '0.1.5' {return @{commit='8d6c133ce720281fe74b3bebd3ec0d9227c39ed4';installer='5cb6261894cc84caa711e5e18623ba545d0a9901a2406909d1836ec9082e6f5d';exe='f0aea6713e21554a17503612551dec4c1e8a4cf28daef352f9a2a7a93f6c8a47';guardian='37d8086142a810760e4250c2d3a920cdfedd148d0498c931418a989100180be7'}}
  default {throw 'Unsupported release version'}
 }
}
function SafeProfilePath([string]$path){
 $absolute=[IO.Path]::GetFullPath($path)
 if(!$absolute.StartsWith($profile+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Refusing path outside current QA profile'}
 $probe=$absolute
 while($probe.Length -ge $profile.Length){
  if(Test-Path -LiteralPath $probe){if((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing profile reparse path'}}
  if($probe -ieq $profile){break};$probe=[IO.Path]::GetDirectoryName($probe)
 }
 return $absolute
}
function SignedFile($path,$hash){
 $path=SafeProfilePath $path
 if(!(Test-Path -LiteralPath $path -PathType Leaf)){return @{exists=$false;matchesPinnedBytes=$false;path=$path}}
 $actual=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
 $signature=Get-AuthenticodeSignature -LiteralPath $path
 $oids=@()
 if($signature.SignerCertificate){foreach($extension in $signature.SignerCertificate.Extensions){if($extension.Oid.Value -eq '2.5.29.37'){
  $eku=New-Object Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($extension,$extension.Critical)
  foreach($oid in $eku.EnhancedKeyUsages){$oids+=[string]$oid.Value}
 }}}
 $identities=@($oids | Where-Object {$_ -like '1.3.6.1.4.1.311.97.*' -and $_ -ne '1.3.6.1.4.1.311.97.1.0'} | Sort-Object -Unique)
 @{path=$path;exists=$true;sha256=$actual;matchesPinnedBytes=($actual -eq $hash);productVersion=(Get-Item -LiteralPath $path).VersionInfo.ProductVersion;signatureStatus=[string]$signature.Status;timestamped=($null -ne $signature.TimeStamperCertificate);signerSubject=$signature.SignerCertificate.Subject;signerThumbprint=$signature.SignerCertificate.Thumbprint;identityOids=$identities;publicTrustMarker=($oids -contains '1.3.6.1.4.1.311.97.1.0');publisherIdentityBound=($identities.Count -eq 1 -and $identities[0] -eq $publisherOid)}
}

function Test-InstalledIdentity($report,[string]$version){
 $good=$report.registrationVersion -eq $version
 foreach($item in @($report.app,$report.guardian)){
  $good=$good -and $item.exists -and $item.matchesPinnedBytes -and $item.signatureStatus -eq 'Valid' -and $item.timestamped -and $item.publisherIdentityBound -and $item.publicTrustMarker
 }
 return [bool]($good -and $report.app.productVersion -eq $version)
}
function Get-SafeJournal([string]$path){
 $path=SafeProfilePath $path
 if(!(Test-Path -LiteralPath $path -PathType Leaf)){return @{exists=$false}}
 if((Get-Item -LiteralPath $path).Length -gt 65536){throw 'Updater journal exceeds bounded read size'}
 $journal=Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
 $safeVersion={param($value) if([string]$value -match '^\d+\.\d+\.\d+$'){[string]$value}else{$null}}
 $safeAttempt=$null
 if($journal.installAttempt){
  $a=$journal.installAttempt
  $safeAttempt=@{kind=$(if($a.kind -in @('upgrade','rollback')){$a.kind}else{'unknown'});fromVersion=(& $safeVersion $a.fromVersion);toVersion=(& $safeVersion $a.toVersion);sha256=$(if([string]$a.sha256 -match '^[a-fA-F0-9]{64}$'){$a.sha256}else{$null})}
 }
 return @{exists=$true;channel=$(if($journal.channel -in @('stable','beta','dev')){$journal.channel}else{'unknown'});lastSuccessfulVersion=(& $safeVersion $journal.lastSuccessfulVersion);lastFailurePresent=($null -ne $journal.lastFailure);installAttempt=$safeAttempt}
}
function Assert-ReceiptRoot([string]$path){
 $probe=[IO.Path]::GetFullPath($path)
 while($probe){
  if(!(Test-Path -LiteralPath $probe -PathType Container)){throw 'Receipt directory is unavailable'}
  if((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing receipt reparse path'}
  $probe=[IO.Path]::GetDirectoryName($probe)
 }
}
function Write-Receipt([string]$directory,$report){
 Assert-ReceiptRoot $directory
 $output=Join-Path $directory ('identity-kalcodeqa2-'+$report.expectedVersion+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N')+'.json')
 $bytes=[Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 8))
 $stream=[IO.File]::Open($output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 return $output
}

function Get-ShortcutIdentity([string]$exe){
 $shortcuts=@()
 # Existing shortcuts are inspected only; no Save or target execution.
 $shell=New-Object -ComObject WScript.Shell
 try{foreach($base in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))){
  $path=SafeProfilePath (Join-Path $base 'KalCode.lnk')
  $exists=Test-Path -LiteralPath $path -PathType Leaf
  $target=$null
  if($exists){$link=$shell.CreateShortcut($path);try{$target=[string]$link.TargetPath}finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)|Out-Null}}
   $shortcuts+=@{path=$path;exists=$exists;target=$target;targetMatchesInstalledApp=($target -ieq $exe)}
 }}finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)|Out-Null}
 return $shortcuts
}

# Every real invocation must pass actual OS identity; no fixture/test mode exists.
$context=Get-Qa2Context
Assert-Qa2Context $context
$profile=[IO.Path]::GetFullPath($context.profile).TrimEnd('\')
$publisherOid='1.3.6.1.4.1.311.97.208143396.135769116.211620001.449325895'
$pin=Get-ReleasePin $ExpectedVersion
Assert-ReceiptRoot $PSScriptRoot
$report=[ordered]@{observedAt=[DateTime]::UtcNow.ToString('o');user=$context.user;sid=$context.sid;profile=$profile;expectedVersion=$ExpectedVersion;expectedCommit=$pin.commit;pinnedSourceInstallerSha256=$pin.installer;scope='Installed identity only; not auth, product, updater or rollback certification';status='pending';app=$null;guardian=$null;shortcuts=@();journal=$null;error=$null;applicationExecuted=$false}
try{
 $registration=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KalCode'
 $location=SafeProfilePath (([string]$registration.InstallLocation).Trim('"'))
 $report.installLocation=$location
 $report.registrationVersion=[string]$registration.DisplayVersion
 $exe=Join-Path $location 'kalcode.exe'
 $report.app=SignedFile $exe $pin.exe
 $report.guardian=SignedFile (Join-Path $location 'kalcode-provider-guardian.exe') $pin.guardian
 $report.shortcuts=@(Get-ShortcutIdentity $exe)
 $report.journal=Get-SafeJournal (Join-Path $env:APPDATA 'com.kalcode.desktop\updates\updater.json')
 $report.status=if(Test-InstalledIdentity $report $ExpectedVersion){'installed-identity-matched'}else{'identity-mismatch-pending-review'}
}catch{
 # Never copy arbitrary exception messages, raw JSON or account data to a receipt.
 $report.error='Installed identity collection failed; preserve state for Primary review'
 $report.status='pending-error'
}
$output=Write-Receipt $PSScriptRoot $report
Write-Host "$($report.status): $output"
Write-Host 'No application, installer or updater launched. Product and lifecycle checks remain pending.'
if($report.status -eq 'installed-identity-matched'){exit 0}else{exit 1}
