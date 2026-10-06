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
| `App/Demo/` | In-app demo: a simulated workstation answered on the device (welcome → "Explore a demo workstation"); App Review uses it |
| `UITests/` | XCUITests: demo and fixture smoke tests (no host), plus flows against the real dev host |
| `Tools/RemoteProbe/` | macOS CLI that pairs with a host and exercises every operation |
| `scripts/e2e.sh` | Runs the UI tests against `crates/remote/examples/devhost.rs` |
| `scripts/asc.rb`, `scripts/asc_metadata.rb` | App Store Connect API client (Ruby, no gems): TestFlight, listing, screenshots, review submission |
| `AppStore/` | Store screenshots (iPhone 6.9", iPad 13"), captured from the demo workstation's data |

Build and test (macOS, Xcode 27):

```sh
cd apps/mobile/ios
xcodebuild -project KalCodeRemote.xcodeproj -scheme RemoteKit -destination 'platform=iOS Simulator,name=iPhone 17' test
cargo build -p kalcode-remote --example devhost   # from the repo root
DEVHOST=../../../target/debug/examples/devhost scripts/e2e.sh <simulator-udid> 8
```

Regenerate the project after adding files: `xcodegen generate` in `ios/`.

Release (bundle `com.kalcode.remote`, team JG5K9T47ZF): archive unsigned, then export with
`-allowProvisioningUpdates` and the App Store Connect API key (Apple-managed distribution signing),
and upload with `xcrun altool --upload-app`. The API scripts read `~/.appstoreconnect/kalcode-release.env`
and the `.p8` key from `~/.appstoreconnect/private_keys/`; neither is ever committed.

```sh
ruby scripts/asc.rb status                     # version, builds, review submissions
ruby scripts/asc_metadata.rb                   # apply the en-US listing (ASC_REVIEW_PHONE="+1 ..." for review contact)
ruby scripts/asc.rb screenshots <localizationId> APP_IPHONE_67 AppStore/iphone-6.9/*.jpg
ruby scripts/asc.rb submit                     # reviewSubmissions: create → add version → submit
```

## Android — coming later

Deferred so iOS ships first.
