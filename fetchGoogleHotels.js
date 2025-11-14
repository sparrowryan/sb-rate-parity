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
 * Extract a single "reference" nightly price by:
 *  - finding the first occurrence of the hotel name in body text (if present)
 *  - scanning the next ~2000 characters for the first "$123" (optionally "per night")
 */
function extractReferencePrice(text, hotelName) {
  if (!text) return null;

  const full = String(text);
  const lower = full.toLowerCase();
  const target = String(hotelName || "").toLowerCase().trim();

  // Start scanning near the hotel name if we can find it, otherwise from top
  let startIndex = 0;
  if (target && lower.includes(target)) {
    startIndex = lower.indexOf(target);
  }

  const window = full.slice(startIndex, startIndex + 2000);
  const m = window.match(/\$\s?(\d[\d,]*)\s*(?:per\s*night|\/\s*night)?/i);
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

    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const google_best = extractReferencePrice(bodyText, hotelName);

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
