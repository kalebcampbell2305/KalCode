#!/bin/bash
# One-time, as an administrator on the Mac (sudo): installs the KalCode macOS gate runner.
#
# Like the Windows gate runner, it runs PR/branch code, so it runs as its own hidden standard
# account, `kalcodeci`, which cannot read the owner's home folder or login Keychain (Developer ID
# identity, notary profile). It has its own Rust toolchain, pnpm and caches, and runs as a
# LaunchDaemon with that account's identity.
#
# Usage: sudo bash setup-gate-runner.sh <registration-token>
# (token: gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token)

set -euo pipefail
TOKEN="${1:?registration token required}"
VERSION="${RUNNER_VERSION:-2.337.0}"
PNPM_VERSION="${PNPM_VERSION:-10.33.2}"
ACCOUNT=kalcodeci
HOME_DIR="/Users/$ACCOUNT"
RUNNER="$HOME_DIR/actions-runner"
PLIST=/Library/LaunchDaemons/com.kalcode.gate-runner.plist

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
LOG=/tmp/kalcode-gate-setup.log
: > "$LOG" && chmod 644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
trap 'echo "FAILED at line $LINENO (exit $?)"' ERR

# 1. A hidden standard account with a random password nobody keeps.
if ! id "$ACCOUNT" >/dev/null 2>&1; then
  # No pipe into head here: with pipefail its SIGPIPE would abort the script silently.
  password="Kc7$(openssl rand -hex 24)"
  sysadminctl -addUser "$ACCOUNT" -fullName "KalCode gate runner" -password "$password" -home "$HOME_DIR"
  createhomedir -c -u "$ACCOUNT" >/dev/null
  dscl . -create "/Users/$ACCOUNT" IsHidden 1
fi
chmod 700 "$HOME_DIR"

# 2. Its own toolchain, runner and job environment, installed as the account.
# Written to a file and run with no stdin, so no tool can swallow the rest of the script.
INNER="$(mktemp /tmp/kalcode-gate-inner.XXXXXX)"
cat > "$INNER" <<'AS_ACCOUNT'
TOKEN="$1"; VERSION="$2"; PNPM_VERSION="$3"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$HOME"
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal -c rustfmt -c clippy
fi
npm install --global --prefix "$HOME/.npm-global" "pnpm@$PNPM_VERSION" >/dev/null
mkdir -p actions-runner && cd actions-runner
if [ ! -x ./config.sh ]; then
  curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-osx-arm64-$VERSION.tar.gz"
  tar xzf runner.tgz && rm runner.tgz
fi
cat > .env <<ENV
PATH=$HOME/.cargo/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
PLAYWRIGHT_BROWSERS_PATH=$HOME/ms-playwright
ENV
./config.sh --unattended --replace --url https://github.com/kalebcampbell2305/KalCode --token "$TOKEN" \
  --name kalcode-mac-gate --labels kalcode-gate --work _work
AS_ACCOUNT
chmod 755 "$INNER"
sudo -u "$ACCOUNT" -H bash -euo pipefail "$INNER" "$TOKEN" "$VERSION" "$PNPM_VERSION" </dev/null
rm -f "$INNER"

# 3. Start at boot as the account.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kalcode.gate-runner</string>
  <key>UserName</key><string>$ACCOUNT</string>
  <key>WorkingDirectory</key><string>$RUNNER</string>
  <key>ProgramArguments</key><array><string>$RUNNER/run.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME_DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/runner.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/runner.log</string>
</dict>
</plist>
PLIST_EOF
chmod 644 "$PLIST"
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
echo "kalcode-mac-gate is installed and running as $ACCOUNT."
