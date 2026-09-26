# Native custody review and root privacy

Base: 22b15d9 (pipeline split), after c800aea (native custody recovery).

Physical Apple Silicon failure injection launched the real guardian helper over a private Unix
socket. Immediate SIGKILL after READY but before activation left no reserved group and never
executed the gated root. Immediate SIGKILL after activation also drained a TERM-resistant root
and descendant. The anchor independently detects parent loss / command-pipe HUP, ignores SIGPIPE,
reaps the exact root and terminates its reserved group. No custody algorithm change was needed.

The privacy review reproduced two failures before the fix: new marker directories were 0755;
an initialized, clean, owner-held marker root changed to 0777 was accepted on reopening. No higher
layer enforced root privacy. macOS now creates marker directories with 0700 atomically and rejects
an existing root with any group/other mode bits, without silently changing existing permissions.
Windows creation and validation remain unchanged. The existing malformed-epoch unit fixture now
explicitly creates a private directory so that it continues testing epoch evidence, not permissions.

Physical tests after the fix: seven real macOS guardian integration tests passed, including the
two custodian-death paths, ordinary exit, stubborn timeout, PTY custody, and both privacy tests.
The provider library's existing 203 tests passed with one pre-existing ignored test. A separate
new regression then exposed the pre-existing shared lease-lifetime bug (documented in the next
packet); it does not undermine these scoped results. No signing, installation or publishing.

Existing development data directories created by the prior native prototype may now be rejected.
The operator must inspect their ownership/evidence and explicitly correct the root permissions;
the app must not convert an untrusted writable directory into trusted recovery evidence itself.
Darwin ACL policy is not extended by this narrow POSIX-mode fix.
