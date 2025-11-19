// scrapeSparrowBid.js
import { chromium } from "playwright";

/**
 * Scrape SparrowBid Explore with client-side pagination,
 * for a specific check-in / check-out date window.
 *
 * checkIn / checkOut must be "YYYY-MM-DD" strings.
 */
export async function getSparrowHotels({
  maxHotels = 100,
  maxPages = 40,
  checkIn,
  checkOut,
} = {}) {
  if (!checkIn || !checkOut) {
    throw new Error("getSparrowHotels: checkIn and checkOut are required");
  }

  // Build the same filters object SparrowBid uses in the URL
  const filtersObj = {
    check_in_date: `${checkIn}T06:00:00.000Z`,
    check_out_date: `${checkOut}T06:00:00.000Z`,
    dateRange: "Exact dates",
    adults: 2,
    child: 0,
    place: {
      geoLocation: { lat: "", lng: "" },
      address_1: "",
      city: "",
      state: "",
      country: "",
      zip: "",
      label: "",
    },
    page: 1,
  };

  // SparrowBid URL encodes this JSON twice (as you saw in your example URL)
  const filtersJson = JSON.stringify(filtersObj);
  const onceEncoded = encodeURIComponent(filtersJson);
  const twiceEncoded = encodeURIComponent(onceEncoded);

  const url = `https://www.sparrowbid.com/explore?filters=${twiceEncoded}`;
  console.log("Loading SparrowBid Explore URL:", url);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.goto(url, {
    waitUntil: "networkidle",
    timeout: 120000,
  });

  // Wait until at least one card is on the page
  await page.waitForSelector(".sb_todays_deals_card_ctn", { timeout: 20000 });

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
          url: "", // still synthesized later in index.js if needed
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
  console.log(
    `Page 1: collected ${cards.length} cards, total ${results.length}`
  );

  // -------- PAGINATION (using the "→" button) --------
  for (let pageIndex = 2; pageIndex <= maxPages; pageIndex++) {
    if (results.length >= maxHotels) break;

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
        await btn.click();
        clicked = true;
        break;
      } catch {
        // try next button if click fails
      }
    }

    if (!clicked) {
      console.log(
        "Could not click a usable Next button; stopping at page",
        pageIndex - 1
      );
      break;
    }

    // Give the page more time to re-render new cards
    await page.waitForTimeout(1500);

    // Retry a few times if we initially see 0 cards
    let retries = 0;
    while (retries < 3) {
      cards = await extractCards();
      if (cards.length > 0) break;
      retries++;
      console.log(
        `Page ${pageIndex}: 0 cards on attempt ${retries}, retrying after delay...`
      );
      await page.waitForTimeout(1000);
    }

    const done = pushUnique(cards);
    console.log(
      `Page ${pageIndex}: collected ${cards.length} cards (after ${retries} retries), total ${results.length}`
    );
    if (done) break;
  }

  await browser.close();
  return results;
}

