/**
 * Structured data (schema.org JSON-LD) for the home page. Built only from the site's own sources
 * of truth: SOCIAL for profiles, the plan catalog for offers, the release manifest for operating
 * systems. No ratings or reviews: there are none to report.
 *
 * The JSON-LD block is a non-executing data block (`type="application/ld+json"`), which the
 * Worker's CSP `script-src` does not govern, so it needs no hash.
 */
import { BILLING_INTERVALS, PLANS, priceFor } from "@kalcode/protocol/plans";
import { OS_NAMES, RELEASES, type ReleaseManifest } from "./releases";
import { CONTACT_EMAIL, PAGES, type PageInfo, SITE_NAME, SITE_ORIGIN, SOCIAL } from "./site";

export const TWITTER_SITE = SOCIAL.official.handle;

export function structuredData(manifest: ReleaseManifest = RELEASES): Record<string, unknown> {
  const organizationId = `${SITE_ORIGIN}/#organization`;
  const operatingSystems = manifest.latest?.platforms.map((platform) => OS_NAMES[platform.os]) ?? [];
  const application: Record<string, unknown> = {
    "@type": "SoftwareApplication",
    "@id": `${SITE_ORIGIN}/#software`,
    name: SITE_NAME,
    url: `${SITE_ORIGIN}/`,
    applicationCategory: "DeveloperApplication",
    image: `${SITE_ORIGIN}/og.png`,
    description:
      "A desktop workspace that connects the coding agents you already use — Claude Code, and Codex on a personal ChatGPT plan — on your own accounts.",
    publisher: { "@id": organizationId },
    offers: PLANS.map((plan) => ({
      "@type": "Offer",
      name: plan.name,
      description: plan.tagline,
      price: priceFor(plan, "month").toFixed(2),
      priceCurrency: "USD",
      url: `${SITE_ORIGIN}/pricing`,
      // Monthly and yearly billing, each a recurring charge for its billing period.
      priceSpecification: BILLING_INTERVALS.map((interval) => ({
        "@type": "UnitPriceSpecification",
        price: priceFor(plan, interval).toFixed(2),
        priceCurrency: "USD",
        billingDuration: interval === "year" ? "P1Y" : "P1M",
        unitCode: interval === "year" ? "ANN" : "MON",
        unitText: interval === "year" ? "YEAR" : "MONTH",
      })),
    })),
  };
  if (operatingSystems.length > 0) {
    application.operatingSystem = operatingSystems.join(", ");
    application.softwareVersion = manifest.latest?.version;
    application.downloadUrl = `${SITE_ORIGIN}/download`;
  }

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
        logo: `${SITE_ORIGIN}/assets/brand/kalcode-mark-256.png`,
        email: CONTACT_EMAIL,
        // The product's own profile only; the founder's personal account is not the organization.
        sameAs: [SOCIAL.official.url],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
        publisher: { "@id": organizationId },
        alternateName: "kalcoded.com",
        inLanguage: "en",
      },
      application,
    ],
  };
}

/** Describe the rendered page, with the same canonical URL and copy its visitors see. */
export function pageStructuredData(page: PageInfo, siteData?: Record<string, unknown>): Record<string, unknown> {
  const url = new URL(page.path, SITE_ORIGIN).href;
  const graph: Record<string, unknown>[] = Array.isArray(siteData?.["@graph"]) ? [...siteData["@graph"]] : [];
  graph.push({
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: page.title,
    description: page.description,
    inLanguage: "en",
    isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
    // A page about something other than the KalCode app (a game) names its own subject.
    about: { "@id": typeof siteData?.about === "string" ? siteData.about : `${SITE_ORIGIN}/#software` },
    ...(page.path === "/"
      ? { mainEntity: { "@id": `${SITE_ORIGIN}/#software` } }
      : { breadcrumb: { "@id": `${url}#breadcrumb` } }),
  });
  if (page.path !== "/") {
    const ancestors = PAGES.filter((entry) => entry.path !== "/" && page.path.startsWith(`${entry.path}/`));
    const crumbs = [{ path: "/", title: SITE_NAME }, ...ancestors, page];
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumb`,
      itemListElement: crumbs.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: entry.title.split(" — ")[0],
        item: new URL(entry.path, SITE_ORIGIN).href,
      })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/** Serialises JSON-LD for an HTML data block: `<` is escaped so the text can never close the tag. */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
