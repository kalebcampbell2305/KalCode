# KalCode Remote for Android

Native Kotlin + Jetpack Compose client for KalCode Remote (protocol: `docs/REMOTE_PROTOCOL.md`).
Phones and tablets, Android 13+ (minSdk 33, target 35). Same information architecture and copy as
`apps/mobile/ios`: Mission Control, Needs You, Runs, KalVoice; Settings and Launch in the top bar.

## Layout

- `protocol/` — Noise IK (BouncyCastle X25519 + ChaCha20-Poly1305), framing, wire types, fleet
  reducer, offline queue, pairing and deep links. Pure Kotlin, JVM-tested.
- `client/` — `RemoteClient` (parallel connect, hello → snapshot, patches with rev-gap reconnect,
  requests, 15 s ping / 35 s silence, 0.5 → 10 s backoff, offline queue, revoke), Keystore-wrapped
  device key and pinned workstation.
- `ui/` — Compose screens; `LinkService` keeps the link for 10 minutes after leaving the app
  (Android 15 cuts background network) so `notify` events still arrive.

## Build and test

```sh
# JDK 17 and an Android SDK (platform 35, build-tools 35)
./gradlew assembleDebug testDebugUnitTest lint
./gradlew connectedDebugAndroidTest   # needs a device or emulator
```

The Noise test reproduces `crates/remote/tests/vectors/noise_ik.json` byte for byte. The
instrumentation tests run the real app against `FakeHost` (a Kotlin Noise responder) on the
device's loopback.

## Against the dev host (emulator)

```sh
cargo run -p kalcode-remote --example devhost -- --data <dir> --agents 8 --addr 10.0.2.2:47820
adb shell am start -a android.intent.action.VIEW -d '<pairing link from devhost stdout>'
```

Fonts: Lexend Deca and JetBrains Mono, SIL OFL 1.1 (`licenses/`).
