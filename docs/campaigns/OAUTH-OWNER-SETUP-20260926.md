# Production OAuth owner setup

Values were traced at release repair commit `91166fa79e0deeb47147a27e43df5c0497599408` in `apps/api/worker/lib/env.ts` and `openid-connect.ts`. Registration is owner work; secrets must never be pasted into chat or committed. The API performs a confidential authorization-code exchange with S256 PKCE and nonce verification.

## Google

- Use an owner-controlled Google Cloud project for production (suggested name: KalCode Production; the project name is not hard-coded).
- Configure Google Auth Platform branding as KalCode and audience External. Configure a Web application OAuth client.
- Authorized redirect URI: `https://api.kalcoded.com/v1/auth/google/callback`.
- Authorized JavaScript origins: none required by this implementation. It uses a server callback, not the Google JavaScript SDK.
- Development redirect URIs: none supported by the current production configuration; do not invent a localhost callback.
- Requested scopes: `openid email`. No Gmail, Drive, profile, or offline-access scope is required.
- Both client ID and client secret are required. Bind them securely on Worker `kalcode-api` as `GOOGLE_OIDC_CLIENT_ID` and `GOOGLE_OIDC_CLIENT_SECRET`.
- Consent homepage: `https://kalcoded.com/`; privacy policy: `https://kalcoded.com/privacy`; terms: `https://kalcoded.com/terms`. Authorized domain: `kalcoded.com`. Supply owner-monitored support/developer email addresses.
- Add test users while testing. Move the audience to production before customer rollout and complete domain/brand verification requested by Google. Do not claim verification merely because a client was created.

## Microsoft

- Create a Microsoft Entra application registration in the owner's standard workforce directory, named KalCode Production or another owner-chosen name.
- Supported account types: accounts in any organizational directory and personal Microsoft accounts (`AzureADandPersonalMicrosoftAccount`). The implementation uses the `common/v2.0` discovery endpoint.
- Add the Web platform with redirect URI `https://api.kalcoded.com/v1/auth/microsoft/callback`.
- Do not add a mobile/desktop platform for this server callback. Leave public-client flows and implicit-grant access/ID token options disabled.
- Development redirect URIs: none supported by the current production configuration.
- Requested scopes: `openid email`. No Microsoft Graph `User.Read` or `offline_access` permission is needed by this flow.
- Both application client ID and a client secret **value** are required; the secret ID is not the credential. Bind securely on Worker `kalcode-api` as `MICROSOFT_OIDC_CLIENT_ID` and `MICROSOFT_OIDC_CLIENT_SECRET`. Record expiration for rotation.
- Request ID-token optional claims `email` and `xms_edov`, preserving any existing optional claims. The current validator requires boolean `xms_edov: true`; requesting the claim does not make an unverified email verified. Actual personal and organizational login must prove compatibility before rollout.

```json
{
  "optionalClaims": {
    "idToken": [
      { "name": "email", "source": null, "essential": false, "additionalProperties": [] },
      { "name": "xms_edov", "source": null, "essential": false, "additionalProperties": [] }
    ]
  }
}
```

## Shared architecture and handoff

One confidential registration per provider is sufficient for desktop and website sessions. Both use the same API callback. Do not register `kalcode://auth/google` or `kalcode://auth/microsoft` with the providers: those are internal desktop handoffs after the HTTPS callback. Website social sign-in is integrated in the release candidate; production deployment and live provider verification remain outstanding.

Owner update: both production registrations now exist. Preserve their current production client IDs. The previous Google client secret was exposed during owner setup and must not be used; the owner is replacing it directly in the encrypted `GOOGLE_OIDC_CLIENT_SECRET` Worker binding. Microsoft client-secret creation/configuration remains owner work unless already completed. Wait for explicit owner confirmation that all four bindings are configured, then inspect binding names only and run production verification. Do not retrieve, print, log, or request secret values.

Store secrets in an owner-controlled password manager or protected local file outside the repository, or set the named Cloudflare bindings directly. Report only the storage location/account or that bindings are configured. No password, secret, private key, or 2FA value is needed in chat. Registration completion permits secure binding, migrations, deployment, and live OAuth verification; it is not itself a successful login proof.

Provider references: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Google brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [Entra app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [Microsoft optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference), [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
