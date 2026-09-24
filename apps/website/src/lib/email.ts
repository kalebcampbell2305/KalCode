/**
 * Email normalization and validation shared by the browser forms and the Worker, so the
 * client never accepts an address the server would reject (or the reverse).
 */

export const EMAIL_MAX_LENGTH = 254;
const LOCAL_MAX_LENGTH = 64;
const LABEL_MAX_LENGTH = 63;

// Local part: RFC 5322 "atext" characters separated by single dots (no quoted strings).
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Domain label: letters, digits and inner hyphens.
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Top-level domain: letters only (or an IDNA "xn--" label), at least two characters.
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Trims surrounding whitespace and lowercases. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** Validates an already-normalized address. */
export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) {
    return false;
  }
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) {
    return false;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > LOCAL_MAX_LENGTH || !LOCAL_PART.test(local)) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return false;
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > LABEL_MAX_LENGTH || !DOMAIN_LABEL.test(label)) {
      return false;
    }
  }
  const tld = labels[labels.length - 1] ?? "";
  return TLD.test(tld);
}
