import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  COMPONENT_ORIGIN,
  canonicalComponentArtifactUrl,
  validateComponentContract,
  WINDOWS_RUNTIME_CODE_MEMBERS,
} from "./component-contract.mjs";

const contractPath = join(import.meta.dirname, "components", "kalvoice-local-reasoning-v1.json");

function contract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

test("the checked-in component contract pins the real KalCode origin and exact Windows closure", () => {
  const parsed = validateComponentContract(contract());
  assert.equal(parsed.artifactOrigin, COMPONENT_ORIGIN);
  assert.equal(parsed.runtime.componentId, "kalvoice.runtime.llama-cpp");
  assert.equal(parsed.runtime.runtimeAbi, "kalvoice-llama-cpp.v1");
  assert.equal(parsed.runtime.windowsX86_64.source.file, "llama-b11146-bin-win-cpu-x64.zip");
  assert.match(
    parsed.runtime.windowsX86_64.source.url,
    /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b11146\//,
  );
  assert.equal(parsed.runtime.windowsX86_64.source.sizeBytes, 18_560_055);
  assert.equal(parsed.runtime.windowsX86_64.extractEntries.length, 23);
  assert.equal(parsed.runtime.windowsX86_64.codeEntries.length, 22);
  assert.equal(parsed.runtime.windowsX86_64.ignoreEntries.length, 28);
  assert.equal(parsed.runtime.windowsX86_64.sourceEntries.length, 51);
  assert.deepEqual(parsed.runtime.windowsX86_64.codeEntries, WINDOWS_RUNTIME_CODE_MEMBERS);
  assert.equal(parsed.reasoningModel.componentId, "kalvoice.reasoner.qwen3-5-0-8b-q8");
  assert.equal(parsed.reasoningModel.source.file, "Qwen3.5-0.8B-Q8_0.gguf");
  assert.equal(parsed.reasoningModel.source.sizeBytes, 833_592_096);
  assert.equal(parsed.reasoningModel.source.sha256, "37ae482d336108d23516fa35e8e0c4126688d81018b87178a18d752a1357814f");
  assert.equal(parsed.speechModels.runtimeAbi, "kalvoice-whisper-ggml.v1");
  assert.equal(
    parsed.speechModels.license.noticeUrl,
    "https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE",
  );
  assert.equal(
    parsed.speechModels.license.noticeSha256,
    "b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d",
  );
  assert.equal(parsed.speechModels.defaultComponentId, "kalvoice.speech.whisper.tiny-en");
  assert.equal(parsed.speechModels.components.length, 5);
});

test("component artifact URLs are derived from signed identity fields and exact bytes", () => {
  assert.equal(
    canonicalComponentArtifactUrl({
      kind: "runtime",
      componentId: "kalvoice.runtime.llama-cpp",
      version: "0.5.0-b11146",
      sha256: "a".repeat(64),
      file: "runtime.zip",
    }),
    `https://kalcoded.com/components/v1/runtime/kalvoice.runtime.llama-cpp/0.5.0-b11146/${"a".repeat(64)}/runtime.zip`,
  );
  assert.throws(
    () =>
      canonicalComponentArtifactUrl({
        kind: "runtime",
        componentId: "../escape",
        version: "1.0.0",
        sha256: "a".repeat(64),
        file: "runtime.zip",
      }),
    /componentId/,
  );
});

test("the component source contract is closed and rejects substitutions", () => {
  const base = contract();
  assert.throws(() => validateComponentContract({ ...base, publicKey: "forbidden" }), /unknown field/);
  assert.throws(
    () => validateComponentContract({ ...base, artifactOrigin: "https://models.kalcoded.com" }),
    /artifactOrigin/,
  );
  assert.throws(
    () =>
      validateComponentContract({
        ...base,
        runtime: {
          ...base.runtime,
          windowsX86_64: {
            ...base.runtime.windowsX86_64,
            codeEntries: [...base.runtime.windowsX86_64.codeEntries, "llama.exe"],
          },
        },
      }),
    /codeEntries/,
  );
  assert.throws(
    () =>
      validateComponentContract({
        ...base,
        speechModels: {
          ...base.speechModels,
          components: [...base.speechModels.components, base.speechModels.components[0]],
        },
      }),
    /speech model components|speech model component IDs/,
  );
  assert.throws(
    () =>
      validateComponentContract({
        ...base,
        runtime: {
          ...base.runtime,
          windowsX86_64: {
            ...base.runtime.windowsX86_64,
            source: { ...base.runtime.windowsX86_64.source, sha256: "0".repeat(64) },
          },
        },
      }),
    /runtime source/,
  );
  assert.throws(
    () =>
      validateComponentContract({
        ...base,
        speechModels: {
          ...base.speechModels,
          components: base.speechModels.components.map((entry, index) =>
            index === 0 ? { ...entry, sizeBytes: entry.sizeBytes + 1 } : entry,
          ),
        },
      }),
    /speech model component evidence/,
  );
});
