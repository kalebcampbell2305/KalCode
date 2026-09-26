import { isIP } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { networkKey } from "../../worker/lib/router";
import { uniqueIp } from "../e2e/helpers";

afterEach(() => vi.restoreAllMocks());

test("E2E client identities remain distinct when the clock moves between calls", () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(199).mockReturnValueOnce(398);
  expect(uniqueIp()).not.toBe(uniqueIp());
});

test("E2E client identities remain valid and unique throughout a large suite", () => {
  vi.spyOn(Date, "now").mockReturnValue(199);
  const addresses = Array.from({ length: 1000 }, () => uniqueIp());
  expect(addresses.every((address) => isIP(address) !== 0)).toBe(true);
  expect(new Set(addresses).size).toBe(addresses.length);
  expect(new Set(addresses.map(networkKey)).size).toBe(addresses.length);
});
