# Build tools for the kalvoice-whisper feature (build:e2e): whisper-rs-sys drives whisper.cpp's
# CMake build and generates its bindings with bindgen, which loads libclang. The gate machine has
# neither, and gets no admin rights, so both come from pinned official archives under runner temp.
# Bundled bindings (WHISPER_DONT_GENERATE_BINDINGS) are not used: they were generated on
# Linux/glibc and would not match what the Windows release compiles.
param([switch]$Cleanup)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '^[1-9][0-9]*$') { throw 'A workflow run identity is required' }
if (-not $env:RUNNER_TEMP) { throw 'Runner temp directory is required' }
$tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$portable = [IO.Path]::GetFullPath((Join-Path $tempRoot ('kalcode-gate-speech-tools-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT)))
if ([IO.Path]::GetDirectoryName($portable) -cne $tempRoot) { throw 'Speech build tools must stay directly within runner temp' }
if (Test-Path -LiteralPath $portable) {
  if ((Get-Item -LiteralPath $portable).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Speech build tools path is a reparse point' }
  if ($Cleanup) { Remove-Item -LiteralPath $portable -Recurse -Force; exit 0 }
  throw 'Speech build tools path already exists; preserve it and use a fresh run attempt'
}
if ($Cleanup) { exit 0 }
$null = New-Item -ItemType Directory -Path $portable

# GitHub release assets redirect to their storage host, so redirects are allowed; the pinned
# SHA-256 is what authenticates the bytes.
function Get-Pinned([string]$Url, [string]$Sha256, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -TimeoutSec 600 -MaximumRedirection 5
  if ((Get-FileHash -LiteralPath $OutFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) { throw "SHA-256 mismatch for $Url" }
}

# CMake: same version as the macOS gate. URL and SHA-256 from Kitware's release and its published
# cmake-4.4.3-SHA-256.txt: https://github.com/Kitware/CMake/releases/tag/v4.4.3
$zip = Join-Path $portable 'cmake.zip'
Get-Pinned 'https://github.com/Kitware/CMake/releases/download/v4.4.3/cmake-4.4.3-windows-x86_64.zip' '4d52ebab7193a698651639ed80d8d04fd903358843572cf44c7fd234cb7c26ab' $zip
Expand-Archive -LiteralPath $zip -DestinationPath $portable
Remove-Item -LiteralPath $zip -Force
$cmakeBin = Join-Path $portable 'cmake-4.4.3-windows-x86_64\bin'
$cmake = Join-Path $cmakeBin 'cmake.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $cmake
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN="?Kitware, Inc\.') { throw 'Portable CMake executable is not signed by Kitware' }
$version = & $cmake --version
if ($LASTEXITCODE -ne 0 -or $version[0] -cne 'cmake version 4.4.3') { throw 'Portable CMake version check failed' }
$version[0]
Add-Content -LiteralPath $env:GITHUB_PATH -Value $cmakeBin -Encoding UTF8
Add-Content -LiteralPath $env:GITHUB_ENV -Value ('CMAKE=' + $cmake) -Encoding UTF8

# libclang: use one already on the machine (as a developer or release build would), otherwise the
# pinned official LLVM release.
$candidates = @()
if ($env:LIBCLANG_PATH) { $candidates += $env:LIBCLANG_PATH }
if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'LLVM\bin') }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (${env:ProgramFiles(x86)} -and (Test-Path -LiteralPath $vswhere)) {
  foreach ($vs in @(& $vswhere -products '*' -prerelease -property installationPath)) {
    if ($vs) { $candidates += (Join-Path $vs 'VC\Tools\Llvm\x64\bin') }
  }
}
$libclangDir = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'libclang.dll') -PathType Leaf } | Select-Object -First 1
if ($libclangDir) {
  "Using existing libclang in $libclangDir"
} else {
  # LLVM publishes no SHA-256 file; this is GitHub's published asset digest for this exact file
  # (https://github.com/llvm/llvm-project/releases/tag/llvmorg-23.1.2), checked against a download.
  # The .tar.zst is smaller but uses a zstd window Windows' tar cannot decode.
  $root = 'clang+llvm-23.1.2-x86_64-pc-windows-msvc'
  $archive = Join-Path $portable 'llvm.tar.xz'
  Get-Pinned "https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.2/$root.tar.xz" '8fb91cdc44fcbbdcf6b3ffd0a1f9859abd14a3c3aae4423c2b6d4a4f90bf0095' $archive
  # Only libclang and clang's builtin headers (stddef.h and friends) are needed.
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $archive -C $portable "$root/bin/libclang.dll" "$root/lib/clang/23/include"
  if ($LASTEXITCODE -ne 0) { throw 'Extracting libclang from the LLVM release failed' }
  Remove-Item -LiteralPath $archive -Force
  $libclangDir = Join-Path $portable "$root\bin"
  if (-not (Test-Path -LiteralPath (Join-Path $libclangDir 'libclang.dll') -PathType Leaf)) { throw 'libclang.dll missing from the LLVM release' }
  "Using pinned LLVM 23.1.2 libclang in $libclangDir"
}
Add-Content -LiteralPath $env:GITHUB_ENV -Value ('LIBCLANG_PATH=' + $libclangDir) -Encoding UTF8
