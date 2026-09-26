# Preserve session leases across completed provider turns

Base: 8ae26cb. Shared marker code already cleared every capability holder when the last process
job became CLEAN before the Mac recovery packet. A real guarded Gemini two-turn integration
exposed the defect: the first turn completed, then the second failed with an expired guardian lease.
A new platform-independent marker regression also failed because exclusive account authentication
was admitted while the original session lease was still alive.

Fix: CLEAN retires process custody while capability holders remain until explicit lease release.
Generation sealing still rejects new jobs. The regression checks two successive jobs, exclusive
account fencing between turns, rejection of the released lease, and successful exclusive access
after explicit release. The macOS Gemini fixture now provisions the real bundled guardian; it
does not disable any production safety checks. Windows fixture setup is unchanged.

Physical Mac verification: 204 provider library tests passed, one pre-existing ignore; two Gemini
managed policy tests passed, including both turns; seven native guardian tests and three guardian
contract tests passed. Additional account-binding and fake-version tests passed. The broader
provider invocation reached interactive.rs, where nine tests passed and one version-rejection
fixture failed (still missing guardian setup); later test binaries were not reached. Full native
suite success is not claimed. Parent must reprove the shared marker change on Windows.

The signed-candidate/resume packet was also executed as tests on the physical Mac: all 74 release
tests passed with ordinary TMPDIR. No signing, notarization or publication occurred during these
tests. Mac evidence logs remain in ~/Developer/KalCode-codex3-native-qa, without credentials or
real provider transcripts.
