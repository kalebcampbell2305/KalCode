// End-to-end check of the download routes on the real Worker (`wrangler dev`, local R2
// simulation) after `pnpm release:publish --local`. Downloads the installer through the Worker
// and compares its SHA-256 with the build record.
//
// Usage:
//   pnpm --filter @kalcode/website build
//   node tooling/release/publish.mjs --local
//   node tooling/release/smoke-local.mjs [--port 8790]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appVersion, fail, readJson, stagingDir, WEBSITE_DIR } from "./lib.mjs";

const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 8790;
const BASE = `http://127.0.0.1:${PORT}`;

const version = appVersion();
const build = readJson(join(stagingDir(version), "build.json"));
if (!existsSync(join(WEBSITE_DIR, "dist", "index.html")))
  fail("Build the website first: pnpm --filter @kalcode/website build");

const wrangler = spawn(
  process.execPath,
  [
    join(WEBSITE_DIR, "node_modules", "wrangler", "bin", "wrangler.js"),
    "dev",
    "--local",
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
    "--inspector-port",
    String(PORT + 1000),
  ],
  {
    cwd: WEBSITE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    windowsHide: true,
  },
);
let output = "";
wrangler.stdout.on("data", (d) => {
  output += d;
});
wrangler.stderr.on("data", (d) => {
  output += d;
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function ready() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start on ${BASE}:\n${output}`);
}

try {
  await ready();
  console.log(`wrangler dev is serving ${BASE}\n`);

  const latest = await fetch(`${BASE}/download/windows-x64`);
  const body = new Uint8Array(await latest.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("hex");
  check("GET /download/windows-x64 → 200", latest.status === 200, String(latest.status));
  check(
    "content-type is the PE executable type",
    latest.headers.get("content-type") === "application/vnd.microsoft.portable-executable",
    latest.headers.get("content-type") ?? "",
  );
  check(
    "content-disposition names the installer",
    latest.headers.get("content-disposition") === `attachment; filename="${build.file}"`,
    latest.headers.get("content-disposition") ?? "",
  );
  check("content-length matches the build", latest.headers.get("content-length") === String(build.size));
  check("downloaded bytes match the build SHA-256", sha256 === build.sha256, sha256);
  check("etag present", Boolean(latest.headers.get("etag")), latest.headers.get("etag") ?? "");
  check(
    "cache-control is short for the moving link",
    latest.headers.get("cache-control") === "public, max-age=300, must-revalidate",
  );
  check("site security headers applied", latest.headers.get("strict-transport-security")?.includes("max-age") === true);
  check("x-kalcode-version header", latest.headers.get("x-kalcode-version") === version);

  const head = await fetch(`${BASE}/download/windows-x64`, { method: "HEAD" });
  check(
    "HEAD /download/windows-x64 → 200 with length",
    head.status === 200 && head.headers.get("content-length") === String(build.size),
  );

  const pinned = await fetch(`${BASE}/download/${version}/${build.file}`, { headers: { range: "bytes=0-1" } });
  const magic = new Uint8Array(await pinned.arrayBuffer());
  check(
    "pinned URL serves ranges (206, starts with MZ)",
    pinned.status === 206 && magic[0] === 0x4d && magic[1] === 0x5a,
  );
  check("pinned URL is immutable", pinned.headers.get("cache-control") === "public, max-age=31536000, immutable");

  const conditional = await fetch(`${BASE}/download/windows-x64`, {
    headers: { "if-none-match": latest.headers.get("etag") ?? "" },
  });
  check("If-None-Match → 304", conditional.status === 304, String(conditional.status));

  const manifest = await fetch(`${BASE}/releases/latest.json`);
  const doc = await manifest.json();
  check("GET /releases/latest.json → 200", manifest.status === 200);
  check("manifest SHA-256 matches", doc?.latest?.platforms?.[0]?.sha256 === build.sha256);

  const missing = await fetch(`${BASE}/download/9.9.9/${build.file}`);
  const missingHtml = await missing.text();
  check(
    "missing version → styled 404 page",
    missing.status === 404 && missingHtml.includes("<html"),
    String(missing.status),
  );
  check("404 page heading rewritten", missingHtml.includes("That download is not available."));

  const page = await fetch(`${BASE}/download`, { redirect: "manual" });
  check(
    "the /download page itself is still served by the site",
    [200, 301, 307, 308].includes(page.status),
    String(page.status),
  );
} catch (error) {
  console.error(error);
  results.push({ name: "smoke run", ok: false });
} finally {
  // Kill the whole tree: wrangler starts workerd as a child that would keep the port open.
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(wrangler.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else wrangler.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nsmoke-local: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
