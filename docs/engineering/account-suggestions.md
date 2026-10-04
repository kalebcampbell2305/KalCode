# Account suggestions in Code

Code shows a compact suggestion when the bound account needs sign-in,
has been removed, or has less than 20% remaining in a current provider
usage window. It reads the shared account registry and usage state. Unknown, stale, expired,
malformed, or mismatched account readings never imply a limit. Model-specific Claude windows
apply only to the agent's selected model.

A structured provider rate-limit, authentication, billing, or account-hold failure on the
current failed turn can also trigger advice without numeric usage. Raw terminal text is never
parsed for a quota. Previous turn failures stop triggering advice once the agent resumes.

Alternatives must be active, signed-in accounts of the same provider. A passive metadata
check or refresh failure does not erase known sign-in; its incomplete status is disclosed.
Accounts with known low quota are excluded. Known
headroom ranks before unavailable usage; the user's explicit default follows, then account
name. **Why this account?** explains this ordering. Unexposed usage is labelled unavailable.
The provider remains authoritative for actual model access and launch eligibility.

**Continue with…?** previews the existing account confirmation. Only **Start with…** creates
a fresh account-isolated coding session with the original workspace, directory, model,
effort, and permissions. The original agent stays open under its original account; provider
conversation history and credentials are not transferred. Account and permission checks run
again through the canonical creation path. Dismissal and cancellation launch nothing.

**Make … default** is a separate explicit action in Code's account picker. Suggestions and
launch confirmations never write the default themselves. Failed preference writes remain
visible and do not create a session.

The React implementation is shared by Windows and macOS. Targeted coverage includes the
pure ranking model, account isolation, changing account availability during confirmation,
preference writes, and the Code browser flow with accessibility and compact-layout checks.
