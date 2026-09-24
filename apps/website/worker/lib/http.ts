/** Small JSON response helpers. API responses are never cached. */

export interface ApiError {
  ok: false;
  error: string;
  message: string;
}

export function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
  return response;
}

export function apiError(status: number, error: string, message: string, headers: HeadersInit = {}): Response {
  const body: ApiError = { ok: false, error, message };
  return json(body, status, headers);
}
