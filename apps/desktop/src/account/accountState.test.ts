import { describe, expect, it } from "vitest";
import { initialAccountUiState, reduceAccountUi } from "./accountState.ts";

describe("account UI reducer", () => {
  it("ignores stale account and runtime results after a newer operation", () => {
    const signedOut = { ...initialAccountUiState.snapshot, phase: "signed_out" as const };
    let state = reduceAccountUi(initialAccountUiState, { type: "begin", generation: 4 });
    state = reduceAccountUi(state, {
      type: "resolved",
      generation: 4,
      snapshot: signedOut,
      runtime: { phase: "signed_out", ready: false },
    });
    state = reduceAccountUi(state, {
      type: "runtime",
      generation: 3,
      runtime: { phase: "ready", ready: true },
    });
    expect(state.snapshot.phase).toBe("signed_out");
    expect(state.runtime.phase).toBe("signed_out");
  });
});
