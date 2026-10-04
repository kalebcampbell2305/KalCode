# Loaded only after the desktop verifier's account/session/owner-machine guards.
# Signed installer transition proof, not production updater delivery. No fixtures.
function Invoke-CandidateRelease([string[]]$Arguments) {
  $workflowToken = $env:GH_TOKEN
  try {
    $output = (& gh @Arguments | Out-String)
    $code = $LASTEXITCODE
    if ($code -ne 0 -and $workflowToken) {
      # Read-only Actions tokens cannot see drafts. Try the runner's existing
      # native gh login without reading, printing, copying or changing credentials.
      $env:GH_TOKEN = $null
      $output = (& gh @Arguments | Out-String)
      $code = $LASTEXITCODE
    }
    if ($code -ne 0) { Refuse 'candidate draft access failed with workflow and existing runner-native authentication' }
    $output
  } finally { $env:GH_TOKEN = $workflowToken }
}
function Get-CandidatePackage {
  $metaText = Invoke-CandidateRelease @('release', 'view', $CandidateTag, '--json', 'isDraft,targetCommitish,tagName')
  $meta = $metaText | ConvertFrom-Json
  if (-not $meta.isDraft -or $meta.tagName -cne $CandidateTag -or $meta.targetCommitish -cne $CandidateCommit) { Refuse 'candidate must be a draft release targeting the exact source commit' }
  $packet = Join-Path $OutDir 'candidate-package'
  $null = New-Item -ItemType Directory -Path $packet
  $null = Invoke-CandidateRelease @('release', 'download', $CandidateTag, '--pattern', 'build.json', '--dir', $packet)
  $build = Get-Content -LiteralPath (Join-Path $packet 'build.json') -Raw | ConvertFrom-Json
  if ($build.product -cne 'KalCode' -or $build.version -cne $CandidateVersion -or $build.commit -cne $CandidateCommit -or $build.sha256 -cne $CandidateSha256 -or $build.os -cne 'windows' -or $build.arch -cne 'x64' -or $build.kind -cne 'nsis' -or $build.signed -ne $true -or $build.signatureStatus -cne 'Valid') { Refuse 'candidate build record identity mismatch' }
  $expectedFile = 'KalCode_' + $CandidateVersion.Replace('+', '_build') + '_x64-setup.exe'
  if ($build.file -cne $expectedFile) { Refuse 'candidate build filename mismatch' }
  $null = Invoke-CandidateRelease @('release', 'download', $CandidateTag, '--pattern', $expectedFile, '--dir', $packet)
  $exe = Join-Path $packet $expectedFile
  if ((Sha $exe) -cne $CandidateSha256 -or (Get-Item -LiteralPath $exe).Length -ne $build.size) { Refuse 'candidate installer bytes mismatch' }
  $sig = Get-AuthenticodeSignature -LiteralPath $exe
  if ($sig.Status -ne 'Valid') { Refuse 'candidate installer signature is not valid' }
  $receipt.schema = 'kalcode-fast-update-from-live/v1'
  $receipt.changesData = [bool]$ChangesData; $receipt.changesUpdater = $false; $receipt.expectSchema = $ExpectSchema
  $receipt.proofMechanism = 'signed /S /UPDATE package transition in isolated interactive desktop'
  $receipt.checks = [ordered]@{ install = $false; launch = $false; updateFromLive = $false; dataKept = $false; restoreGuard = $null }
  $receipt.safeguards = [ordered]@{ authenticationBypassed = $false; cacheSeeded = $false; fixtureOnly = $false; testHooks = $false; tlsBypassed = $false }
  $receipt.candidate.source = 'private-draft-release'; $receipt.candidate.tag = $CandidateTag
  $receipt.candidate.installerSignature = [string]$sig.Status
  $receipt.candidate.buildRecordSha256 = Sha (Join-Path $packet 'build.json')
  # The token is only for draft download; the application never inherits it.
  $env:GH_TOKEN = $null
  [ordered]@{ exe = $exe; signer = $sig.SignerCertificate.Subject }
}

