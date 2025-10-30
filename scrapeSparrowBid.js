import { chromium } from "playwright";

/**
 * Scrape SparrowBid Explore with client-side pagination.
 * - Supports multiple card types (today's deals + standard explore cards)
 * - If card has no <a>, optionally CLICK to capture the final URL
 */
export async function getSparrowHotels({
  maxHotels = 600,
  maxPages = 40,
  fetchUrls = true,       // click-through to collect SparrowBid URL when missing
  settleMs = 500
} = {}) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.goto("https://www.sparrowbid.com/explore", { waitUntil: "networkidle", timeout: 120000 });

  // Helper to extract cards currently rendered
  async function extractCardsOnPage() {
    const items = await page.$$eval(
      ".sb_todays_deals_card_ctn, .sb_explore_card_ctn, .sb_card, [class*='deals_card_ctn'], [class*='explore_card_ctn']",
      (cards) => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        const dollars = (s) => {
          const m = String(s || "").match(/\$\s?\d[\d,]*/);
          return m ? m[0] : null;
        };

        const out = [];
        for (const card of cards) {
          const name =
            clean(
              card.querySelector(".sb_todays_deals_card_heading, .sb_explore_card_heading, h1, h2, h3, h4")?.textContent
            ) || "";

          if (!name) continue;

          // "City, CC - 1234 mi away" → take left side of " - "
          const cityLine = clean(
            card.querySelector(".sb_todays_deals_card_country_ctn p, .sb_explore_card_country_ctn p, .location, .subtitle")?.textContent
          );
          const city = cityLine ? clean(cityLine.split(" - ")[0]) : "";

          const priceRaw = dollars(
            card.querySelector(".sb_todays_deals_card_price, .sb_explore_card_price, [class*='price']")?.textContent
          );

          // Try to find a link; many cards are button-only
          const url =
            card.querySelector("a[href^='/']")?.href ||
            card.closest("a")?.href ||
            card.querySelector("a")?.href ||
            "";

          out.push({ name, city, priceRaw, urlSelectorPath: getPath(card), url });
        }

        // Helper: build a short DOM path string (used later to click the same card)
        function getPath(el) {
          const p = [];
          let node = el;
          while (node && p.length < 6) {
            let label = node.tagName?.toLowerCase() || "div";
            if (node.className) {
              const cls = String(node.className).split(/\s+/).filter(Boolean)[0];
              if (cls) label += "." + cls;
            }
            p.unshift(label);
            node = node.parentElement;
          }
          return p.join(" > ");
        }

        // Dedup per page
        const seen = new Set();
        return out.filter((h) => {
          const key = `${h.name.toLowerCase()}|${h.city.toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    );

    return items;
  }

  // Scroll a bit to trigger lazy load on first view
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
  }

  const results = [];
  const seenGlobal = new Set();

  // Collect first page
  let pageItems = await extractCardsOnPage();
  await maybeClickForUrls(page, pageItems, fetchUrls, settleMs);
  pushUnique(pageItems);

  // Paginate even if URL never changes
  for (let p = 2; p <= maxPages; p++) {
    const beforeFirst = pageItems[0]?.name || "";
    const beforeCount = (await page.$$("[class*='deals_card_ctn'], [class*='explore_card_ctn']").catch(() => [])).length;

    const nextLocators = [
      'button[aria-label="Next"]',
      'a[aria-label="Next"]',
      'button:has-text("Next")',
      'a:has-text("Next")',
      '.pagination .next button',
      '.pagination .next a',
      '.sb_pagination_next button',
      '.sb_pagination_next a',
    ];

    let clicked = false;
    for (const sel of nextLocators) {
      const loc = page.locator(sel);
      if (await loc.count()) {
        try {
          await Promise.all([
            page.waitForFunction(
              ({ beforeFirst, beforeCount }) => {
                const cards = document.querySelectorAll(
                  ".sb_todays_deals_card_ctn, .sb_explore_card_ctn, .sb_card, [class*='deals_card_ctn'], [class*='explore_card_ctn']"
                );
                if (cards.length > beforeCount) return true;
                const firstName =
                  cards[0]?.querySelector(".sb_todays_deals_card_heading, .sb_explore_card_heading, h1, h2, h3, h4")
                    ?.textContent?.trim() || "";
                return firstName && firstName !== beforeFirst;
              },
              { polling: 200, timeout: 8000 },
              { beforeFirst, beforeCount }
            ).catch(() => null),
            loc.first().click(),
          ]);
          clicked = true;
          break;
        } catch { /* try next */ }
      }
    }
    if (!clicked) break;

    await page.waitForTimeout(settleMs);
    pageItems = await extractCardsOnPage();
    await maybeClickForUrls(page, pageItems, fetchUrls, settleMs);
    if (pushUnique(pageItems)) break;
  }

  await browser.close();
  return results;

  function pushUnique(list) {
    for (const h of list) {
      const key = `${h.name.toLowerCase()}|${h.city.toLowerCase()}`;
      if (seenGlobal.has(key)) continue;
      seenGlobal.add(key);
      results.push({ name: h.name, city: h.city, priceRaw: h.priceRaw, url: h.url });
      if (results.length >= maxHotels) return true;
    }
    return false;
  }
}

/** Click into a card to grab URL when there is no <a>. Then go back. */
async function maybeClickForUrls(page, items, fetchUrls, settleMs) {
  if (!fetchUrls) return;
  for (const it of items) {
    if (it.url) continue;
    // try clicking its primary button or the card itself
    const button = page.locator(`text=Bid or Book Now`).first();
    try {
      const old = page.url();
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null),
        button.click().catch(() => page.mouse.click(10, 10).catch(() => null)), // fallback
      ]);
      await page.waitForTimeout(settleMs);
      const newUrl = page.url();
      if (newUrl && newUrl !== old) it.url = newUrl;
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(300);
    } catch {
      // ignore; leave url blank if we can't navigate
    }
  }
}
