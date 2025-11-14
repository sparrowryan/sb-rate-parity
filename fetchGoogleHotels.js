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
 * DOM-based extraction: use the link whose aria-label mentions the hotel name
 * and read the .qQOQpe price span inside it.
 *
 * For your OYO example, this matches:
 *   <a aria-label="Prices starting from $44, OYO Hotel Orlando Airport"> ... <span class="qQOQpe">$44</span>
 */
async function extractPriceFromAriaLink(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);

    const anchors = Array.from(document.querySelectorAll('a[aria-label]'));

    for (const a of anchors) {
      const label = a.getAttribute("aria-label") || "";
      const labelNorm = norm(label);
      if (!labelNorm.includes(target) && !target.includes(labelNorm)) continue;

      // Within this link, find the main price span
      const priceSpan =
        a.querySelector(".qQOQpe") ||
        a.querySelector("span") ||
        a.querySelector("div");

      const text = (priceSpan?.textContent || "").trim();
      if (!/\$\s?\d/.test(text)) continue;

      const m = text.match(/\$\s?(\d[\d,]*)/);
      if (!m) continue;

      const num = Number(m[1].replace(/,/g, ""));
      if (!isFinite(num)) continue;

      return num;
    }

    return null;
  }, hotelName);
}

/**
 * Previous card-based method (kept as a secondary DOM strategy).
 */
async function extractPriceFromCard(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);

    const cardNodes = Array.from(
      document.querySelectorAll('[role="listitem"], div[jscontroller]')
    );

    for (const card of cardNodes) {
      const titleEl =
        card.querySelector("h2") ||
        card.querySelector("h3") ||
        card.querySelector('span[aria-level="2"]') ||
        card.querySelector("a span");

      const titleText = titleEl?.innerText || titleEl?.textContent || "";
      if (!titleText) continue;

      const tNorm = norm(titleText);
      if (!tNorm.includes(target) && !target.includes(tNorm)) continue;

      const textEls = Array.from(card.querySelectorAll("span, div"));
      const priceTexts = textEls
        .map((el) => el.innerText || el.textContent || "")
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter((t) => /\$\s?\d/.test(t));

      if (!priceTexts.length) continue;

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
 * Very last-resort fallback: body-text based extraction.
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
    || window.match(/\$\s?(\d[\d,]*)/);

  return m ? dollarsToNumber(m[0]) : null;
}

/**
 * Get ONE Google reference nightly price for a hotel for a specific date range.
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

    // Let dates & prices stabilize
    await page.waitForTimeout(5000);

    // Scroll to trigger lazy load of price components
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
    }

    await page.waitForTimeout(3000);

    // 1) Try the aria-label link strategy (should hit for OYO)
    let google_best = await extractPriceFromAriaLink(page, hotelName);
    console.log("[Google] aria-link price for", hotelName, "=", google_best);

    // 2) Try the older card strategy
    if (google_best == null) {
      google_best = await extractPriceFromCard(page, hotelName);
      console.log("[Google] card price for", hotelName, "=", google_best);
    }

    // 3) Last resort: body text
    if (google_best == null) {
      const bodyText = await page.evaluate(() => document.body.innerText || "");
      google_best = extractReferencePriceFromBody(bodyText, hotelName);
      console.log("[Google] body fallback price for", hotelName, "=", google_best);
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

