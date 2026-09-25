export type AccountMailPurpose = "signin" | "delete";
export type AccountMailOutcome = "sent" | "ambiguous" | "rejected" | "budget_exhausted" | "invalid";

export interface AccountMailRpcRequest {
  purpose: AccountMailPurpose;
  recipient: string;
  oneTimeProof: string;
  networkHash: string;
  recipientHash: string;
}

export interface AccountMailIdentity {
  networkHash: string;
  recipientHash: string;
}

export interface AccountMailServiceBinding {
  sendAccountEmail(request: AccountMailRpcRequest): Promise<{ outcome: AccountMailOutcome }>;
}

export interface AccountMailer {
  sendSignIn(email: string, verifyToken: string, identity: AccountMailIdentity): Promise<boolean>;
  sendDelete(email: string, verifyToken: string, identity: AccountMailIdentity): Promise<boolean>;
}

export function isAccountMailServiceBinding(value: unknown): value is AccountMailServiceBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sendAccountEmail?: unknown }).sendAccountEmail === "function"
  );
}

/** Adapter from the API auth flow to the website Worker's internal named RPC entrypoint. */
export function serviceBoundAccountMailer(service: AccountMailServiceBinding): AccountMailer {
  async function send(
    email: string,
    oneTimeProof: string,
    purpose: AccountMailPurpose,
    identity: AccountMailIdentity,
  ): Promise<boolean> {
    try {
      const result = await service.sendAccountEmail({ purpose, recipient: email, oneTimeProof, ...identity });
      // A connection failure can occur after Resend accepted the message. Keep that proof usable;
      // the website Worker durably prevents any replay of the same proof.
      return result.outcome === "sent" || result.outcome === "ambiguous";
    } catch {
      // RPC can disconnect after the website Worker and Resend accepted the message. Treat that
      // boundary as ambiguous so the API does not delete a proof that may already be in flight.
      return true;
    }
  }
  return {
    sendSignIn: (email, oneTimeProof, identity) => send(email, oneTimeProof, "signin", identity),
    sendDelete: (email, oneTimeProof, identity) => send(email, oneTimeProof, "delete", identity),
  };
}
