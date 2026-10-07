# KalCode Remote (mobile)

Native companion apps that mirror a live KalCode workstation and send actions back through the
desktop's own services. The wire contract is [`docs/REMOTE_PROTOCOL.md`](../../docs/REMOTE_PROTOCOL.md);
change both sides together.

## iOS / iPadOS — `ios/`

| Path | What |
|---|---|
| `project.yml` / `KalCodeRemote.xcodeproj` | XcodeGen spec and the generated project (both committed; plain Xcode builds it) |
| `RemoteKit/` | Framework: Noise IK (CryptoKit), framing, models, snapshot/patch reducer, offline queue, Keychain pairing store, Network.framework transport, `RemoteClient` state machine |
| `RemoteKitTests/` | Unit + loopback tests, including the Rust host's Noise vector (`Vectors/noise_ik.json`) reproduced byte for byte |
| `App/` | SwiftUI app (iPhone TabView, iPad split views), design system, KalVoice, notifications |
| `UITests/` | XCUITests that run against the real dev host |
| `Tools/RemoteProbe/` | macOS CLI that pairs with a host and exercises every operation |
| `scripts/e2e.sh` | Runs the UI tests against `crates/remote/examples/devhost.rs` |

Build and test (macOS, Xcode 27):

```sh
cd apps/mobile/ios
xcodebuild -project KalCodeRemote.xcodeproj -scheme RemoteKit -destination 'platform=iOS Simulator,name=iPhone 17' test
cargo build -p kalcode-remote --example devhost   # from the repo root
DEVHOST=../../../target/debug/examples/devhost scripts/e2e.sh <simulator-udid> 8
```

Regenerate the project after adding files: `xcodegen generate` in `ios/`.
Distribution signing (team, App Store Connect, TestFlight) is intentionally not configured.
