import assert from "node:assert/strict";
import test from "node:test";
import { windowsProtocolProblems } from "./windows-protocol.mjs";

const exe = "C:\\Users\\QA User\\Applications\\KalCode\\kalcode.exe";
const valid = { exists: true, urlProtocol: true, command: `"${exe}" "%1"` };

test("installed protocol requires the exact quoted executable and URL argument", () => {
  assert.deepEqual(windowsProtocolProblems(valid, exe), []);
  for (const command of [exe, `${exe} "%1"`, `"${exe}" %1`, `"${exe}" "%1" --extra`, '"C:\\other.exe" "%1"', null]) {
    assert.ok(windowsProtocolProblems({ ...valid, command }, exe).length > 0);
  }
});

test("missing protocol key or URL Protocol marker fails closed", () => {
  for (const registration of [null, {}, { ...valid, exists: false }, { ...valid, urlProtocol: false }]) {
    assert.ok(windowsProtocolProblems(registration, exe).length > 0);
  }
});