function Copy-ClosedDatabase([string]$label) {
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while (@(KalProcs).Count -and $wait.Elapsed.TotalSeconds -lt 15) { Start-Sleep -Milliseconds 500 }
  if (@(KalProcs).Count) { Refuse 'database snapshot requires natural shutdown of the QA application and helpers' }
  $db = Join-Path $AppData 'kalcode.db'
  if (-not (Test-Path -LiteralPath $db)) { Refuse 'launched app did not create its database' }
  $copy = Join-Path $OutDir ($label + '.db')
  Copy-Item -LiteralPath $db -Destination $copy
  foreach ($suffix in '-wal', '-shm') { if (Test-Path -LiteralPath ($db + $suffix)) { Copy-Item -LiteralPath ($db + $suffix) -Destination ($copy + $suffix) } }
  $copy
}

function Invoke-PackageProof($package, $liveRun, $liveSignature) {
  if ($package.signer -cne $liveSignature.SignerCertificate.Subject) { Refuse 'live and candidate installers have different publisher identities' }
  $receipt.liveClose = Close-Exact $liveRun.pid
  if (-not $receipt.liveClose.exited -or -not $receipt.liveClose.accepted) { Refuse 'live application did not exit naturally through its window' }
  $before = Copy-ClosedDatabase 'db-live'
  $floorPath = Join-Path $Updates 'rollback-floor'
  $floorBefore = if (Test-Path -LiteralPath $floorPath) { (Read-Shared $floorPath).Trim() } else { $null }
  $installer = Start-Process -FilePath $package.exe -ArgumentList '/S', '/UPDATE' -WindowStyle Hidden -PassThru
  if (-not $installer.WaitForExit(300000)) { Refuse 'candidate installer exceeded 300s; leaving owned process for diagnosis' }
  if ($installer.ExitCode -ne 0) { Refuse "candidate installer failed: $($installer.ExitCode)" }
  $receipt.applied = Installed
  if (-not $receipt.applied -or $receipt.applied.productVersion -cne $CandidateVersion -or $receipt.applied.fileVersion -cne $CandidateVersion -or $receipt.applied.signature -cne 'Valid') { Refuse 'installed candidate identity/signature mismatch' }
  $receipt.checks.install = $true
  $receipt.autoRelaunched = [bool]@(KalProcs | Where-Object { $_.Name -eq 'kalcode' }).Count
  if ($receipt.autoRelaunched) { Refuse '/UPDATE unexpectedly relaunched KalCode' }
  $receipt.reopen = Launch $CandidateVersion
  $receipt.checks.launch = $true
  $receipt.candidateClose = Close-Exact $receipt.reopen.pid
  if (-not $receipt.candidateClose.exited -or -not $receipt.candidateClose.accepted) { Refuse 'candidate application did not exit naturally through its window' }
  $after = Copy-ClosedDatabase 'db-candidate'
  $expectedLive = if ($LiveSchema -gt 0) { $LiveSchema } else { $ExpectSchema }
  $comparison = (& python -I -B (Join-Path $PSScriptRoot 'compare-desktop-databases.py') $before $after $CandidateVersion $ExpectSchema $expectedLive | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $comparison) { Refuse 'read-only database comparison failed' }
  $receipt.dataCompare = $comparison | ConvertFrom-Json
  [IO.File]::WriteAllText((Join-Path $OutDir 'database-comparison.json'), $comparison)
  if (@($receipt.dataCompare.differences).Count) { Refuse 'candidate changed or lost pre-existing project data; see database-comparison.json' }
  $receipt.checks.dataKept = $true; $receipt.checks.updateFromLive = $true
  $floorAfter = if (Test-Path -LiteralPath $floorPath) { (Read-Shared $floorPath).Trim() } else { $null }
  $receipt.floor = [ordered]@{ before = $floorBefore; after = $floorAfter }
  if ($ChangesData) {
    if ($floorAfter -cne $CandidateVersion) { Refuse 'migration did not set the forward-only rollback floor to the candidate version' }
    $receipt.checks.restoreGuard = $true
  }
  Note "signed package update passed; $($receipt.dataCompare.rowsKept) existing rows retained"
}
