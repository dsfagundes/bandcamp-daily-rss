#!/usr/bin/env node
/**
 * Bandcamp Daily → RSS Feed Generator
 * ------------------------------------
 * Scrapes https://daily.bandcamp.com and writes a valid RSS 2.0 feed to
 * bandcamp-daily-feed.xml (or stdout with --stdout).
 *
 * Usage:
 *   node bandcamp-daily-rss.js                  # writes bandcamp-daily-feed.xml
 *   node bandcamp-daily-rss.js --stdout          # prints XML to console
 *   node bandcamp-daily-rss.js --section=features
 *   node bandcamp-daily-rss.js --section=album-of-the-day
 *
 * Sections you can filter by (append to daily.bandcamp.com/):
 *   features | lists | album-of-the-day | genres | series
 *   (leave blank for the main "latest" feed)
 *
 * Requirements: Node.js 18+ (uses built-in fetch).
 * No npm install needed.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const toStdout = args.includes("--stdout");
const sectionArg = args.find((a) => a.startsWith("--section="));
const section = sectionArg ? sectionArg.split("=")[1] : "";

const BASE_URL = "https://daily.bandcamp.com";
const TARGET_URL = section ? `${BASE_URL}/${section}` : BASE_URL;
const OUT_FILE = path.join(process.cwd(), "bandcamp-daily-feed.xml");

// ── Fetch helper (no dependencies) ───────────────────────────────────────────
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };
    https
      .get(url, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchHTML(res.headers.location).then(resolve).catch(reject);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

// ── HTML parsing (pure regex — no dependencies) ───────────────────────────────
function extractArticles(html) {
  const articles = [];

  // Bandcamp Daily uses <article> tags for each post
  const articleRegex = /<article[\s\S]*?<\/article>/gi;
  const matches = html.match(articleRegex) || [];

  for (const block of matches) {
    // Title
    const titleMatch =
      block.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\//) ||
      block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) ||
      block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch
      ? stripTags(titleMatch[1]).trim()
      : "Untitled";

    // URL
    const linkMatch = block.match(/href="(\/[^"]+)"/);
    const url = linkMatch ? BASE_URL + linkMatch[1] : null;
    if (!url) continue; // skip if no link

    // Description / excerpt
    const descMatch =
      block.match(/class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/class="[^"]*excerpt[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/class="[^"]*dek[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const description = descMatch
      ? stripTags(descMatch[1]).trim()
      : "";

    // Image
    const imgMatch =
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
      block.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    const image = imgMatch ? imgMatch[1] : null;

    // Category / section label
    const catMatch = block.match(/class="[^"]*category[^"]*"[^>]*>([\s\S]*?)<\//i);
    const category = catMatch ? stripTags(catMatch[1]).trim() : "";

    articles.push({ title, url, description, image, category });
  }

  return articles;
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

// ── RSS builder ───────────────────────────────────────────────────────────────
function escapeXML(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildRSS(articles, sourceUrl) {
  const now = new Date().toUTCString();
  const sectionLabel = section
    ? section.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Latest";

  const items = articles
    .map(
      ({ title, url, description, image, category }) => `
    <item>
      <title>${escapeXML(title)}</title>
      <link>${escapeXML(url)}</link>
      <guid isPermaLink="true">${escapeXML(url)}</guid>
      ${description ? `<description>${escapeXML(description)}</description>` : ""}
      ${category ? `<category>${escapeXML(category)}</category>` : ""}
      ${image ? `<enclosure url="${escapeXML(image)}" type="image/jpeg" length="0"/>` : ""}
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Bandcamp Daily – ${escapeXML(sectionLabel)}</title>
    <link>${escapeXML(sourceUrl)}</link>
    <description>Bandcamp Daily editorial feed scraped on ${now}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${escapeXML(sourceUrl)}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.error(`Fetching ${TARGET_URL} …`);
  let html;
  try {
    html = await fetchHTML(TARGET_URL);
  } catch (err) {
    console.error("Error fetching page:", err.message);
    process.exit(1);
  }

  const articles = extractArticles(html);
  if (articles.length === 0) {
    console.error(
      "⚠️  No articles found. Bandcamp Daily may have changed its HTML structure.\n" +
      "   Run with --debug to dump raw HTML for inspection."
    );
    if (args.includes("--debug")) {
      fs.writeFileSync("bandcamp-daily-debug.html", html);
      console.error("Raw HTML saved to bandcamp-daily-debug.html");
    }
    process.exit(1);
  }

  console.error(`Found ${articles.length} articles.`);

  const rss = buildRSS(articles, TARGET_URL);

  if (toStdout) {
    process.stdout.write(rss);
  } else {
    fs.writeFileSync(OUT_FILE, rss, "utf8");
    console.error(`✅  Feed written to: ${OUT_FILE}`);
  }
})();
