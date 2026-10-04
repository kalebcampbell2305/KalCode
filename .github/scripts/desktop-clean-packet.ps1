# Reuse the exact candidate's canonical installer verifier. The private draft,
# zip hash, manifest, verifier hash and embedded build identity are all pinned.
function Assert-PacketName([string]$name) {
  if ($name -cnotmatch '^[A-Za-z0-9_.+/-]+$' -or $name.StartsWith('/')) { Refuse 'unsafe verifier packet path' }
  foreach ($part in $name.TrimEnd('/').Split('/')) {
    if (-not $part -or $part -in '.', '..' -or $part.EndsWith('.') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Refuse 'unsafe verifier packet path component' }
  }
}
function Get-CleanPacket {
  $zip = Join-Path $OutDir 'windows-clean-packet.zip'
  $null = Invoke-CandidateRelease @('release', 'download', $CandidateTag, '--pattern', 'windows-clean-packet.zip', '--dir', $OutDir)
  if ((Sha $zip) -cne $CleanPacketSha256) { Refuse 'canonical verifier packet download/hash mismatch' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  $seen = @{}; $size = [int64]0
  try {
    if ($archive.Entries.Count -gt 2000) { Refuse 'verifier packet has too many entries' }
    foreach ($entry in $archive.Entries) {
      Assert-PacketName $entry.FullName
      if ($seen.ContainsKey($entry.FullName)) { Refuse 'duplicate verifier packet path' }
      $seen[$entry.FullName] = $true; $size += $entry.Length
      if ($size -gt 268435456) { Refuse 'verifier packet exceeds extraction limit' }
      if (($entry.ExternalAttributes -shr 16 -band 61440) -eq 40960) { Refuse 'verifier packet contains a symbolic link' }
    }
  } finally { $archive.Dispose() }
  $work = Join-Path $OutDir 'clean-verifier'
  if (Test-Path -LiteralPath $work) { Refuse 'verifier destination already exists' }
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $work)
  $listed = @{}
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $work 'SHA256SUMS'))) {
    if ($line -cnotmatch '^([0-9a-f]{64}) \*(.+)$') { Refuse 'invalid verifier manifest' }
    $hash = $Matches[1]; $name = $Matches[2]; Assert-PacketName $name
    if ($listed.ContainsKey($name)) { Refuse 'duplicate verifier manifest path' }
    $listed[$name] = $true
    if ((Sha (Join-Path $work $name)) -cne $hash) { Refuse 'verifier manifest bytes mismatch' }
  }
  foreach ($file in Get-ChildItem -LiteralPath $work -File -Recurse) {
    $rel = $file.FullName.Substring($work.Length + 1).Replace('\', '/')
    if ($rel -cne 'SHA256SUMS' -and -not $listed.ContainsKey($rel)) { Refuse 'unlisted verifier packet file' }
  }
  if (([IO.File]::ReadAllText((Join-Path $work 'SOURCE-COMMIT.txt'))).Trim() -cne $CandidateCommit -or (Sha (Join-Path $work 'tooling/release/verify-windows.mjs')) -cne $CleanVerifierSha256) { Refuse 'verifier source identity mismatch' }
  $build = Get-Content -LiteralPath (Join-Path $work "dist/release/$CandidateVersion/build.json") -Raw | ConvertFrom-Json
  if ($build.commit -cne $CandidateCommit -or $build.version -cne $CandidateVersion -or $build.sha256 -cne $CandidateSha256) { Refuse 'clean packet candidate identity mismatch' }
  $work
}
function Invoke-CleanPacket([string]$work) {
  if ((Leftovers).Values -contains $true) { Refuse 'canonical clean verification requires an empty QA profile' }
  $clean = [ordered]@{
    schema = 'kalcode-ci-clean-install-verify/v1'; status = 'FAILED'; source = 'packet'
    version = $CandidateVersion; commit = $CandidateCommit; installerSha256 = $CandidateSha256; exit = $null
    packet = [ordered]@{ path = $work; zipSha256 = $CleanPacketSha256; sumsSha256 = (Sha (Join-Path $work 'SHA256SUMS')); verifierSha256 = $CleanVerifierSha256 }
    runner = [ordered]@{ name = $env:RUNNER_NAME; user = $id.Name; sid = $id.User.Value; profile = $env:USERPROFILE; elevated = $false }
    verify = $null; postCheck = $null; startedAt = [DateTime]::UtcNow.ToString('o'); error = $null
  }
  $oldPath = $env:PATH
  try {
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    if ((& $node --version) -notmatch '^v24\.') { Refuse 'canonical clean verifier requires Node 24' }
    $verifyPath = Join-Path $work "dist/release/$CandidateVersion/verify.json"
    if (Test-Path -LiteralPath $verifyPath) { Refuse 'packet contains a stale verify.json' }
    $env:PATH = (Join-Path $work 'shim') + ';' + $env:PATH
    $script:PendingInstaller = Start-Process -FilePath $node -ArgumentList 'tooling/release/verify-windows.mjs' -WorkingDirectory $work -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OutDir 'clean-verify.log') -RedirectStandardError (Join-Path $OutDir 'clean-verify.err.log')
    $null = $script:PendingInstaller.Handle
    if (-not $script:PendingInstaller.WaitForExit(900000)) { Refuse 'canonical verifier timed out; preserving its processes and packet' }
    $clean.exit = $script:PendingInstaller.ExitCode
    $script:PendingInstaller.Dispose(); $script:PendingInstaller = $null
    if (Test-Path -LiteralPath $verifyPath) {
      Copy-Item -LiteralPath $verifyPath -Destination (Join-Path $OutDir 'verify.json')
      $v = Get-Content -LiteralPath $verifyPath -Raw | ConvertFrom-Json
      $clean.verify = [ordered]@{ sha256 = (Sha $verifyPath); status = $v.status; version = $v.version; commit = $v.commit; sha256OfInstaller = $v.sha256 }
    }
    $clean.postCheck = Leftovers
    if ($clean.exit -ne 0 -or -not $clean.verify -or $v.status -cne 'passed' -or $v.version -cne $CandidateVersion -or $v.commit -cne $CandidateCommit -or $v.sha256 -cne $CandidateSha256 -or $clean.postCheck.Values -contains $true) { Refuse 'canonical clean installer verification failed; see verify.json and clean-verify.log' }
    $clean.status = 'PASS'
  } catch { $clean.error = "$_"; throw } finally {
    $env:PATH = $oldPath
    $clean.finishedAt = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $OutDir 'clean-install-receipt.json'), ($clean | ConvertTo-Json -Depth 8))
  }
}
