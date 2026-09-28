import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeRebindRequest,
  expireRebindRequest,
  getRebindRequest,
  getSelectedThread,
  REBIND_REQUEST_TTL_MS,
  requestRebind,
  resetAccountIntentForTests,
  setSelectedThread,
} from "./accountIntent.ts";

const THREAD = "0192f3c4-0000-7000-8000-000000000a01";
const ACCOUNT_B = "0192f3c4-0000-7000-8000-000000000302";

afterEach(() => {
  resetAccountIntentForTests();
  vi.useRealTimers();
});

describe("accountIntent", () => {
  it("tracks the shown thread and ignores identical updates", () => {
    expect(getSelectedThread()).toBeNull();
    setSelectedThread({ threadId: THREAD, providerId: "gemini-cli", providerAccountId: null });
    const first = getSelectedThread();
    setSelectedThread({ threadId: THREAD, providerId: "gemini-cli", providerAccountId: null });
    expect(getSelectedThread()).toBe(first);
    setSelectedThread(null);
    expect(getSelectedThread()).toBeNull();
  });

  it("keeps a rebind request until that exact request is consumed", () => {
    const older = requestRebind(THREAD, ACCOUNT_B);
    const newer = requestRebind(THREAD, ACCOUNT_B);
    expect(newer.nonce).toBeGreaterThan(older.nonce);
    consumeRebindRequest(older.nonce);
    expect(getRebindRequest()).toEqual(newer);
    consumeRebindRequest(newer.nonce);
    expect(getRebindRequest()).toBeNull();
  });

  it("expires an unanswered request after 30 seconds (S4)", () => {
    vi.useFakeTimers();
    const request = requestRebind(THREAD, ACCOUNT_B);
    expect(request.expiresAt - Date.now()).toBe(REBIND_REQUEST_TTL_MS);
    vi.advanceTimersByTime(REBIND_REQUEST_TTL_MS - 1);
    expect(getRebindRequest()).toEqual(request);
    vi.advanceTimersByTime(1);
    expect(getRebindRequest()).toBeNull();
  });

  it("drops a pending request when the person leaves Threads", () => {
    requestRebind(THREAD, ACCOUNT_B);
    expireRebindRequest();
    expect(getRebindRequest()).toBeNull();
  });

  it("a newer request restarts the expiry clock", () => {
    vi.useFakeTimers();
    requestRebind(THREAD, ACCOUNT_B);
    vi.advanceTimersByTime(20_000);
    const newer = requestRebind(THREAD, ACCOUNT_B);
    vi.advanceTimersByTime(20_000);
    expect(getRebindRequest()).toEqual(newer);
    vi.advanceTimersByTime(10_000);
    expect(getRebindRequest()).toBeNull();
  });
});
