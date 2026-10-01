import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cargoEnvironment, guardianBuildArguments, runCargo } from "./cargo.mjs";
import { laneArguments } from "./tauri.mjs";

const base = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const dev = JSON.parse(readFileSync(new URL("../src-tauri/tauri.dev.conf.json", import.meta.url), "utf8"));

test("macOS platform config preserves both lane identities", () => {
  const mac = JSON.parse(readFileSync(new URL("../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"));
  for (const lane of [base, dev]) {
    const resolved = { ...base, ...mac, ...lane };
    assert.equal(resolved.identifier, lane.identifier);
    assert.equal(resolved.productName, lane.productName);
    assert.deepEqual(resolved.plugins["deep-link"].desktop.schemes, lane.plugins["deep-link"].desktop.schemes);
  }
  const plist = readFileSync(new URL("../src-tauri/Info.plist", import.meta.url), "utf8");
  assert.doesNotMatch(plist, /CFBundleIdentifier|CFBundleURLTypes|CFBundleName/);
});

test("canonical Cargo test and lint commands select Dev while preserving unrelated overrides", () => {
  const environment = { TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }) };
  for (const args of [
    ["test", "--workspace"],
    ["clippy", "--workspace", "--all-targets"],
  ]) {
    const resolved = JSON.parse(cargoEnvironment(args, environment).TAURI_CONFIG);
    assert.equal(resolved.identifier, dev.identifier);
    assert.deepEqual(resolved.plugins, dev.plugins);
    assert.deepEqual(resolved.bundle, { externalBin: [] });
  }
  assert.equal(cargoEnvironment(["build", "--release"], environment), environment);
  assert.equal(cargoEnvironment(["build", "--profile", "release"], environment), environment);
  assert.equal(JSON.parse(cargoEnvironment(["test", "release"], environment).TAURI_CONFIG).identifier, dev.identifier);
});

test("desktop Cargo tests build the real guardian first with the same output controls", () => {
  const args = [
    "test",
    "--workspace",
    "--target",
    "x86_64-pc-windows-msvc",
    "--target-dir=isolated-target",
    "--profile",
    "test-profile",
    "--locked",
    "--config",
    "net.retry=2",
    "--",
    "--config",
    "a libtest argument",
  ];
  assert.deepEqual(guardianBuildArguments(args), [
    "build",
    "-p",
    "kalcode-providers",
    "--bin",
    "kalcode-provider-guardian",
    "--target",
    "x86_64-pc-windows-msvc",
    "--target-dir=isolated-target",
    "--profile",
    "test-profile",
    "--locked",
    "--config",
    "net.retry=2",
  ]);
  assert.equal(guardianBuildArguments(["test", "-p", "kalcode-providers"]), null);
  assert.equal(guardianBuildArguments(["test", "--workspace", "--exclude", "kalcode-desktop"]), null);
  assert.equal(guardianBuildArguments(["clippy", "--workspace"]), null);

  const calls = [];
  const environment = { CARGO_TARGET_DIR: "D:/isolated", TAURI_CONFIG: "{}" };
  const status = runCargo(
    ["test", "-p", "kalcode-desktop", "--lib", "--no-run"],
    environment,
    (file, commandArgs, options) => {
      calls.push({ file, commandArgs: [...commandArgs], options });
      return { status: 0 };
    },
  );
  assert.equal(status, 0);
  assert.deepEqual(
    calls.map(({ file, commandArgs }) => [file, commandArgs]),
    [
      ["cargo", ["build", "-p", "kalcode-providers", "--bin", "kalcode-provider-guardian"]],
      ["cargo", ["test", "-p", "kalcode-desktop", "--lib", "--no-run"]],
    ],
  );
  assert.equal(calls[0].options.env.CARGO_TARGET_DIR, "D:/isolated");
  assert.equal(calls[1].options.env.CARGO_TARGET_DIR, "D:/isolated");

  const denied = [];
  assert.equal(
    runCargo(["test", "-p", "kalcode-desktop"], environment, (file, commandArgs) => {
      denied.push([file, [...commandArgs]]);
      return { status: 17 };
    }),
    17,
  );
  assert.equal(denied.length, 1, "desktop tests cannot run without the real guardian prerequisite");
});

test("Stable identity remains unchanged and release CLI arguments pass through", () => {
  assert.equal(base.identifier, "com.kalcode.desktop");
  assert.equal(base.productName, "KalCode");
  assert.equal(base.mainBinaryName, "kalcode");
  assert.deepEqual(base.plugins["deep-link"].desktop.schemes, ["kalcode"]);
  const args = ["build", "--no-bundle", "--features", "kalvoice-whisper"];
  assert.deepEqual(laneArguments(args), args);
});

test("dev and debug builds select a distinct identity and only the Dev URL handler", () => {
  assert.deepEqual(laneArguments(["dev", "--", "--features", "e2e"]), [
    "dev",
    "--config",
    "src-tauri/tauri.dev.conf.json",
    "--",
    "--features",
    "e2e",
  ]);
  for (const args of [["dev"], ["build", "--debug"]]) {
    assert.deepEqual(laneArguments(args), [...args, "--config", "src-tauri/tauri.dev.conf.json"]);
  }
  const resolved = { ...base, ...dev };
  assert.equal(resolved.identifier, "com.kalcode.desktop.dev");
  assert.equal(resolved.productName, "KalCode Dev");
  assert.equal(resolved.mainBinaryName, "kalcode-dev");
  assert.deepEqual(resolved.plugins["deep-link"].desktop.schemes, ["kalcode-dev"]);
  assert.equal(resolved.version, base.version);
});
