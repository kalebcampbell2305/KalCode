import { describe, expect, it } from "vitest";
import { buildStampData, STAMP_PATH } from "../../scripts/build-stamp.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const fixedNow = () => Date.parse("2026-09-29T12:00:00.000Z");

describe("website build stamp", () => {
  it("is served from /.well-known/kalcode-build.json", () => {
    expect(STAMP_PATH).toBe(".well-known/kalcode-build.json");
  });

  it("records the git commit, a clean tree and the build time", () => {
    const calls: string[][] = [];
    const git = (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "rev-parse" ? SHA : "";
    };
    expect(buildStampData({ cwd: ".", env: {}, now: fixedNow, git })).toEqual({
      schema: "kalcode-build/v1",
      app: "website",
      commit: SHA,
      dirty: false,
      builtAt: "2026-09-29T12:00:00.000Z",
    });
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["status", "--porcelain", "--untracked-files=no"],
    ]);
  });

  it("marks uncommitted tracked changes as dirty", () => {
    const git = (_cwd: string, args: string[]) => (args[0] === "rev-parse" ? SHA : " M src/pages/index.astro");
    expect(buildStampData({ cwd: ".", env: {}, now: fixedNow, git }).dirty).toBe(true);
  });

  it("prefers a valid KALCODE_BUILD_COMMIT and ignores an invalid one", () => {
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const git = () => SHA;
    expect(
      buildStampData({ cwd: ".", env: { KALCODE_BUILD_COMMIT: other.toUpperCase() }, now: fixedNow, git }).commit,
    ).toBe(other);
    expect(buildStampData({ cwd: ".", env: { KALCODE_BUILD_COMMIT: "main" }, now: fixedNow, git }).commit).toBe(SHA);
  });

  it("never fails the build without git: the commit is null", () => {
    const stamp = buildStampData({ cwd: ".", env: {}, now: fixedNow, git: () => null });
    expect(stamp.commit).toBeNull();
    expect(stamp.dirty).toBe(false);
  });

  it("holds only public build facts", () => {
    const stamp = buildStampData({ cwd: ".", env: { SECRET_TOKEN: "x" }, now: fixedNow, git: () => SHA });
    expect(Object.keys(stamp).sort()).toEqual(["app", "builtAt", "commit", "dirty", "schema"]);
  });
});
