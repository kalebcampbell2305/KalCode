import assert from "node:assert/strict";
import test from "node:test";

import { acceptedNotaryLog } from "./macos-contract.mjs";

const submission = "12345678-1234-4234-8234-123456789abc";

test("accepted notarization permits an explicit null or empty issues collection", () => {
  for (const issues of [null, []]) {
    const log = { jobId: submission, status: "Accepted", issues };
    assert.equal(acceptedNotaryLog(log, submission), true);
    assert.equal(acceptedNotaryLog(JSON.stringify(log), submission), true);
  }
});

test("notarization rejects missing, malformed, or nonempty issues", () => {
  for (const issues of [undefined, false, 0, "", "null", {}, [{ severity: "warning" }], [{ severity: "error" }]]) {
    assert.throws(() => acceptedNotaryLog({ jobId: submission, status: "Accepted", issues }, submission), {
      code: "notary_log_failed",
    });
  }
  assert.throws(() => acceptedNotaryLog({ jobId: submission, status: "Accepted" }, submission), {
    code: "notary_log_failed",
  });
});

test("null issues cannot bypass the exact submission and Accepted status checks", () => {
  for (const status of [undefined, "Invalid", "Rejected", "In Progress", "accepted"]) {
    assert.throws(() => acceptedNotaryLog({ jobId: submission, status, issues: null }, submission), {
      code: "notary_log_failed",
    });
  }
  for (const jobId of [undefined, "aaaaaaaa-1234-4234-8234-123456789abc"]) {
    assert.throws(() => acceptedNotaryLog({ jobId, status: "Accepted", issues: null }, submission), {
      code: "notary_log_failed",
    });
  }
});
