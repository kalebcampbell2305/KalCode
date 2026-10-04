# Search discovery

KalCode's canonical website is https://kalcoded.com. Public pages are server-rendered HTML with
unique titles and descriptions, canonical URLs, social previews and schema.org page/breadcrumb
data. The home page identifies the KalCode organization, website and software application.
Prices and release platforms in structured data come from the existing product catalogs.

The sitemap is https://kalcoded.com/sitemap-index.xml. Account, owner, email-action and error
pages must remain noindex and outside the sitemap. Do not block those pages in robots.txt:
crawlers must be able to read their noindex directives.

After a website deployment, notify participating search engines using:

```powershell
node apps/website/scripts/submit-indexnow.mjs
```

The script verifies the public ownership file and reads the live sitemap before submitting.
Use `--dry-run` to inspect the payload without submitting it. The IndexNow key is public ownership
proof, not an account credential. A 200 or 202 response acknowledges submission, not indexing.
IndexNow does not submit to Google.

For Google, verify the `kalcoded.com` domain property in Google Search Console using the DNS TXT
record Google provides, then submit `sitemap-index.xml` and request indexing of the homepage.
In Bing Webmaster Tools, import that verified property or verify the domain and submit the same
sitemap. Account access/verification must be completed by an authorized owner; never invent a
verification token or report a submission that has not happened.

Track impressions, clicks and average position for `KalCode`, `KalCode download`, `KalCode pricing`
and `KalVoice` in those consoles. Use the exact name KalCode and link to https://kalcoded.com from
official profiles and genuine product coverage. Consistent identity and relevant links support
branded discovery. Technical SEO cannot promise first place or a particular crawl/indexing date.
