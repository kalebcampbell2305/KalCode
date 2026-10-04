/** Run after production deployment. IndexNow requests discovery; it never guarantees indexing. */
import { readFileSync } from "node:fs";

const origin = "https://kalcoded.com";
const keyLocation = `${origin}/indexnow-key.txt`;
const key = readFileSync(new URL("../public/indexnow-key.txt", import.meta.url), "utf8").trim();
if (!/^[a-f0-9]{32}$/.test(key)) throw new Error("Invalid public IndexNow ownership key");

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

if ((await getText(keyLocation)).trim() !== key) throw new Error("Deploy the IndexNow ownership file first");
const sitemapIndex = await getText(`${origin}/sitemap-index.xml`);
const locations = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const assertCanonical = (url) => {
  const parsed = new URL(url);
  if (parsed.origin !== origin || parsed.search || parsed.hash) throw new Error(`Non-canonical URL: ${url}`);
};
const sitemaps = locations(sitemapIndex);
if (sitemaps.length === 0) throw new Error("Production sitemap index is empty");
sitemaps.forEach(assertCanonical);
const urlList = [...new Set((await Promise.all(sitemaps.map(getText))).flatMap(locations))];
if (urlList.length === 0 || urlList.length > 10_000) throw new Error("Invalid sitemap URL count");
urlList.forEach(assertCanonical);
const payload = { host: new URL(origin).host, key, keyLocation, urlList };
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`IndexNow HTTP ${response.status}: ${await response.text()}`);
  }
  console.log(
    `IndexNow accepted ${urlList.length} URLs (HTTP ${response.status}); indexing remains up to each engine.`,
  );
}
