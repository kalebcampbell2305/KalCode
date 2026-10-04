import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Exercise the real CLI/file discovery, without writing fixtures into product source trees.
function scan(source, extension = "rs", fileOverride) {
  const directory = mkdtempSync(join(tmpdir(), "kalcode-zero-cost-"));
  try {
    mkdirSync(join(directory, "tooling"));
    copyFileSync(new URL("./check-zero-cost.mjs", import.meta.url), join(directory, "tooling/check-zero-cost.mjs"));
    const file = fileOverride ?? `crates/example/src/lib.${extension}`;
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), source);
    execFileSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true });
    const result = spawnSync(process.execPath, ["tooling/check-zero-cost.mjs"], {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.ifError(result.error);
    return { ...result, file };
  } finally {
    // This exact freshly created temporary directory is the only cleanup target.
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  }
}

const forbidden = 'fn production() { let _ = "api.openai.com"; }';
const testModule = '#[cfg(test)]\nmod tests {\n  fn fixture() { let _ = "OPENAI_API_KEY"; }\n}';

test("user-funded integration endpoint exception cannot enable company keys or other callers", () => {
  const file = "crates/integration-openai/src/lib.rs";
  const endpoint = 'const ENDPOINT: &str = "https://api.openai.com/v1/responses";';
  assert.equal(scan(endpoint, "rs", file).status, 0);
  assert.equal(scan(endpoint).status, 1);
  assert.equal(scan(`${endpoint}\nstd::env::var("OPENAI_API_KEY");`, "rs", file).status, 1);
  assert.equal(scan(`${endpoint} read_company_key("OPENAI_API_KEY");`, "rs", file).status, 1);
});

test("a whole module explicitly compiled only for tests may contain credential fixtures", () => {
  const result = scan('#![cfg(test)]\nfn fixture() { let _ = "OPENAI_API_KEY"; }');
  assert.equal(result.status, 0, result.stderr);
});

test("the audited account-auth credential removal is allowed but reads and assignments remain forbidden", () => {
  const file = "crates/providers/src/account_auth.rs";
  assert.equal(scan('remove_env(&mut env, "OPENAI_API_KEY");', "rs", file).status, 0);
  assert.equal(scan('std::env::var("OPENAI_API_KEY");', "rs", file).status, 1);
  assert.equal(scan('env.insert("OPENAI_API_KEY", value);', "rs", file).status, 1);
  assert.equal(scan('remove_env(&mut env, "OPENAI_API_KEY"); call("api.openai.com");', "rs", file).status, 1);
  assert.equal(scan('remove_env(&mut env, "OPENAI_API_KEY");').status, 1);
  const usage = "crates/providers/src/usage.rs";
  const usageUrl = 'const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";';
  assert.equal(scan(usageUrl, "rs", usage).status, 0);
  assert.equal(scan(usageUrl).status, 1);
  assert.equal(scan('const URL: &str = "https://api.anthropic.com/v1/messages";', "rs", usage).status, 1);
});

test("production after an inline test module is still scanned at its original line", () => {
  const result = scan(`${testModule}\n${forbidden}\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /crates\/example\/src\/lib.rs:5:/);
  assert.doesNotMatch(result.stderr, /lib.rs:3:/);
});

test("legitimate inline test fixtures remain exempt", () => {
  assert.equal(scan(`fn safe() {}\n${testModule}`).status, 0);
});

for (const item of ["use super::fixture;", "mod external;", "fn helper() {}", "const FLAG: bool = true;"]) {
  test(`a test-only ${item.split(" ")[0]} item cannot hide later production`, () => {
    const result = scan(`#[cfg(test)]\n${item}\n${forbidden}`);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /lib.rs:3:/);
  });
}

test("multiple test modules do not hide production between or after them", () => {
  const result = scan(`${testModule}\n${forbidden}\n${testModule}\n${forbidden}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lib.rs:5:/);
  assert.match(result.stderr, /lib.rs:10:/);
});

test("visibility, nested blocks and comments in test module headers remain supported", () => {
  const result = scan('#[cfg ( test )]\n// fixture\npub(crate) mod tests { if true { let _ = "OPENAI_API_KEY"; } }');
  assert.equal(result.status, 0, result.stderr);
});

for (const literal of ['"}"', '"\\"{"', 'r###"} " {"###', "'}'", "'\\u{7b}'", "b'{'"]) {
  test(`test-module boundaries ignore braces in ${literal}`, () => {
    const result = scan(`#[cfg(test)]\nmod tests { let _ = ${literal}; let _ = "OPENAI_API_KEY"; }\n${forbidden}`);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /lib.rs:3:/);
    assert.doesNotMatch(result.stderr, /lib.rs:2:/);
  });
}

test("nested block comments cannot extend the excluded module", () => {
  const result = scan(`#[cfg(test)]\nmod tests { /* { /* } */ } */ let _ = "OPENAI_API_KEY"; }\n${forbidden}`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /lib.rs:3:/);
  assert.doesNotMatch(result.stderr, /lib.rs:2:/);
});

test("lifetime apostrophes do not consume braces as character strings", () => {
  const result = scan(
    `#[cfg(test)]\nmod tests { fn fixture<'a>(s: &'a str) { let _ = "OPENAI_API_KEY"; } }\n${forbidden}`,
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /lib.rs:3:/);
  assert.doesNotMatch(result.stderr, /lib.rs:2:/);
});

for (const wrapper of [(text) => `/*\n${text}\n*/`, (text) => `const HELP: &str = r#"\n${text}\n"#;`]) {
  test("a cfg(test) lookalike in a comment or literal does not exempt following production", () => {
    const result = scan(`${wrapper("#[cfg(test)]\nmod tests {")}\n${forbidden}\n}`);
    assert.equal(result.status, 1, result.stdout);
  });
}

test("an unclosed test module remains scanned rather than exempting the rest", () => {
  assert.equal(scan(`#[cfg(test)]\nmod tests {\n${forbidden}`).status, 1);
});

test("production before test modules and non-Rust files remain scanned", () => {
  assert.equal(scan(`${forbidden}\n${testModule}`).status, 1);
  assert.equal(scan(`// #[cfg(test)]\nconst endpoint = "api.openai.com";`, "ts").status, 1);
});
