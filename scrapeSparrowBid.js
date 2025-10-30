import { chromium } from "playwright";

/**
 * Scrapes ALL visible pages even when the URL never changes.
 * Strategy:
 * - Keep clicking "Next" (or page numbers) while the number of cards increases.
 * - After each click, wait until either:
 *     a) card count increases, or
 *     b) the first card’s name changes, or
 *     c) 8s timeout (then we stop).
 * - De-dupe globally by name|city.
 */
export async function getSparrowHotels({ maxHotels = 800, maxPages = 50 } = {}) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.goto("https://www.sparrowbid.com/explore", {
    waitUntil: "networkidle",
    timeout: 120000,
  });

  // helper: extract cards on current view
  async function extractCards() {
    return await page.$$eval(".sb_todays_deals_card_ctn", (cards) => {
      const dollars = (s) => {
        const m = String(s || "").match(/\$\s?\d[\d,]*/);
        return m ? m[0] : null;
      };
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

      const out = [];
      for (const card of cards) {
        const name = clean(card.querySelector(".sb_todays_deals_card_heading")?.textContent);
        if (!name) continue;

        // "New York, US - 5385.12 mi away" → "New York, US"
        const cityLine = clean(card.querySelector(".sb_todays_deals_card_country_ctn p")?.textContent);
        const city = cityLine ? clean(cityLine.split(" - ")[0]) : "";

        const priceRaw = dollars(card.querySelector(".sb_todays_deals_card_price")?.textContent);
        const url = card.closest("a")?.href || card.querySelector("a")?.href || "";

        out.push({ name, city, priceRaw, url });
      }
      return out;
    });
  }

  // First page (also triggers lazy content by scrolling once)
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
  }

  const results = [];
  const seen = new Set();
  function pushUnique(list) {
    for (const h of list) {
      const key = `${(h.name || "").toLowerCase()}|${(h.city || "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(h);
      if (results.length >= maxHotels) return true;
    }
    return false;
  }

  // collect page 1
  let cards = await extractCards();
  pushUnique(cards);

  // pagination loop (URL does NOT change)
  for (let p = 2; p <= maxPages; p++) {
    const prevCount = (await page.$$("//div[contains(@class,'sb_todays_deals_card_ctn')]")).length;
    const firstNameBefore = cards[0]?.name || "";

    // Try common “next” targets (adjust if your markup differs)
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
            // wait for DOM change, not URL change
            page.waitForFunction(
              ({ prevCount, firstNameBefore }) => {
                const cards = Array.from(
                  document.querySelectorAll(".sb_todays_deals_card_ctn")
                );
                if (cards.length > prevCount) return true;
                const first = cards[0]
                  ?.querySelector(".sb_todays_deals_card_heading")
                  ?.textContent?.trim();
                return first && first !== firstNameBefore;
              },
              { polling: 200, timeout: 8000 },
              { prevCount, firstNameBefore }
            ).catch(() => null),
            loc.first().click(),
          ]);
          clicked = true;
          break;
        } catch {
          // try next selector
        }
      }
    }

    // If no explicit "Next", try numbered buttons not marked active
    if (!clicked) {
      const numberButtons = page.locator(
        'button[aria-current="false"], a[aria-current="false"], .pagination a, .pagination button'
      );
      const count = await numberButtons.count();
      for (let i = 0; i < count; i++) {
        const btn = numberButtons.nth(i);
        const label = (await btn.innerText().catch(() => ""))?.trim();
        if (!/^\d+$/.test(label)) continue; // only plain numbers
        try {
          await Promise.all([
            page.waitForFunction(
              ({ prevCount, firstNameBefore }) => {
                const cards = Array.from(
                  document.querySelectorAll(".sb_todays_deals_card_ctn")
                );
                if (cards.length > prevCount) return true;
                const first = cards[0]
                  ?.querySelector(".sb_todays_deals_card_heading")
                  ?.textContent?.trim();
                return first && first !== firstNameBefore;
              },
              { polling: 200, timeout: 8000 },
              { prevCount, firstNameBefore }
            ).catch(() => null),
            btn.click(),
          ]);
          clicked = true;
          break;
        } catch {
          // try next candidate
        }
      }
    }

    if (!clicked) break; // nothing clickable → stop

    // small settle time for any images/widgets
    await page.waitForTimeout(500);

    // collect this page
    cards = await extractCards();
    const done = pushUnique(cards);
    if (done) break;
  }

  await browser.close();
  return results;
}
