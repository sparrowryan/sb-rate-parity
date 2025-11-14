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

// Build a Google Travel search URL WITHOUT trusting dates
export function makeGoogleSearchUrl(name, city) {
  const qParts = [];
  if (name) qParts.push(name);
  const cityClean = cleanCity(city);
  if (cityClean) qParts.push(cityClean);
  const q = encodeURIComponent(qParts.join(" "));
  return `https://www.google.com/travel/search?hl=en&gl=us&q=${q}`;
}

/**
 * Use the actual Google date picker to set the desired check-in/check-out.
 * This avoids Google silently overriding or ignoring URL date params.
 */
async function setDateRangeInUi(page, checkIn, checkOut) {
  const checkInLabel = dayjs(checkIn).format("dddd, MMMM D, YYYY");   // e.g. "Friday, November 21, 2025"
  const checkOutLabel = dayjs(checkOut).format("dddd, MMMM D, YYYY"); // e.g. "Sunday, November 23, 2025"

  // 1) Open date picker (button/element with "Check-in" in aria-label or text)
  const openSelectors = [
    'button[aria-label*="Check-in"]',
    'button[aria-label*="Check in"]',
    '[role="button"][aria-label*="Check-in"]',
    '[role="button"]:has-text("Check-in")',
  ];

  let opened = false;
  for (const sel of openSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click();
      opened = true;
      break;
    }
  }

  if (!opened) {
    console.warn("[Google] Could not find date picker opener; dates may default.");
    return;
  }

  // Small delay for calendar to render
  await page.waitForTimeout(1000);

  // Helper to click a date cell by aria-label substring
  async function clickDateByLabel(labelText) {
    const selector = `[role="gridcell"][aria-label*="${labelText}"]`;
    const cell = await page.$(selector);
    if (!cell) {
      console.warn("[Google] Could not find date cell for:", labelText);
      return false;
    }
    await cell.click();
    return true;
  }

  const okIn = await clickDateByLabel(checkInLabel);
  await page.waitForTimeout(300);
  const okOut = await clickDateByLabel(checkOutLabel);

  // Click "Done" / "Apply" if present
  const doneSelectors = [
    'button:has-text("Done")',
    'button:has-text("Apply")',
    'button:has-text("Save")',
  ];
  for (const sel of doneSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click();
      break;
    }
  }

  // Wait for prices to refresh after date change
  await page.waitForTimeout(4000);

  console.log("[Google] Date range set in UI to", checkInLabel, "→", checkOutLabel, "success:", okIn && okOut);
}

/**
 * Extract nightly price for the selected dates from the hotel card:
 *  1) Find <a> whose aria-label roughly matches the hotel name
 *  2) Inside that <a>, prefer text like "$44 nightly"
 *  3) If not found, fall back to first "$XX" inside the same <a>
 */
async function extractSelectedDatesPrice(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);

    const anchors = Array.from(document.querySelectorAll('a[aria-label]'));

    for (const a of anchors) {
      const label = a.getAttribute("aria-label") || "";
      const labelNorm = norm(label);

      // Loose match: label contains hotel name or vice versa
      if (!labelNorm.includes(target) && !target.includes(labelNorm)) continue;

      // Collect all span/div texts inside this anchor with dollar amounts
      const texts = [];
      const nodes = Array.from(a.querySelectorAll("span, div"));
      for (const n of nodes) {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (!/\$\s?\d/.test(t)) continue;
        texts.push(t);
      }

      if (!texts.length) continue;

      // Prefer "$XX nightly"
      const nightly = texts.find((t) => /nightly/i.test(t) && /\$\s?\d/.test(t));
      const chosenText = nightly || texts[0];

      const m = chosenText.match(/\$\s?(\d[\d,]*)/);
      if (!m) continue;
      const num = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(num)) continue;

      return num;
    }

    return null;
  }, hotelName);
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

  const url = makeGoogleSearchUrl(hotelName, city);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Let the base UI load
    await page.waitForTimeout(3000);

    // Explicitly set date range via UI to override Google's default dates
    await setDateRangeInUi(page, checkIn, checkOut);

    // Scroll a bit so cards & tooltips render
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
    }

    // Extract nightly price from the hotel card for these dates
    const google_best = await extractSelectedDatesPrice(page, hotelName);
    console.log(
      "[Google] selected-dates price for",
      hotelName,
      "=",
      google_best,
      "URL:",
      url
    );

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

