import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const desktop = join(root, "apps/desktop/src-tauri");
const config = JSON.parse(readFileSync(join(desktop, "tauri.conf.json"), "utf8"));

test("Windows installer wires the source-controlled path hook through Tauri", () => {
  const hooks = config.bundle.windows.nsis.installerHooks;
  assert.equal(hooks, "./windows/installer-hooks.nsh");
  assert.ok(existsSync(resolve(desktop, hooks)));
});

if (process.platform === "win32") {
  test("native NSIS removes only owned shortcuts after short-path payload removal", () => {
    const compiler =
      process.env.KALCODE_NSIS_TEST_COMPILER ?? join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
    assert.ok(existsSync(compiler), "the trusted Tauri NSIS compiler must be installed");
    const evidenceRoot = process.env.KALCODE_NSIS_TEST_OUTPUT ?? join(root, "target/nsis-shortpath-tests");
    mkdirSync(evidenceRoot, { recursive: true });
    const workspace = mkdtempSync(join(evidenceRoot, "native-"));
    const output = join(workspace, "fixture.exe");
    const args = ["/V2", `/DOUTPUT=${output}`];
    const hook = config.bundle.windows.nsis.installerHooks;
    if (hook) args.push(`/DHOOK_FILE=${resolve(desktop, hook)}`);
    args.push(join(import.meta.dirname, "fixtures/nsis-shortpath.nsi"));
    const build = spawnSync(compiler, args, { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    assert.equal(build.status, 0, `NSIS compilation failed: ${build.stdout}\n${build.stderr}`);
    const run = spawnSync(output, [], { cwd: dirname(output), windowsHide: true, encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, `native fixture failed: ${run.error?.message ?? run.stderr}`);
    const bytes = readFileSync(join(workspace, "result.ini"));
    const report =
      bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
    const values = Object.fromEntries(
      report
        .split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.notEqual(
      values.short.toLowerCase(),
      values.canonical.toLowerCase(),
      "fixture must actually exercise an 8.3 alias",
    );
    assert.equal(existsSync(values.canonical), false, "payload directory must be gone before shortcut comparison");
    assert.equal(existsSync(join(workspace, "owned.lnk")), false, `owned shortcut survived in ${workspace}`);
    assert.equal(existsSync(join(workspace, "unrelated.lnk")), true, "unrelated shortcut must remain");
    assert.equal(
      values.install.toLowerCase(),
      values.canonical.toLowerCase(),
      "installation registry/shortcut paths must use canonical identity",
    );
    assert.equal(
      values.uninstall.toLowerCase(),
      values.canonical.toLowerCase(),
      "uninstall must canonicalize before deleting payload",
    );
  });
}
