import { readFileSync } from "node:fs";

export const COMPONENT_ORIGIN = "https://kalcoded.com";
export const COMPONENT_PATH_PREFIX = "/components/v1";
export const REASONING_RUNTIME_ID = "kalvoice.runtime.llama-cpp";
export const REASONING_MODEL_ID = "kalvoice.reasoner.qwen3-5-0-8b-q8";
export const REASONING_ABI = "kalvoice-llama-cpp.v1";
export const SPEECH_ABI = "kalvoice-whisper-ggml.v1";
export const WINDOWS_RUNTIME_CODE_MEMBERS = Object.freeze([
  "ggml-base.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cpu-cooperlake.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-ivybridge.dll",
  "ggml-cpu-piledriver.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-sapphirerapids.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-zen4.dll",
  "ggml.dll",
  "libomp.dll",
  "llama-common.dll",
  "llama-server-impl.dll",
  "llama-server.exe",
  "llama.dll",
  "mtmd.dll",
]);

export const MACOS_RUNTIME_CODE_MEMBERS = Object.freeze([
  "libggml-base.0.dylib",
  "libggml-blas.0.dylib",
  "libggml-cpu.0.dylib",
  "libggml-metal.0.dylib",
  "libggml-rpc.0.dylib",
  "libggml.0.dylib",
  "libllama-common.0.dylib",
  "libllama-server-impl.dylib",
  "libllama.0.dylib",
  "libmtmd.0.dylib",
  "llama-server",
]);
export const MACOS_RUNTIME_POLICY = Object.freeze({
  platform: "macos",
  arch: "aarch64",
  artifactFile: "runtime.zip",
  entrypoint: "llama-server",
  minimumSystemVersion: "14.0",
  expectedTeamId: "JG5K9T47ZF",
  source: {
    id: "ggml-org/llama.cpp",
    revision: "7fe450e19305b828c199d602c23a8337aaa1f03b",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-macos-arm64.tar.gz",
    file: "llama-b11146-bin-macos-arm64.tar.gz",
    sizeBytes: 11_189_714,
    sha256: "1ad3f9eff80edb9dbef4259ad564d1720612ef7eea48fa4afed0e54f5f3d5711",
  },
  licenses: [
    {
      spdxId: "MIT",
      noticeUrl:
        "https://raw.githubusercontent.com/ggml-org/llama.cpp/7fe450e19305b828c199d602c23a8337aaa1f03b/LICENSE",
      noticeSha256: "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
    },
  ],
  codeEntries: MACOS_RUNTIME_CODE_MEMBERS,
  extractEntries: ["LICENSE", ...MACOS_RUNTIME_CODE_MEMBERS],
  members: ["LICENSE", ...MACOS_RUNTIME_CODE_MEMBERS].map((file) => ({
    file,
    source: file.endsWith(".0.dylib")
      ? file.replace(".0.dylib", file.startsWith("libggml") ? ".0.25.1.dylib" : ".0.5.0.dylib")
      : file,
  })),
});

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPEECH_IDS = Object.freeze([
  "kalvoice.speech.whisper.tiny-en",
  "kalvoice.speech.whisper.base-en",
  "kalvoice.speech.whisper.small-en",
  "kalvoice.speech.whisper.base",
  "kalvoice.speech.whisper.small",
]);
const WINDOWS_RUNTIME_SOURCE = Object.freeze({
  id: "ggml-org/llama.cpp",
  revision: "7fe450e19305b828c199d602c23a8337aaa1f03b",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-win-cpu-x64.zip",
  file: "llama-b11146-bin-win-cpu-x64.zip",
  sizeBytes: 18_560_055,
  sha256: "14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1",
});
const WINDOWS_RUNTIME_LICENSES = Object.freeze([
  Object.freeze({
    spdxId: "MIT",
    noticeUrl: "https://raw.githubusercontent.com/ggml-org/llama.cpp/7fe450e19305b828c199d602c23a8337aaa1f03b/LICENSE",
    noticeSha256: "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
  }),
  Object.freeze({
    spdxId: "Apache-2.0-WITH-LLVM-exception",
    noticeUrl: "archive:LICENSE-LLVM-OpenMP",
    noticeSha256: "fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4",
  }),
]);
const REASONING_MODEL_SOURCE = Object.freeze({
  id: "ggml-org/Qwen3.5-0.8B-GGUF",
  revision: "8fea620810c4afa23dd6443f999a48574c1611a3",
  url: "https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/Qwen3.5-0.8B-Q8_0.gguf",
  file: "Qwen3.5-0.8B-Q8_0.gguf",
  sizeBytes: 833_592_096,
  sha256: "37ae482d336108d23516fa35e8e0c4126688d81018b87178a18d752a1357814f",
});
const REASONING_MODEL_LICENSE = Object.freeze({
  spdxId: "Apache-2.0",
  noticeUrl: "https://huggingface.co/Qwen/Qwen3.5-0.8B/resolve/2fc06364715b967f1860aea9cf38778875588b17/LICENSE",
  noticeSha256: "bbedc3fda3305820b977265f01b8619d87570a6739de3a5582c3464840f1e57a",
});
const SPEECH_MODEL_LICENSE = Object.freeze({
  spdxId: "MIT",
  noticeUrl: "https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE",
  noticeSha256: "b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d",
});
const SPEECH_COMPONENTS = Object.freeze([
  Object.freeze({
    legacyId: "tiny.en",
    componentId: SPEECH_IDS[0],
    file: "ggml-tiny.en.bin",
    sizeBytes: 77_704_715,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
  }),
  Object.freeze({
    legacyId: "base.en",
    componentId: SPEECH_IDS[1],
    file: "ggml-base.en.bin",
    sizeBytes: 147_964_211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  }),
  Object.freeze({
    legacyId: "small.en",
    componentId: SPEECH_IDS[2],
    file: "ggml-small.en.bin",
    sizeBytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
  }),
  Object.freeze({
    legacyId: "base",
    componentId: SPEECH_IDS[3],
    file: "ggml-base.bin",
    sizeBytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  }),
  Object.freeze({
    legacyId: "small",
    componentId: SPEECH_IDS[4],
    file: "ggml-small.bin",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  }),
]);

