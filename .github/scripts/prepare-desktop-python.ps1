# Python's official embeddable distribution needs no installer, registry access, or elevation.
param([switch]$Cleanup)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '^[1-9][0-9]*$') { throw 'A workflow run identity is required' }
if (-not $env:RUNNER_TEMP) { throw 'Runner temp directory is required' }
$tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$portable = [IO.Path]::GetFullPath((Join-Path $tempRoot ('kalcode-qa-python-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT)))
if ([IO.Path]::GetDirectoryName($portable) -cne $tempRoot) { throw 'Portable Python must stay directly within runner temp' }
if (Test-Path -LiteralPath $portable) {
  if ((Get-Item -LiteralPath $portable).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Portable Python path is a reparse point' }
  if ($Cleanup) { Remove-Item -LiteralPath $portable -Recurse -Force; exit 0 }
  throw 'Portable Python path already exists; preserve it and use a fresh run attempt'
}
if ($Cleanup) { exit 0 }
$null = New-Item -ItemType Directory -Path $portable
$zip = Join-Path $portable 'python.zip'
# Official release page and .sigstore bundle both identify this exact artifact.
# https://www.python.org/downloads/release/python-3141/
$url = 'https://www.python.org/ftp/python/3.14.1/python-3.14.1-embed-amd64.zip'
$sha256 = '0e613b6c5f332ce3278b6250d56ab0bdbbbacb61b9028b9b0865efe80fca1529'
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 120 -MaximumRedirection 0
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha256) { throw 'Official portable Python SHA-256 mismatch' }
$runtime = Join-Path $portable 'runtime'
Expand-Archive -LiteralPath $zip -DestinationPath $runtime
$exe = Join-Path $runtime 'python.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Python Software Foundation,') { throw 'Portable Python executable is not signed by the Python Software Foundation' }
& $exe -I -B -c 'import sys,sqlite3; assert sys.version_info[:3] == (3,14,1); print(sys.version); print(sqlite3.sqlite_version)'
if ($LASTEXITCODE -ne 0) { throw 'Portable Python SQLite check failed' }
Add-Content -LiteralPath $env:GITHUB_PATH -Value $runtime -Encoding UTF8
