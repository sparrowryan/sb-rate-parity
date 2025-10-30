import { chromium } from "playwright";

export async function getSparrowHotels(max = 80) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("https://www.sparrowbid.com/explore", { waitUntil: "networkidle", timeout: 120000 });

  // Load enough cards
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
  }

  // 👇 TRY THESE selectors first; they’re “safe” heuristics.
  // We restrict to <a> cards that likely link to a listing.
  const cards = await page.$$eval(
    [
      'a[href*="/explore/"]',     // if the site uses explore detail URLs
      'a[href*="/property/"]',
      'a[href*="/hotel/"]',
      'a[href^="/"]'              // fallback: internal links only
    ].join(","),
    (links) => {
      const BAD_LINE = /filters?|sort|amenities|price\s*low|price\s*high|apply|rating|guest|breakfast|pool|restaurant|onsite|indoor|outdoor|from\s*\$\d|\/\s*night/i;

      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const dollars = (s) => {
        const m = String(s || "").match(/\$\s?\d[\d,]*/);
        return m ? m[0] : null;
      };

      const out = [];

      for (const a of links) {
        const href = a.href || "";
        // Keep internal listing-like links only (avoid nav/filter anchors)
        if (!href.includes("sparrowbid.com")) continue;

        // Use the nearest “card-like” container to read text
        const card =
          a.closest('[data-testid*="card"]') ||
          a.closest("article") ||
          a.closest("div");

        if (!card) continue;
        const text = clean(card.innerText);
        if (!text) continue;

        // Split card into lines; typical pattern is: Name \n City \n $Price ….
        const lines = text
          .split("\n")
          .map((x) => clean(x))
          .filter(Boolean)
          // kick out obvious UI garbage
          .filter((ln) => !BAD_LINE.test(ln));

        if (!lines.length) continue;

        // Prefer heading text for name if present
        const nameEl = card.querySelector("h1,h2,h3,[data-testid*='name']");
        const name = clean(nameEl?.textContent) || lines[0];
        if (!name || BAD_LINE.test(name)) continue;

        // Try to pull a city/location line (2nd line or one with a comma/US pattern)
        let city = "";
        const locEl =
          card.querySelector("[data-testid*='location'], .location, .subtitle");
        if (locEl) {
          city = clean(locEl.textContent);
        } else {
          city =
            lines.find((ln) => /,|United|USA|\b[A-Z]{2}\b/.test(ln)) ||
            lines[1] ||
            "";
        }
        if (BAD_LINE.test(city)) city = "";

        // Price on card (optional on SparrowBid)
        const priceRaw = dollars(text);

        out.push({ name, city, priceRaw, url: href });
      }

      // Deduplicate by URL
      const seen = new Set();
      return out.filter((x) => {
        if (!x.url) return false;
        const k = x.url.split("#")[0];
        if (seen.has(k)) return false;
        seen.add(k);
        // final sanity: names that are obviously UI fragments
        if (/^from\s*\$|^sort$/i.test(x.name)) return false;
        return true;
      });
    }
  );

  await browser.close();
  return cards.slice(0, max);
}