function sameJson(left, right) {
  const canonicalize = (value) =>
    Array.isArray(value)
      ? value.map(canonicalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonicalize(value[key])]),
          )
        : value;
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const unknown = actual.filter((key) => !expected.includes(key));
    throw new Error(`${label} has ${unknown.length ? `unknown field ${unknown[0]}` : "an invalid field set"}`);
  }
}

function safeToken(value, label, max = 128) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !SAFE_TOKEN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeFile(value, label) {
  if (typeof value !== "string" || value.length > 160 || value.includes("..") || !SAFE_FILE.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

function exactHttpsUrl(value, label, expected) {
  if (typeof value !== "string" || value !== expected) throw new Error(`${label} is invalid`);
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    parsed.search
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function source(value, label, expectedUrl) {
  exactKeys(value, ["id", "revision", "url", "file", "sizeBytes", "sha256"], label);
  if (
    typeof value.id !== "string" ||
    value.id.length > 256 ||
    !SAFE_SOURCE_ID.test(value.id) ||
    value.id.includes("..")
  ) {
    throw new Error(`${label}.id is invalid`);
  }
  safeToken(value.revision, `${label}.revision`);
  exactHttpsUrl(value.url, `${label}.url`, expectedUrl);
  safeFile(value.file, `${label}.file`);
  positiveInteger(value.sizeBytes, `${label}.sizeBytes`);
  sha256(value.sha256, `${label}.sha256`);
}

function license(value, label) {
  exactKeys(value, ["spdxId", "noticeUrl", "noticeSha256"], label);
  safeToken(value.spdxId, `${label}.spdxId`, 64);
  sha256(value.noticeSha256, `${label}.noticeSha256`);
  if (
    typeof value.noticeUrl !== "string" ||
    (!value.noticeUrl.startsWith("https://") && !/^archive:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.noticeUrl))
  ) {
    throw new Error(`${label}.noticeUrl is invalid`);
  }
}

function exactUniqueFileList(value, label, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength) throw new Error(`${label} is invalid`);
  value.forEach((entry) => {
    safeFile(entry, label);
  });
  if (new Set(value.map((entry) => entry.toLowerCase())).size !== value.length)
    throw new Error(`${label} has a collision`);
  return value;
}

export function canonicalComponentArtifactUrl({ kind, componentId, version, sha256: digest, file }) {
  if (!["runtime", "model"].includes(kind)) throw new Error("kind is invalid");
  safeToken(componentId, "componentId");
  safeToken(version, "version", 64);
  sha256(digest, "sha256");
  safeFile(file, "file");
  return `${COMPONENT_ORIGIN}${COMPONENT_PATH_PREFIX}/${kind}/${componentId}/${version}/${digest}/${file}`;
}

export function validateComponentContract(value) {
  exactKeys(
    value,
    ["schemaVersion", "artifactOrigin", "runtime", "reasoningModel", "speechModels"],
    "component contract",
  );
  if (value.schemaVersion !== 1) throw new Error("component contract schemaVersion is invalid");
  if (value.artifactOrigin !== COMPONENT_ORIGIN) throw new Error("component contract artifactOrigin is invalid");

  exactKeys(
    value.runtime,
    ["componentId", "kind", "version", "runtimeAbi", "windowsX86_64", "macosAarch64"],
    "runtime",
  );
  if (!sameJson(value.runtime.macosAarch64, MACOS_RUNTIME_POLICY)) throw new Error("Mac runtime policy is invalid");
  if (value.runtime.componentId !== REASONING_RUNTIME_ID || value.runtime.kind !== "runtime")
    throw new Error("runtime identity is invalid");
  if (value.runtime.version !== "0.5.0-b11146") throw new Error("runtime version is invalid");
  if (value.runtime.runtimeAbi !== REASONING_ABI) throw new Error("runtime ABI is invalid");
  const windows = value.runtime.windowsX86_64;
  exactKeys(
    windows,
    [
      "platform",
      "arch",
      "artifactFile",
      "entrypoint",
      "source",
      "licenses",
      "extractEntries",
      "codeEntries",
      "ignoreEntries",
      "sourceEntries",
    ],
    "runtime.windowsX86_64",
  );
  if (windows.platform !== "windows" || windows.arch !== "x86_64") throw new Error("Windows runtime target is invalid");
  if (windows.artifactFile !== "runtime.zip" || windows.entrypoint !== "llama-server.exe") {
    throw new Error("Windows runtime filenames are invalid");
  }
  source(
    windows.source,
    "runtime.windowsX86_64.source",
    "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-win-cpu-x64.zip",
  );
  if (!sameJson(windows.source, WINDOWS_RUNTIME_SOURCE)) throw new Error("Windows runtime source is invalid");
  if (!Array.isArray(windows.licenses) || windows.licenses.length !== 2)
    throw new Error("Windows runtime licenses are invalid");
  windows.licenses.forEach((entry, index) => {
    license(entry, `runtime.windowsX86_64.licenses[${index}]`);
  });
  if (!sameJson(windows.licenses, WINDOWS_RUNTIME_LICENSES))
    throw new Error("Windows runtime license evidence is invalid");
  exactUniqueFileList(windows.extractEntries, "extractEntries", 23);
  exactUniqueFileList(windows.codeEntries, "codeEntries", 22);
  exactUniqueFileList(windows.ignoreEntries, "ignoreEntries", 28);
  exactUniqueFileList(windows.sourceEntries, "sourceEntries", 51);
  if (JSON.stringify(windows.codeEntries) !== JSON.stringify(WINDOWS_RUNTIME_CODE_MEMBERS)) {
    throw new Error("codeEntries do not match the approved PE closure");
  }
  const extract = new Set(windows.extractEntries);
  const ignored = new Set(windows.ignoreEntries);
  if (
    windows.codeEntries.some((entry) => !extract.has(entry) || !/\.(?:dll|exe)$/i.test(entry)) ||
    !extract.has(windows.entrypoint) ||
    [...extract].some((entry) => ignored.has(entry)) ||
    new Set([...extract, ...ignored]).size !== 51 ||
    windows.sourceEntries.some((entry) => !extract.has(entry) && !ignored.has(entry))
  ) {
    throw new Error("Windows runtime inventory is inconsistent");
  }

  const model = value.reasoningModel;
  exactKeys(
    model,
    ["componentId", "kind", "version", "runtimeAbi", "artifactFile", "source", "licenses"],
    "reasoningModel",
  );
  if (model.componentId !== REASONING_MODEL_ID || model.kind !== "model" || model.runtimeAbi !== REASONING_ABI) {
    throw new Error("reasoning model identity is invalid");
  }
  if (model.version !== "8fea620810c4afa2-q8_0") throw new Error("reasoning model version is invalid");
  if (model.artifactFile !== "reasoner.gguf") throw new Error("reasoning model artifact file is invalid");
  source(
    model.source,
    "reasoningModel.source",
    "https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/Qwen3.5-0.8B-Q8_0.gguf",
  );
  if (!sameJson(model.source, REASONING_MODEL_SOURCE)) throw new Error("reasoning model source is invalid");
  if (!Array.isArray(model.licenses) || model.licenses.length !== 1)
    throw new Error("reasoning model licenses are invalid");
  license(model.licenses[0], "reasoningModel.licenses[0]");
  if (!sameJson(model.licenses[0], REASONING_MODEL_LICENSE))
    throw new Error("reasoning model license evidence is invalid");

  const speech = value.speechModels;
  exactKeys(
    speech,
    ["runtimeAbi", "sourceId", "sourceRevision", "defaultComponentId", "license", "components"],
    "speechModels",
  );
  if (
    speech.runtimeAbi !== SPEECH_ABI ||
    speech.sourceId !== "ggerganov/whisper.cpp" ||
    speech.sourceRevision !== "5359861c739e955e79d9a303bcbc70fb988958b1"
  ) {
    throw new Error("speech model source is invalid");
  }
  license(speech.license, "speechModels.license");
  if (!sameJson(speech.license, SPEECH_MODEL_LICENSE)) throw new Error("speech model license evidence is invalid");
  if (!Array.isArray(speech.components) || speech.components.length !== 5)
    throw new Error("speech model components are invalid");
  const ids = [];
  for (const [index, component] of speech.components.entries()) {
    exactKeys(
      component,
      ["legacyId", "componentId", "file", "sizeBytes", "sha256"],
      `speechModels.components[${index}]`,
    );
    safeToken(component.legacyId, `speechModels.components[${index}].legacyId`);
    safeToken(component.componentId, `speechModels.components[${index}].componentId`);
    safeFile(component.file, `speechModels.components[${index}].file`);
    positiveInteger(component.sizeBytes, `speechModels.components[${index}].sizeBytes`);
    sha256(component.sha256, `speechModels.components[${index}].sha256`);
    ids.push(component.componentId);
  }
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(SPEECH_IDS)) {
    throw new Error("speech model component IDs are invalid");
  }
  if (!sameJson(speech.components, SPEECH_COMPONENTS)) throw new Error("speech model component evidence is invalid");
  if (speech.defaultComponentId !== SPEECH_IDS[0]) throw new Error("default speech model is invalid");
  return value;
}

export function loadComponentContract(path) {
  return validateComponentContract(JSON.parse(readFileSync(path, "utf8")));
}
