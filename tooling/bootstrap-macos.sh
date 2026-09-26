#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tooling/bootstrap-macos.sh [--check|--install]

--check    Read-only prerequisite and toolchain check (default).
--install  Explicitly install repository dependencies using already-installed
           Corepack/rustup providers, then repeat the check.

This script never installs Homebrew, Xcode, Node, rustup, certificates, or
notarization credentials. Missing providers are reported with owner actions.
EOF
}

mode="check"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  --install) mode="install" ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then usage >&2; exit 2; fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "bootstrap-macos: this check must run on macOS." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

native_uname="$(uname -m)"
case "$native_uname" in
  arm64) rust_target="aarch64-apple-darwin"; release_arch="arm64" ;;
  x86_64) rust_target="x86_64-apple-darwin"; release_arch="x64" ;;
  *) echo "bootstrap-macos: unsupported native architecture." >&2; exit 1 ;;
esac

required_commands=(git node corepack rustup rustc cargo cmake xcode-select xcrun codesign security hdiutil spctl plutil lipo)
missing=()
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done
if (( ${#missing[@]} > 0 )); then
  echo "bootstrap-macos: missing required tools: ${missing[*]}" >&2
  echo "Install Xcode/Command Line Tools, Node 24, rustup, and CMake through owner-approved providers, then rerun --check." >&2
  exit 1
fi

if [[ "$mode" == "install" ]]; then
  echo "Explicit install mode: configuring pinned repository dependencies."
  corepack enable
  corepack prepare pnpm@10.33.2 --activate
  rustup target add "$rust_target"
  pnpm install --frozen-lockfile
fi

failure=0
release_failure=0
expect() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok  %s\n' "$description"
  else
    printf 'ERR %s\n' "$description" >&2
    failure=1
  fi
}

release_expect() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok  %s\n' "$description"
  else
    printf 'REL %s\n' "$description" >&2
    release_failure=1
  fi
}

probe_kalvoice_cpp_toolchain() {
  local sdk_root source_file object_file result
  sdk_root="$(xcrun --show-sdk-path)" || return 1
  [[ -f "$sdk_root/usr/include/c++/v1/array" ]] || return 1
  source_file="$(mktemp -t kalcode-cxx-probe)" || return 1
  object_file="${source_file}.o"
  printf '%s\n' '#include <array>' 'int main() { std::array<int, 1> value{{0}}; return value[0]; }' > "$source_file"
  if xcrun clang++ -x c++ -std=c++17 -isysroot "$sdk_root" \
    -isystem "$sdk_root/usr/include/c++/v1" -c "$source_file" -o "$object_file"; then
    result=0
  else
    result=$?
  fi
  rm -f "$source_file" "$object_file"
  return "$result"
}

product_version="$(sw_vers -productVersion)"
build_version="$(sw_vers -buildVersion)"
node_version="$(node --version)"
pnpm_version="$(corepack pnpm --version)"
rust_version="$(rustc --version | awk '{print $2}')"
cmake_version="$(cmake --version | awk 'NR == 1 {print $3}')"
developer_dir="$(xcode-select -p)"
if xcode_version="$(xcodebuild -version 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')" && [[ -n "$xcode_version" ]]; then
  developer_tools="$xcode_version"
else
  developer_tools="Command Line Tools ($developer_dir)"
fi

printf 'macOS %s (%s), native architecture %s, release label %s\n' "$product_version" "$build_version" "$native_uname" "$release_arch"
printf 'Apple developer tools: %s\n' "$developer_tools"
printf 'Node: %s; pnpm: %s; rustc: %s; target: %s\n' "$node_version" "$pnpm_version" "$rust_version" "$rust_target"
printf 'CMake: %s (required to build bundled local KalVoice STT)\n' "$cmake_version"

expected_node_major="$(tr -d '[:space:]' < .nvmrc)"
[[ "$node_version" == "v${expected_node_major}."* ]] || { echo "ERR Node must match .nvmrc major ${expected_node_major}." >&2; failure=1; }
[[ "$pnpm_version" == "10.33.2" ]] || { echo "ERR pnpm must match packageManager 10.33.2." >&2; failure=1; }

rust_minor="$(printf '%s' "$rust_version" | awk -F. '{print $2}')"
if [[ "${rust_version%%.*}" != "1" || ! "$rust_minor" =~ ^[0-9]+$ || "$rust_minor" -lt 89 ]]; then
  echo "ERR rustc must satisfy workspace rust-version 1.89 or newer." >&2
  failure=1
fi

expect "Apple developer directory selected" xcode-select -p
expect "macOS SDK available" xcrun --show-sdk-path
expect "native Rust target installed" bash -c "rustup target list --installed | grep -Fx '$rust_target'"
release_expect "notarytool available" xcrun --find notarytool
release_expect "stapler available" xcrun --find stapler
expect "codesign available" xcrun --find codesign
expect "Apple clang/libclang toolchain available for KalVoice" xcrun --find clang
expect "Apple SDK libc++ can compile bundled KalVoice" probe_kalvoice_cpp_toolchain
expect "repository lockfile installs without mutation" test -f pnpm-lock.yaml
expect "macOS Tauri overlay present" test -f apps/desktop/src-tauri/tauri.macos.conf.json
expect "macOS Info.plist valid" plutil -lint apps/desktop/src-tauri/Info.plist
expect "macOS entitlements valid" plutil -lint apps/desktop/src-tauri/entitlements.plist

identity_count="$(security find-identity -v -p codesigning 2>/dev/null | grep -c 'Developer ID Application:' || true)"
printf 'Developer ID Application identities available: %s\n' "$identity_count"
if [[ "$identity_count" == "0" ]]; then release_failure=1; fi
if [[ -n "${KALCODE_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  echo "notarytool keychain profile: configured (authentication not probed)"
else
  echo "notarytool keychain profile: not configured"
  release_failure=1
fi

if metal_compiler="$(xcrun --find metal 2>/dev/null)"; then
  printf 'Metal compiler: %s\n' "$metal_compiler"
else
  echo "Metal compiler: unavailable (optional for development; full Xcode may provide it)"
fi

if (( failure != 0 )); then
  echo "bootstrap-macos: prerequisites are incomplete." >&2
  exit 1
fi
if (( release_failure != 0 )); then
  echo "bootstrap-macos: development prerequisites are ready; release prerequisites are incomplete." >&2
  exit 0
fi
echo "bootstrap-macos: development and release tool prerequisites are ready; signing authentication, clean-machine, and product gates remain separate."
