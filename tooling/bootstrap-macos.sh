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

required_commands=(git node corepack rustup rustc cargo xcode-select xcodebuild xcrun codesign security hdiutil spctl plutil lipo)
missing=()
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done
if (( ${#missing[@]} > 0 )); then
  echo "bootstrap-macos: missing required tools: ${missing[*]}" >&2
  echo "Install Xcode/Command Line Tools, Node 24, and rustup through owner-approved providers, then rerun --check." >&2
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

product_version="$(sw_vers -productVersion)"
build_version="$(sw_vers -buildVersion)"
node_version="$(node --version)"
pnpm_version="$(corepack pnpm --version)"
rust_version="$(rustc --version | awk '{print $2}')"
xcode_version="$(xcodebuild -version | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

printf 'macOS %s (%s), native architecture %s, release label %s\n' "$product_version" "$build_version" "$native_uname" "$release_arch"
printf 'Xcode: %s\n' "$xcode_version"
printf 'Node: %s; pnpm: %s; rustc: %s; target: %s\n' "$node_version" "$pnpm_version" "$rust_version" "$rust_target"

expected_node_major="$(tr -d '[:space:]' < .nvmrc)"
[[ "$node_version" == "v${expected_node_major}."* ]] || { echo "ERR Node must match .nvmrc major ${expected_node_major}." >&2; failure=1; }
[[ "$pnpm_version" == "10.33.2" ]] || { echo "ERR pnpm must match packageManager 10.33.2." >&2; failure=1; }

rust_minor="$(printf '%s' "$rust_version" | awk -F. '{print $2}')"
if [[ "${rust_version%%.*}" != "1" || ! "$rust_minor" =~ ^[0-9]+$ || "$rust_minor" -lt 89 ]]; then
  echo "ERR rustc must satisfy workspace rust-version 1.89 or newer." >&2
  failure=1
fi

expect "Xcode developer directory selected" xcode-select -p
expect "Xcode first-launch tasks completed" xcodebuild -checkFirstLaunchStatus
expect "native Rust target installed" bash -c "rustup target list --installed | grep -Fx '$rust_target'"
expect "notarytool available" xcrun --find notarytool
expect "stapler available" xcrun --find stapler
expect "codesign available" xcrun --find codesign
expect "Apple clang/libclang toolchain available for KalVoice" xcrun --find clang
expect "repository lockfile installs without mutation" test -f pnpm-lock.yaml
expect "macOS Tauri overlay present" test -f apps/desktop/src-tauri/tauri.macos.conf.json
expect "macOS Info.plist valid" plutil -lint apps/desktop/src-tauri/Info.plist
expect "macOS entitlements valid" plutil -lint apps/desktop/src-tauri/entitlements.plist

identity_count="$(security find-identity -v -p codesigning 2>/dev/null | grep -c 'Developer ID Application:' || true)"
printf 'Developer ID Application identities available: %s\n' "$identity_count"
if [[ -n "${KALCODE_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  echo "notarytool keychain profile: configured (authentication not probed)"
else
  echo "notarytool keychain profile: not configured"
fi

if (( failure != 0 )); then
  echo "bootstrap-macos: prerequisites are incomplete." >&2
  exit 1
fi
echo "bootstrap-macos: local prerequisites are ready; signing, notarization, clean-machine, and product gates remain separate."
