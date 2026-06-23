#!/usr/bin/env node
/**
 * Bandcamp Daily → RSS Feed Generator
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const toStdout = args.includes("--stdout");
const sectionArg = args.find((a) => a.startsWith("--section="));
const section = sectionArg ? sectionArg.split("=")[1] : "";

const BASE_URL = "https://daily.bandcamp.com";
const TARGET_URL = section ? `${BASE_URL}/${section}` : BASE_URL;
const OUT_FILE = path.join(process.cwd(), "bandcamp-daily-feed.xml");

function fetchHTML(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function stripTags(str) {
  return (str || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractArticles(html) {
  const articles = [];

  // Strategy 1: JSON-LD structured data (most reliable)
  const jsonLdMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdMatches) {
    try {
      const json = JSON.parse(block.replace(/<script[^>]*>/, "").replace(/<\/script>/, ""));
      const items = json["@graph"] || (Array.isArray(json) ? json : [json]);
      for (const item of items) {
        if (item["@type"] === "Article" || item["@type"] === "NewsArticle" || item["@type"] === "BlogPosting") {
          articles.push({
            title: item.headline || item.name || "Untitled",
            url: item.url || item.mainEntityOfPage || null,
            description: item.description || "",
            image: item.image?.url || item.image || null,
            category: item.articleSection || item.genre || "",
            pubDate: item.datePublished || "",
          });
        }
      }
    } catch (e) { /* skip malformed JSON-LD */ }
  }

  if (articles.length > 0) {
    console.error(`Found ${articles.length} articles via JSON-LD.`);
    return articles;
  }

  // Strategy 2: <article> tags
  const articleBlocks = html.match(/<article[\s\S]*?<\/article>/gi) || [];
  console.error(`Strategy 2: found ${articleBlocks.length} <article> blocks`);

  for (const block of articleBlocks) {
    const titleMatch =
      block.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\//i) ||
      block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : "Untitled";

    const linkMatch = block.match(/href="((?:https?:\/\/daily\.bandcamp\.com|\/)[^"]+)"/);
    const url = linkMatch
      ? linkMatch[1].startsWith("http") ? linkMatch[1] : BASE_URL + linkMatch[1]
      : null;
    if (!url) continue;

    const descMatch =
      block.match(/class="[^"]*(?:description|excerpt|dek|summary)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const description = descMatch ? stripTags(descMatch[1]) : "";

    const imgMatch =
      block.match(/data-src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
      block.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    const image = imgMatch ? imgMatch[1] : null;

    const catMatch = block.match(/class="[^"]*category[^"]*"[^>]*>([\s\S]*?)<\//i);
    const category = catMatch ? stripTags(catMatch[1]) : "";

    articles.push({ title, url, description, image, category, pubDate: "" });
  }

  if (articles.length > 0) return articles;

  // Strategy 3: anchor tags with Bandcamp Daily paths
  console.error("Strategy 3: scanning anchor tags...");
  const linkPattern = /href="(https?:\/\/daily\.bandcamp\.com\/[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{10,})/gi;
  let match;
  const seen = new Set();
  while ((match = linkPattern.exec(html)) !== null) {
    const url = match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const title = stripTags(match[2]);
    if (title.length > 5) {
      articles.push({ title, url, description: "", image: null, category: "", pubDate: "" });
    }
  }

  return articles;
}

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

  const items = articles.map(({ title, url, description, image, category, pubDate }) => `
    <item>
      <title>${escapeXML(title)}</title>
      <link>${escapeXML(url)}</link>
      <guid isPermaLink="true">${escapeXML(url)}</guid>
      ${description ? `<description>${escapeXML(description)}</description>` : ""}
      ${category ? `<category>${escapeXML(category)}</category>` : ""}
      ${pubDate ? `<pubDate>${new Date(pubDate).toUTCString()}</pubDate>` : ""}
      ${image ? `<enclosure url="${escapeXML(image)}" type="image/jpeg" length="0"/>` : ""}
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Bandcamp Daily – ${escapeXML(sectionLabel)}</title>
    <link>${escapeXML(sourceUrl)}</link>
    <description>Bandcamp Daily editorial feed, updated daily via GitHub Actions</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="https://dsfagundes.github.io/bandcamp-daily-rss/bandcamp-daily-feed.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}

(async () => {
  console.error(`Fetching ${TARGET_URL} …`);
  let html;
  try {
    html = await fetchHTML(TARGET_URL);
  } catch (err) {
    console.error("Error fetching page:", err.message);
    process.exit(1);
  }

  console.error(`Got ${html.length} bytes of HTML.`);

  // Always save debug HTML in CI for inspection
  if (process.env.CI) {
    fs.writeFileSync("bandcamp-daily-debug.html", html);
    console.error("Debug HTML saved.");
  }

  const articles = extractArticles(html);

  if (articles.length === 0) {
    console.error("ERROR: No articles found after all strategies. Check bandcamp-daily-debug.html.");
    process.exit(1);
  }

  console.error(`Total articles extracted: ${articles.length}`);

  const rss = buildRSS(articles, TARGET_URL);

  if (toStdout) {
    process.stdout.write(rss);
  } else {
    fs.writeFileSync(OUT_FILE, rss, "utf8");
    console.error(`✅  Feed written to: ${OUT_FILE}`);
  }
})();
