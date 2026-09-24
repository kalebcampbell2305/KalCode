/** JSON response helpers. Every API response is JSON and carries restrictive headers. */

export interface ApiError {
  ok: false;
  error: string;
  message: string;
}

/** The API serves no documents, so nothing may be framed, scripted or sniffed. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

export function apiError(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const body: ApiError = { ok: false, error, message };
  return json(body, status, headers);
}
