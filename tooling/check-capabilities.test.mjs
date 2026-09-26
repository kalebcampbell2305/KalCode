// Tests for check-capabilities.mjs: runs the checker against copies of the real desktop app's
// build.rs, lib.rs and capability files, each mutated to one way a grant could widen.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkCapabilities } from "./check-capabilities.mjs";

const real = fileURLToPath(new URL("../apps/desktop/src-tauri/", import.meta.url));
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A fixture copy of the app's capability inputs. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kalcode-capcheck-"));
  temps.push(root);
  cpSync(join(real, "build.rs"), join(root, "build.rs"));
  mkdirSync(join(root, "src"));
  cpSync(join(real, "src", "command_registry.rs"), join(root, "src", "command_registry.rs"));
  cpSync(join(real, "src", "lib.rs"), join(root, "src", "lib.rs"));
  cpSync(join(real, "capabilities"), join(root, "capabilities"), { recursive: true });
  cpSync(join(real, "test-capabilities"), join(root, "test-capabilities"), { recursive: true });
  return root;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const problemsOf = (root) => checkCapabilities(root).problems;

test("the real app passes", () => {
  assert.deepEqual(problemsOf(real), []);
});

test("a clean copy passes", () => {
  assert.deepEqual(problemsOf(fixture()), []);
});

test("a second capability file fails", () => {
  const root = fixture();
  writeJson(join(root, "capabilities", "extra.json"), {
    identifier: "extra",
    windows: ["main"],
    permissions: ["core:event:default"],
  });
  assert.match(problemsOf(root).join("\n"), /capabilities\/extra\.json: not an allowed capability file/);
});

test("capability files in subfolders and other formats fail too", () => {
  const root = fixture();
  mkdirSync(join(root, "capabilities", "nested"));
  writeFileSync(join(root, "capabilities", "nested", "shell.toml"), 'identifier = "shell"\n');
  writeFileSync(join(root, "capabilities", "wide.json5"), "{}");
  const problems = problemsOf(root).join("\n");
  assert.match(problems, /capabilities\/nested\/shell\.toml/);
  assert.match(problems, /capabilities\/wide\.json5/);
});

test("an extra permission in main.json fails", () => {
  const root = fixture();
  const path = join(root, "capabilities", "main.json");
  const main = readJson(path);
  main.permissions.push("shell:allow-execute");
  writeJson(path, main);
  assert.match(problemsOf(root).join("\n"), /unexpected permissions: shell:allow-execute/);
});

test("a command without a grant fails", () => {
  const root = fixture();
  const path = join(root, "capabilities", "main.json");
  const main = readJson(path);
  main.permissions = main.permissions.filter((p) => p !== "allow-thread-send");
  writeJson(path, main);
  assert.match(problemsOf(root).join("\n"), /commands without a grant: allow-thread-send/);
});

test("granting a test hook from capabilities/ fails", () => {
  const root = fixture();
  const path = join(root, "capabilities", "main.json");
  const main = readJson(path);
  main.permissions.push("allow-test-permission-probe");
  writeJson(path, main);
  assert.match(problemsOf(root).join("\n"), /main\.json: grants test hooks: allow-test-permission-probe/);
});

test("a test hook listed in COMMANDS (shipped builds) fails", () => {
  const root = fixture();
  const path = join(root, "src", "command_registry.rs");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "const COMMANDS: &[&str] = &[",
      'const COMMANDS: &[&str] = &[\n    "test_permission_probe",',
    ),
  );
  assert.match(problemsOf(root).join("\n"), /test hooks listed in COMMANDS \(would ship\): test_permission_probe/);
});

test("registering a test hook without the test-hook cfg fails", () => {
  const root = fixture();
  const path = join(root, "src", "lib.rs");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      /#\[cfg\(any\(debug_assertions, feature = "e2e"\)\)\]\r?\n(\s*permission_commands::test_permission_probe,)/,
      "$1",
    ),
  );
  assert.match(problemsOf(root).join("\n"), /test hook test_permission_probe is registered without/);
});

test("the test-hook capability may grant only test hooks, to the main webview", () => {
  const root = fixture();
  const path = join(root, "test-capabilities", "test-hooks.json");
  const hooks = readJson(path);
  hooks.permissions.push("allow-thread-send");
  hooks.webviews = ["*"];
  hooks.remote = { urls: ["https://example.com/*"] };
  writeJson(path, hooks);
  const problems = problemsOf(root).join("\n");
  assert.match(problems, /test-hooks\.json: unexpected permissions: allow-thread-send/);
  assert.match(problems, /test-hooks\.json: must target only the main webview/);
  assert.match(problems, /test-hooks\.json: must not grant remote URLs/);
});

test("main.json must stay on the main webview and local content", () => {
  const root = fixture();
  const path = join(root, "capabilities", "main.json");
  const main = readJson(path);
  main.webviews = ["main", "other"];
  main.remote = { urls: ["https://example.com/*"] };
  writeJson(path, main);
  const problems = problemsOf(root).join("\n");
  assert.match(problems, /main\.json: must target only the main webview/);
  assert.match(problems, /main\.json: must not grant remote URLs/);
});

for (const file of ["capabilities/main.json", "test-capabilities/test-hooks.json"]) {
  test(`${file} rejects window-wide grants even with a main webview selector`, () => {
    const root = fixture();
    const path = join(root, file);
    const capability = readJson(path);
    capability.windows = ["main"];
    capability.webviews = ["main"];
    writeJson(path, capability);
    assert.match(problemsOf(root).join("\n"), /must not target windows/);
  });
  test(`${file} rejects child and wildcard webview grants`, () => {
    for (const webviews of [["*"], ["main", "browser-1"]]) {
      const root = fixture();
      const path = join(root, file);
      const capability = readJson(path);
      delete capability.windows;
      capability.webviews = webviews;
      writeJson(path, capability);
      assert.match(problemsOf(root).join("\n"), /must target only the main webview/);
    }
  });
}
