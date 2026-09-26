# Updater release-channel prerequisite

Status: **implemented as a fail-closed build contract; updater and publication remain blocked**.

This work closes the first release-pipeline ambiguity needed by a future automatic updater. It
does not add an updater, publish a feed, sign an artifact, or change the website manifest.

## Channel contract

Every Windows release build now requires an explicit product channel:

```text
pnpm release:build --channel stable
pnpm release:build --channel beta
pnpm release:build --channel dev
```

The product vocabulary maps to the existing native `BuildChannel` vocabulary as follows:

| Requested release channel | Compiled `AppInfo.channel` |
| --- | --- |
| `stable` | `stable` |
| `beta` | `beta` |
| `dev` | `development` |

Missing, unknown, or repeated `--channel` arguments fail before the clean-tree check and before
Tauri, Cargo, or the installer build starts. `KALCODE_CHANNEL` in the parent environment is not a
configuration input: the build child environment removes every case variant and writes the mapped
native value explicitly.

`build.json` records both `requestedReleaseChannel` and `compiledChannel`. It also records
`releaseDescriptorEligible`, `releaseDescriptorBlockedReason`, and a
`compiledChannelVerification` object.

## Fail-closed descriptor eligibility

A build is eligible for a future update/release descriptor only when all of these are true:

1. the requested product channel maps exactly to the recorded native channel;
2. a post-build probe has read `AppInfo.channel` from the built binary and matched it;
3. Windows reports a valid Authenticode signature.

Unsigned local development builds remain buildable with `--channel dev`, but their build record is
`releaseDescriptorEligible: false`. An unsigned artifact is never made eligible by a checksum
alone.

The production binary exposes one bounded, read-only probe:

```text
kalcode.exe --build-info
```

That exact sole argument returns JSON and exits before the WebView, stores, provider adapters, or
the rest of the runtime starts. The build executes the newly written binary and requires schema
version 1, the exact application version, the mapped native channel, and `testHooks: false`. Extra
fields, malformed JSON, version/channel mismatches, and test-enabled builds fail closed. A verified
record contains:

```json
{
  "compiledChannelVerification": {
    "status": "verified",
    "method": "build_info_probe_v1",
    "schemaVersion": 1,
    "testHooks": false
  }
}
```

The build does not treat the compiler environment variable itself as verification.

## Verification

Focused tests run the real argument parser and invoke the actual build entry point with invalid
arguments. They prove that missing, invalid, and duplicate channels fail before release preflight;
that ambient `KALCODE_CHANNEL` is replaced; that the mapping is exact; that the binary probe has a
closed schema; and that unsigned, signature-invalid, mismatched, test-enabled, or unprobed builds
cannot qualify for a descriptor.

```text
node --test tooling/release/release-channel.test.mjs
```

No installer was built, installed, signed, or published for this prerequisite.

## Remaining release blockers

- Configure and protect the real Windows code-signing identity. No signing key or certificate is
  present or implied by this change.
- Make `publish.mjs` and the future update-feed writer require
  `releaseDescriptorEligible === true`. The existing preview publisher predates this contract and
  must not be used to publish an updater descriptor.
- Define and implement the signed Stable/Beta/Dev feed, atomic resumable download, checksum and
  signature verification, session-aware restart application, rollback, and recovery tests.
