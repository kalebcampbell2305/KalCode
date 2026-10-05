import assert from "node:assert/strict";
import test from "node:test";
import { verifyProbeReceipts } from "./gate-worker-probe.mjs";

const identity = { source: "a".repeat(40), run: "123", attempt: "1" };
function receipts() {
  return [1, 2, 3, 4, 5, 6].map((id) => {
    const slot = id - 1;
    const start = Date.UTC(2026, 9, 5) + (id > 4 ? 40_000 : 0);
    return {
      schema: "kalcode-gate-worker-probe/v1",
      fixtureOnly: true,
      productionCandidatePassed: false,
      ...identity,
      host: "DESKTOP-KOOB7VV",
      case: id,
      slot,
      runner: slot === 0 ? "kalcode-win-gate" : `kalcode-win-gate-w${slot}`,
      childPid: 100 + id,
      fixtureSha256: String(id).repeat(64),
      startedAt: new Date(start).toISOString(),
      finishedAt: new Date(start + 30_000).toISOString(),
      exitCode: id === 3 ? 17 : 0,
      state: id === 3 ? "intentional_fixture_failure" : "pass",
    };
  });
}
test("requires four distinct simultaneous workers and preserves the real independent failure", () => {
  const proof = verifyProbeReceipts(receipts(), identity);
  assert.equal(proof.peakDistinctWorkers, 4);
  assert.equal(proof.jobs, 6);
  assert.equal(proof.intentionalFailures, 1);
  assert.equal(proof.productionCandidatePassed, false);
});
test("serialized work never counts as four concurrent physical workers", () => {
  const rows = receipts().map((row, index) => ({
    ...row,
    startedAt: new Date(Date.UTC(2026, 9, 5) + index * 31_000).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 9, 5) + index * 31_000 + 30_000).toISOString(),
  }));
  assert.throws(() => verifyProbeReceipts(rows, identity), /only 1/);
});
test("a momentary four-slot peak does not prove thirty seconds of overlap", () => {
  const rows = receipts();
  const start = Date.parse(rows[3].startedAt) + 29_000;
  rows[3].startedAt = new Date(start).toISOString();
  rows[3].finishedAt = new Date(start + 30_000).toISOString();
  assert.throws(() => verifyProbeReceipts(rows, identity), /at least 30 seconds/);
});
test("reused identities, stale sources and fabricated success are rejected", () => {
  for (const edit of [
    (rows) => {
      rows[0].host = "SECOND-PC";
    },
    (rows) => {
      rows[0].runner = "kalcode-win-gate-2";
    },
    (rows) => {
      rows[0].source = "b".repeat(40);
    },
    (rows) => {
      rows[0].productionCandidatePassed = true;
    },
    (rows) => {
      rows[0].finishedAt = rows[0].startedAt;
    },
    (rows) => {
      rows[2].exitCode = 0;
      rows[2].state = "pass";
    },
    (rows) => {
      rows[1].slot = 0;
      rows[1].runner = "kalcode-win-gate";
    },
    (rows) => {
      rows[0].run = "999";
    },
  ]) {
    const rows = receipts();
    edit(rows);
    assert.throws(() => verifyProbeReceipts(rows, identity));
  }
});
