# Smart Duplicate Terminal

Use **New like this** in a shell or coding-agent pane's context menu to start an independent session. The default opens beside the source. **New like this in** offers a neighboring pane or a tab and remembers the choice per workspace. At the canvas pane limit, the new session opens as a tab.

Shell copies preserve the workspace, detected shell, current filesystem directory and custom title with a quiet `(copy)` suffix. PowerShell synchronizes its filesystem location at the prompt while retaining the user's original prompt. Ended shells use their saved launch directory. If the live directory cannot be read, duplication reports the problem instead of guessing another directory.

Coding-agent copies resolve the source's saved provider, account, exact selected model, effort, permission mode and directory in native code and start a fresh provider session. A removed account or directory is an error. Copies retain their directory on restart without taking ownership of the source's worktree. Custom permission profiles and archived agents are not offered as duplication sources.

No running-process environment, temporary secrets, terminal input/output, conversation, approval state, provider session identifier, attachment or process handle is copied. Normal launch authentication and shell profiles are loaded through the existing launch path. Since this action does not copy environment state, it does not display a sensitivity preview.

Validation covers real Windows shell processes, PowerShell location handling, transient environment exclusion, independent termination, fresh provider identities and restart directories, placement preferences and the rendered side-by-side UI.
