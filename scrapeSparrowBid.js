import { chromium } from "playwright";

export async function getSparrowHotels({ maxHotels = 600, maxPages = 40 } = {}) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.goto("https://www.sparrowbid.com/explore", {
    waitUntil: "networkidle",
    timeout: 120000,
  });

  // Wait until at least one card is on the page
  await page.waitForSelector(".sb_todays_deals_card_ctn", { timeout: 15000 });

  async function extractCards() {
    return await page.$$eval(".sb_todays_deals_card_ctn", (cards) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const dollars = (s) => {
        const m = String(s || "").match(/\$\s?\d[\d,]*/);
        return m ? m[0] : null;
      };

      const out = [];
      for (const card of cards) {
        const name = clean(
          card.querySelector(".sb_todays_deals_card_heading")?.textContent
        );
        if (!name) continue;

        // Example: "New York, US - 5385.12 mi away" → "New York, US"
        const cityLine = clean(
          card.querySelector(".sb_todays_deals_card_country_ctn p")
            ?.textContent
        );
        const city = cityLine ? clean(cityLine.split(" - ")[0]) : "";

        const priceRaw = dollars(
          card.querySelector(".sb_todays_deals_card_price")?.textContent
        );

        out.push({
          name,
          city,
          priceRaw,
          url: "", // cards don't expose a direct link; we can add click-through later if needed
        });
      }
      return out;
    });
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

  // -------- PAGE 1 --------
  let cards = await extractCards();
  pushUnique(cards);

  // -------- PAGINATION (using the "→" button) --------
  for (let pageIndex = 2; pageIndex <= maxPages; pageIndex++) {
    if (results.length >= maxHotels) break;

    const beforeFirstName = cards[0]?.name || "";

    // Find all buttons that have the arrow text "→"
    const nextButtons = page.locator('button:has-text("→")');
    const count = await nextButtons.count();
    if (!count) {
      console.log("No Next button found; stopping at page", pageIndex - 1);
      break;
    }

    let clicked = false;
    for (let i = 0; i < count; i++) {
      const btn = nextButtons.nth(i);
      const disabledAttr = await btn.getAttribute("disabled");
      if (disabledAttr !== null) continue; // skip disabled buttons

      try {
        await Promise.all([
          // wait for first card’s name to change (or timeout)
          page
            .waitForFunction(
              (prev) => {
                const card = document.querySelector(
                  ".sb_todays_deals_card_ctn .sb_todays_deals_card_heading"
                );
                if (!card) return false;
                const now = card.textContent?.trim() || "";
                return now && now !== prev;
              },
              { timeout: 8000, polling: 200 },
              beforeFirstName
            )
            .catch(() => null),
          btn.click(),
        ]);
        clicked = true;
        break;
      } catch {
        // try next button if this one fails
      }
    }

    if (!clicked) {
      console.log("Could not click a usable Next button; stopping at page", pageIndex - 1);
      break;
    }

    // small settle time for the new page of cards
    await page.waitForTimeout(800);

    cards = await extractCards();
    const done = pushUnique(cards);
    console.log(`Page ${pageIndex}: collected ${cards.length} cards, total ${results.length}`);
    if (done) break;
  }

  await browser.close();
  return results;
}
