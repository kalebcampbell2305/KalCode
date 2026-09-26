# KalCode portable-pty patch

This directory vendors `portable-pty` 0.9.0 from the published crates.io source. Its upstream
repository is `https://github.com/wezterm/wezterm`, path `pty`, source commit
`f8921727a11b9f8b073e8c24821d72fd41283500`. The upstream MIT license is preserved verbatim in
`LICENSE.md`.

KalCode's Windows patch provides the provider-account process-tree invariant that upstream 0.9.0
does not provide:

- create a private Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before process creation;
- assign it atomically through `PROC_THREAD_ATTRIBUTE_JOB_LIST` in the same `CreateProcessW` call
  that attaches ConPTY, before the root process can execute provider instructions;
- enable neither breakaway limit, so ordinary descendants inherit containment;
- after natural root exit, explicit kill, `try_wait`, or `wait`, terminate surviving descendants
  and poll `ActiveProcesses` to zero before reporting completion;
- return an error when bounded quiescence cannot be proved. KalCode's PTY integration then retains
  the provider profile lease fail-closed instead of invoking the exit callback.

The macOS patch adds one deliberately narrow capability: `SlavePty::try_clone_slave_file` returns
an independently owned, close-on-exec duplicate of the native slave descriptor. KalCode transfers
that descriptor only to its trusted custodian, which establishes the session, controlling terminal,
reserved process group, activation barrier, and ordered cleanup. Normal Unix spawning, descriptor
cleanup, command construction, and every Windows source file remain unchanged.

The Job List attribute requires Windows 10 / Windows Server 2016 or newer. ConPTY already requires
a supported Windows 10 release, so the patch does not widen the platform floor. Windows 8+
supports nested Job Objects; an outer-job regression covers launchers and CI runners.

Do not replace this fork with a registry update until the same atomic containment and quiescent
completion guarantees are independently verified in the replacement version.
