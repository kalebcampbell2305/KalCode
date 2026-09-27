import assert from "node:assert/strict";
import { cpSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageComponentNotices, verifyComponentNotices } from "./component-notices.mjs";

const noticeDirectory = join(import.meta.dirname, "..", "..", "third_party", "kalvoice-notices");

test("the checked-in KalVoice notice corpus matches every pinned component", async () => {
  const evidence = await verifyComponentNotices({ noticeDirectory });
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    noticeCount: 4,
    componentCount: 7,
    files: [
      "llama.cpp-MIT.txt",
      "llvm-openmp-Apache-2.0-WITH-LLVM-exception.txt",
      "openai-whisper-model-weights-MIT.txt",
      "qwen3.5-0.8b-Apache-2.0.txt",
    ],
  });
});

test("notice verification rejects changed bytes and closed-manifest substitutions", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-notices-tamper-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(noticeDirectory, root, { recursive: true });
  writeFileSync(join(root, "llama.cpp-MIT.txt"), "changed notice");
  await assert.rejects(verifyComponentNotices({ noticeDirectory: root }), /digest/);

  cpSync(noticeDirectory, root, { recursive: true, force: true });
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.notices[0].downloadAtRuntime = true;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyComponentNotices({ noticeDirectory: root }), /field set/);
});

test("notice staging creates one exact non-overwriting bundle resource", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-notices-stage-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, "notices");
  const evidence = await stageComponentNotices({ destination, noticeDirectory });
  assert.equal(evidence.noticeCount, 4);
  assert.deepEqual(await verifyComponentNotices({ noticeDirectory: destination }), evidence);
  await assert.rejects(stageComponentNotices({ destination, noticeDirectory }), /already exists/);
});

test("notice verification rejects a hard-linked source corpus", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kalcode-notices-hardlink-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const corpus = join(root, "corpus");
  cpSync(noticeDirectory, corpus, { recursive: true });
  linkSync(join(corpus, "llama.cpp-MIT.txt"), join(root, "external-link.txt"));
  await assert.rejects(verifyComponentNotices({ noticeDirectory: corpus }), /hard link/);
});
