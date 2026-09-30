import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cargoEnvironment } from "./cargo.mjs";
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

test("Stable identity remains unchanged and release CLI arguments pass through", () => {
  assert.equal(base.identifier, "com.kalcode.desktop");
  assert.equal(base.productName, "KalCode");
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
  assert.deepEqual(resolved.plugins["deep-link"].desktop.schemes, ["kalcode-dev"]);
  assert.equal(resolved.version, base.version);
});
