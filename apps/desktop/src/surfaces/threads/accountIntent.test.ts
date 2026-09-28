import { afterEach, describe, expect, it } from "vitest";
import {
  consumeRebindRequest,
  getRebindRequest,
  getSelectedThread,
  requestRebind,
  resetAccountIntentForTests,
  setSelectedThread,
} from "./accountIntent.ts";

const THREAD = "0192f3c4-0000-7000-8000-000000000a01";
const ACCOUNT_B = "0192f3c4-0000-7000-8000-000000000302";

afterEach(() => resetAccountIntentForTests());

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
});
