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

// Build a Google Travel search URL
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
 * This version matches the markup you pasted:
 *   <div class="eoY5cb ... yCya5" aria-label="Friday, November 21, 2025, departure date.">21</div>
 * and clicks its nearest role="button" wrapper, then clicks "Done" to close.
 */
async function setDateRangeInUi(page, checkIn, checkOut) {
  const inLabelPart = dayjs(checkIn).format("MMMM D, YYYY");   // e.g. "November 27, 2025"
  const outLabelPart = dayjs(checkOut).format("MMMM D, YYYY"); // e.g. "November 29, 2025"

  console.log("[Google] Trying to set dates via UI:", {
    checkIn,
    checkOut,
    inLabelPart,
    outLabelPart,
  });

  // 1) Click the Check-in input to open the calendar
  const inputLocator = page.locator(
    'input[aria-label*="Check-in"], input[aria-label*="Check in"]'
  );

  try {
    await inputLocator.first().click({ timeout: 15000 });
  } catch (err) {
    console.warn("[Google] Could not click check-in input:", err.message);
    return false;
  }

  // Give the calendar time to render
  await page.waitForTimeout(1500);

  // Helper: click a specific date cell by its aria-label substring
  async function clickDate(labelPart) {
    // Matches:
    // <div class="eoY5cb ... yCya5" aria-label="Wednesday, November 26, 2025, departure date.">26</div>
    const cell = page.locator(`[aria-label*="${labelPart}"]`).first();

    try {
      await cell.waitFor({ state: "visible", timeout: 5000 });

      // If it has a button wrapper (role="button"), click that wrapper, otherwise the cell itself
      const buttonAncestor = cell.locator("xpath=ancestor-or-self::*[@role='button'][1]");
      if (await buttonAncestor.count()) {
        await buttonAncestor.first().click();
      } else {
        await cell.click();
      }
      return true;
    } catch (err) {
      console.warn("[Google] Could not find/click date cell for label:", labelPart, err.message);
      return false;
    }
  }

  const okIn = await clickDate(inLabelPart);
  await page.waitForTimeout(300);
  const okOut = await clickDate(outLabelPart);

  // 2) Click the Done button to close the calendar overlay
  try {
    // Your markup:
    // <span jsname="V67aGc" class="VfPpkd-vQzf8d">Done</span>
    const doneSpan = page.locator('button span:has-text("Done")').first();
    await doneSpan.waitFor({ state: "visible", timeout: 5000 });
    await doneSpan.click();
  } catch (err) {
    console.warn("[Google] Could not find 'Done' button to close calendar:", err.message);
  }

  // Give prices/DOM time to refresh and the overlay time to disappear
  await page.waitForTimeout(3000);

  // 3) Log what the UI thinks the dates are now (for debugging)
  const uiDates = await page.evaluate(() => {
    const getVal = (needle) => {
      const el =
        document.querySelector(`input[aria-label*="${needle}"]`) ||
        document.querySelector(`input[aria-label*="${needle.replace("-", " ")}"]`);
      return el ? el.value : null;
    };
    return {
      uiCheckIn: getVal("Check-in") || getVal("Check in"),
      uiCheckOut: getVal("Check-out") || getVal("Check out"),
    };
  });

  console.log("[Google] UI date inputs now:", uiDates);

  // Return whether both clicks looked successful.
  return okIn && okOut;
}

/**
 * Extract nightly price for the selected dates from the hotel card:
 *  1) Find <a> whose aria-label roughly matches the hotel name
 *  2) Inside that <a>, prefer text like "$44 nightly"
 *  3) If not found, fall back to first "$XX" inside the same <a>
 *
 * This is the "Google Best" (all OTAs, Google's primary card price).
 */
async function extractSelectedDatesPrice(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);

    const anchors = Array.from(document.querySelectorAll("a[aria-label]"));

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
 * Grab the cheapest rate among MAJOR OTAs (Expedia, Booking.com, etc.)
 * AFTER dates are set and (ideally) the "View prices" panel is open.
 *
 * If anything goes sideways, this returns null and we DON'T reuse Google Best.
 */
async function getMajorOtaBest(page) {
  const MAJOR = [
    "expedia",
    "booking.com",
    "priceline",
    "kayak",
    "hotels.com",
    "orbitz",
    "travelocity",
  ];

  try {
    // Try to click "View prices" to open the OTA list for this property.
    const viewBtn = page.locator('button:has-text("View prices")').first();
    await viewBtn.waitFor({ state: "visible", timeout: 15000 });
    await viewBtn.click();
  } catch (err) {
    console.warn(
      "[Google major] No usable 'View prices' button found; maybe already expanded or blocked.",
      err.message
    );
  }

  // Give the OTA panel time to render
  await page.waitForTimeout(3000);

  try {
    const best = await page.evaluate((majorList) => {
      const MAJOR = majorList.map((m) => m.toLowerCase());
      const toNorm = (s) => (s || "").toLowerCase();

      let best = null;

      // Each OTA block appears as a big container; your Expedia snippet was inside ".ADs2Tc"
      const providerBlocks = Array.from(document.querySelectorAll(".ADs2Tc"));
      for (const block of providerBlocks) {
        const text = block.textContent || "";
        const lower = toNorm(text);

        // Skip blocks that don't mention any major OTA names
        if (!MAJOR.some((name) => lower.includes(name))) continue;

        // Collect all dollar amounts inside this block
        const priceNodes = Array.from(block.querySelectorAll("span, div"));
        for (const node of priceNodes) {
          const t = (node.textContent || "").replace(/\s+/g, " ").trim();
          if (!/\$\s?\d/.test(t)) continue;
          const m = t.match(/\$\s?(\d[\d,]*)/);
          if (!m) continue;
          const v = Number(m[1].replace(/,/g, ""));
          if (!Number.isFinite(v)) continue;
          if (best === null || v < best) best = v;
        }
      }

      return best;
    }, MAJOR);

    return best;
  } catch (err) {
    console.warn("[Google major] Error while getting major best:", err.message);
    return null;
  }
}

/**
 * Get ONE Google reference nightly price for a hotel for a specific date range.
 *
 * - google_best: lowest nightly price Google surfaces on the main card (any OTA)
 * - google_major_best: lowest nightly price among major OTAs only
 *
 * If major OTA scraping fails, google_major_best will be null (we don't reuse google_best).
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
  console.log("[Google] Opening:", url);

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

    // Extract nightly price from the hotel card for these dates (Google Best)
    const google_best = await extractSelectedDatesPrice(page, hotelName);

    console.log(
      "[Google] selected-dates price for",
      hotelName,
      "=",
      google_best,
      "URL:",
      url
    );

    // Try to extract major-OTA-only best price; if anything fails, we log & return null
    let google_major_best = null;
    try {
      google_major_best = await getMajorOtaBest(page);
    } catch (err) {
      console.warn("[Google major] Error while getting major best:", err.message);
      google_major_best = null;
    }

    const result = {
      check_in: checkIn,
      check_out: checkOut,
      url,
      google_best,
      google_major_best,
    };

    console.log("[Google] result object:", result);
    return result;
  } finally {
    await browser.close();
  }
}



