# Browser account authority repair

Base: `b32b8fa`; branch: `codex3/browser-authority-repair`.

Recovery tests referenced a missing profile authority helper and a three-argument native label, while production profiles remained shared across KalCode accounts in the same workspace. This packet repairs the security behavior instead of deleting those assertions.

## Implementation

- Read account ID exclusively from the native runtime snapshot, with the command lease revalidated before and after the read.
- Use domain-separated SHA-256 account directories under browser-data, with independent workspace subdirectories. Existing unowned browser-data/workspace cookies remain untouched and are not adopted into an account. Users must sign into those websites again.
- Bind child labels to native account generation and page lease; retain the creating generation for cleanup. Reject replacing a retained record with another account generation.
- Rotate page lease at the beginning of native close-all, including logout cleanup. Old callbacks and delayed close completion cannot mutate the next account's record. Existing cleanup failures still block runtime replacement.
- Scope browser bridge to mounted LoadedCanvas and capture its page lease immediately. Old bridges never refresh into the next account; AccountGate runtime transitions unmount the canvas. No frontend account ID is trusted.

## Verification

- Recovered compile failure: four missing helper references and four invalid label arities. Repaired production source builds.
- Additional unused-old-bridge regression observed RED with lazy lease capture, then GREEN with immediate capture.
- Full Windows desktop library suite: **180 passed**, including browser, account runtime, signed component provisioning, retained worker cleanup, and provider authority tests. Built standalone guardian fixture before the full run. Earlier broad browser substring run passed 19 tests but selected an unrelated provider fixture that lacked this binary; that prerequisite was corrected and the full suite passed.
- Browser/Code/AccountGate frontend unit suites: **65 passed in 9 files**.
- Desktop TypeScript, changed-file Biome, workspace Rust format, and git diff whitespace checks pass.
- Tests include account/profile persistence and separation, untouched legacy cookies, static linked workspace rejection, retained-generation refusal, delayed cleanup fencing, and both used/unused old bridge lease capture.

## Review and limits

Parent independently reviewed the scoped native/profile/bridge lifetime diff without a blocking finding; immediate-capture delta was sent for final review. Existing static directory/reparse validation remains; this packet does not claim resistance to an adversarial same-OS-user directory swap during native WebView creation. No physical WebView cookie E2E, platform installer, signing, publishing, or deployment was performed. The dist/index.html in this worktree is ignored and only a Rust compilation fixture, not a release artifact.

Integrate this packet before the final native workspace and browser/account E2E gates. The new profile layout deliberately starts clean website sessions for existing installations.
