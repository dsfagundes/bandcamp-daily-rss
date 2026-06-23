#!/usr/bin/env node
/**
 * Bandcamp Daily → RSS Feed Generator
 * Parses div.list-article blocks from daily.bandcamp.com
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
  const seen = new Set();

  // Match each div.list-article block
  const blockRegex = /<div class="list-article[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  // Simpler: grab from <div class="list-article to the closing title-wrapper div
  const blocks = [];
  let start = 0;
  while (true) {
    const idx = html.indexOf('<div class="list-article', start);
    if (idx === -1) break;
    // Find end: next occurrence of </div> after title-wrapper closing
    const titleWrapperEnd = html.indexOf('</div>', html.indexOf('title-wrapper', idx));
    if (titleWrapperEnd === -1) break;
    const end = html.indexOf('</div>', titleWrapperEnd) + 6;
    blocks.push(html.slice(idx, end));
    start = idx + 1;
  }

  console.error(`Found ${blocks.length} list-article blocks`);

  for (const block of blocks) {
    // Title and URL: <a class="title" href="/path/to/article">Title text</a>
    const titleMatch = block.match(/class="title"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    const relUrl = titleMatch[1];
    const url = relUrl.startsWith("http") ? relUrl : BASE_URL + relUrl;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = stripTags(titleMatch[2]);

    // Category: <a class="franchise" href="...">CATEGORY NAME</a>
    const catMatch = block.match(/class="franchise"[^>]*>([^<]+)<\/a>/);
    const category = catMatch ? stripTags(catMatch[1]) : "";

    // Date: text node after the middot span
    const dateMatch = block.match(/class="middot"[^>]*>&middot;<\/span>\s*([\w,\s]+\d{4})/);
    const pubDate = dateMatch ? dateMatch[1].trim() : "";

    // Image: first <img src="...">
    const imgMatch = block.match(/<img\s+src="([^"]+)"/);
    const image = imgMatch ? imgMatch[1] : null;

    // Blurb (only present on big-feature items)
    const blurbMatch = block.match(/<p class="blurb">([\s\S]*?)<\/p>/);
    const description = blurbMatch ? stripTags(blurbMatch[1]) : "";

    articles.push({ title, url, description, image, category, pubDate });
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

  const items = articles.map(({ title, url, description, image, category, pubDate }) => {
    const parsedDate = pubDate ? new Date(pubDate) : null;
    const validDate = parsedDate && !isNaN(parsedDate) ? parsedDate.toUTCString() : "";
    return `
    <item>
      <title>${escapeXML(title)}</title>
      <link>${escapeXML(url)}</link>
      <guid isPermaLink="true">${escapeXML(url)}</guid>
      ${description ? `<description>${escapeXML(description)}</description>` : ""}
      ${category ? `<category>${escapeXML(category)}</category>` : ""}
      ${validDate ? `<pubDate>${validDate}</pubDate>` : ""}
      ${image ? `<enclosure url="${escapeXML(image)}" type="image/jpeg" length="0"/>` : ""}
    </item>`;
  }).join("\n");

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

  console.error(`Got ${html.length} bytes.`);

  if (process.env.CI) {
    fs.writeFileSync("bandcamp-daily-debug.html", html);
  }

  const articles = extractArticles(html);

  if (articles.length === 0) {
    console.error("ERROR: No articles found.");
    process.exit(1);
  }

  console.error(`Extracted ${articles.length} articles.`);

  const rss = buildRSS(articles, TARGET_URL);

  if (toStdout) {
    process.stdout.write(rss);
  } else {
    fs.writeFileSync(OUT_FILE, rss, "utf8");
    console.error(`✅  Feed written to: ${OUT_FILE}`);
  }
})();
