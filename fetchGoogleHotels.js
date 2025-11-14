// fetchGoogleHotels.js
import dayjs from "dayjs";
import { chromium } from "playwright";

function dollarsToNumber(s) {
  const m = String(s || "").match(/(\d[\d,]*)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

// Clean city text (drop “mi away”, keep just the city/region part)
function cleanCity(cityRaw) {
  if (!cityRaw) return "";
  let c = String(cityRaw);
  // "New York, US - 5385.12 mi away" → "New York, US"
  c = c.split(" - ")[0];
  return c.trim();
}

// Build Google Travel search URL with explicit dates
export function makeGoogleSearchUrl(name, city, checkIn, checkOut) {
  const qParts = [];
  if (name) qParts.push(name);
  const cityClean = cleanCity(city);
  if (cityClean) qParts.push(cityClean);
  const q = encodeURIComponent(qParts.join(" "));
  return `https://www.google.com/travel/search?hl=en&gl=us&q=${q}&checkin=${checkIn}&checkout=${checkOut}`;
}

/**
 * Try to extract price directly from the hotel result card DOM.
 * We:
 *  - find cards (role=listitem etc)
 *  - locate the one whose title text matches the hotelName
 *  - inside that card, find the first "$XX ... night" (or just "$XX")
 */
async function extractPriceFromCard(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);

    // Candidate selectors for hotel cards
    const cardNodes = Array.from(
      document.querySelectorAll('[role="listitem"], div[jscontroller]')
    );

    for (const card of cardNodes) {
      // Try a few possible title elements inside the card
      const titleEl =
        card.querySelector("h2") ||
        card.querySelector("h3") ||
        card.querySelector('span[aria-level="2"]') ||
        card.querySelector("a span");

      const titleText = titleEl?.innerText || titleEl?.textContent || "";
      if (!titleText) continue;

      const tNorm = norm(titleText);

      // Require some overlap; allow partial match either way
      if (!tNorm.includes(target) && !target.includes(tNorm)) continue;

      // Now find price text inside this card
      const textEls = Array.from(card.querySelectorAll("span, div"));
      const priceTexts = textEls
        .map((el) => el.innerText || el.textContent || "")
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter((t) => /\$\s?\d/.test(t));

      if (!priceTexts.length) continue;

      // Prefer entries that mention "night" (e.g., "$44 per night")
      const withNight = priceTexts.filter((t) => /night/i.test(t));
      const chosen = withNight.length ? withNight[0] : priceTexts[0];

      const m = chosen.match(/\$\s?(\d[\d,]*)/);
      if (!m) continue;

      const num = Number(m[1].replace(/,/g, ""));
      if (!isFinite(num)) continue;

      return num;
    }

    return null;
  }, hotelName);
}

/**
 * Fallback: body-text based extraction, scanning around the hotel name.
 */
function extractReferencePriceFromBody(text, hotelName) {
  if (!text) return null;

  const full = String(text);
  const lower = full.toLowerCase();
  const target = String(hotelName || "").toLowerCase().trim();

  let startIndex = 0;
  if (target && lower.includes(target)) {
    startIndex = lower.indexOf(target);
  }

  const window = full.slice(startIndex, startIndex + 2000);
  const m = window.match(/\$\s?(\d[\d,]*)\s*(?:per\s*night|\/\s*night)?/i)
    || window.match(/\$\s?(\d[\d,]*)/); // last-resort, just first $

  return m ? dollarsToNumber(m[0]) : null;
}

/**
 * Get ONE Google reference nightly price for a hotel for a specific date range.
 * - Takes explicit checkIn/checkOut strings ("YYYY-MM-DD")
 * - Returns { check_in, check_out, url, google_best }
 */
export async function getGoogleHotelsPriceSimple(
  hotelName,
  city,
  { checkIn, checkOut }
) {
  if (!checkIn || !checkOut) {
    throw new Error("getGoogleHotelsPriceSimple: checkIn and checkOut are required");
  }

  const url = makeGoogleSearchUrl(hotelName, city, checkIn, checkOut);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Let dates & prices stabilize (avoid "flash" prices)
    await page.waitForTimeout(5000);

    // Scroll to trigger lazy load of price components
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
    }

    // Extra settle time for late-updating prices
    await page.waitForTimeout(3000);

    // 1) Try DOM-based card extraction (what you see visually)
    let google_best = await extractPriceFromCard(page, hotelName);

    // 2) Fallback to body-text method if needed
    if (google_best == null) {
      const bodyText = await page.evaluate(() => document.body.innerText || "");
      google_best = extractReferencePriceFromBody(bodyText, hotelName);
    }

    return {
      check_in: checkIn,
      check_out: checkOut,
      url,
      google_best,
    };
  } finally {
    await browser.close();
  }
}

