import assert from "node:assert/strict";
import test from "node:test";

import {
  appVersion,
  releaseCommit,
  releaseFileVersion,
  releaseVersion,
  releaseVersionOverlay,
  splitReleaseVersion,
} from "./lib.mjs";

test("a release version is the public version plus an optional canonical build number", () => {
  assert.deepEqual(splitReleaseVersion("0.1.7"), { publicVersion: "0.1.7", build: 0 });
  assert.deepEqual(splitReleaseVersion("0.1.7+779"), { publicVersion: "0.1.7", build: 779 });
  assert.deepEqual(splitReleaseVersion("0.1.8-beta.1+5"), { publicVersion: "0.1.8-beta.1", build: 5 });
  assert.deepEqual(splitReleaseVersion("0.1.7+65535"), { publicVersion: "0.1.7", build: 65_535 });
  for (const invalid of ["0.1.7+0", "0.1.7+0779", "0.1.7+abc", "0.1.7+1.2", "0.1.7+", "v0.1.7", "0.1", "0.1.7+65536"]) {
    assert.throws(() => splitReleaseVersion(invalid), /release/, invalid);
  }
});

test("artifact file names never contain the build separator", () => {
  assert.equal(releaseFileVersion("0.1.7"), "0.1.7");
  assert.equal(releaseFileVersion("0.1.7+779"), "0.1.7_build779");
  assert.match(releaseFileVersion("0.1.7+779"), /^[A-Za-z0-9._-]+$/);
});

function fakeGit({ shallow = "false", head = "h", parents = {}, changes = {}, counts = {} }) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    const [command, ...rest] = args;
    if (command === "rev-parse" && rest[0] === "--is-shallow-repository") return shallow;
    if (command === "rev-parse" && rest[0] === "HEAD") return head;
    if (command === "rev-parse" && rest[0] === "--verify") {
      const parent = parents[rest[2].slice(0, -2)];
      if (parent === undefined) throw new Error("no parent");
      return parent;
    }
    if (command === "diff") return (changes[rest.find((arg) => !arg.startsWith("--"))] ?? []).join("\n");
    if (command === "rev-list") return String(counts[rest[1]]);
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  run.calls = calls;
  return run;
}

test("the release commit skips release-notes-only commits so build and publish agree", () => {
  const git = fakeGit({
    head: "notes2",
    parents: { notes2: "notes1", notes1: "build", build: "older" },
    changes: {
      notes1: ["docs/releases/0.1.7+779.md"],
      build: ["docs/releases/0.1.7+779.md", "docs/releases/0.1.7+779.md"],
      older: ["crates/updater/src/lib.rs", "docs/releases/0.1.7+779.md"],
    },
    counts: { build: 779 },
  });
  assert.equal(releaseCommit(git), "build");
  assert.equal(releaseVersion(git), `${appVersion()}+779`);

  const plain = fakeGit({ head: "build", parents: {}, counts: { build: 12 } });
  assert.equal(releaseCommit(plain), "build");

  const code = fakeGit({
    head: "build",
    parents: { build: "older" },
    changes: { older: ["apps/desktop/src/App.tsx"] },
  });
  assert.equal(releaseCommit(code), "build");
});

test("a shallow clone cannot number a release", () => {
  assert.throws(() => releaseCommit(fakeGit({ shallow: "true" })), /shallow/);
});

test("the build overlay stamps the runtime version and the macOS bundle build number only", () => {
  const version = `${appVersion()}+779`;
  assert.deepEqual(releaseVersionOverlay(version), { version, bundle: { macOS: { bundleVersion: "779" } } });
  assert.deepEqual(releaseVersionOverlay(appVersion()), { version: appVersion() });
  assert.throws(() => releaseVersionOverlay("99.0.0+1"), /checked-in version/);
});
