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
 * Try to set the desired date range using Google's date picker.
 * This version is much more defensive:
 *  - waits for Check-in input
 *  - clicks it to open calendar
 *  - waits for gridcells to exist
 *  - matches only on "Month D, YYYY" part of the aria-label
 *  - logs sample aria-labels if nothing matches
 */
async function setDateRangeInUi(page, checkIn, checkOut) {
  const checkInDate = dayjs(checkIn);
  const checkOutDate = dayjs(checkOut);

  if (!checkInDate.isValid() || !checkOutDate.isValid()) {
    console.warn("[Google] Invalid checkIn/checkOut passed to setDateRangeInUi", {
      checkIn,
      checkOut,
    });
    return;
  }

  const inLabelPart = checkInDate.format("MMMM D, YYYY");   // e.g. "November 26, 2025"
  const outLabelPart = checkOutDate.format("MMMM D, YYYY"); // e.g. "November 28, 2025"

  console.log("[Google] Trying to set dates via UI:", {
    checkIn,
    checkOut,
    inLabelPart,
    outLabelPart,
  });

  // 1) Wait for a Check-in input and click it to open the calendar
  const checkInInput = await page
    .waitForSelector('input[aria-label*="Check-in"]', { timeout: 20000 })
    .catch(() => null);

  if (!checkInInput) {
    console.warn("[Google] Could not find Check-in input; skipping date set.");
    return;
  }

  try {
    await checkInInput.click({ force: true });
  } catch (e) {
    console.warn("[Google] Failed to click Check-in input:", e.toString());
    return;
  }

  // 2) Wait for any gridcell to appear (calendar rendered)
  const firstCell = await page
    .waitForSelector('[role="gridcell"][aria-label]', { timeout: 20000 })
    .catch(() => null);

  if (!firstCell) {
    console.warn("[Google] No date gridcells appeared after opening calendar.");
    return;
  }

  // At this point, the calendar is up. We'll click dates via page.evaluate()
  async function clickDateByLabelPart(labelPart) {
    return await page.evaluate((needle) => {
      const cells = Array.from(
        document.querySelectorAll('[role="gridcell"][aria-label]')
      );
      const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const target = norm(needle);

      let clicked = false;

      for (const c of cells) {
        const lbl = c.getAttribute("aria-label") || "";
        if (norm(lbl).includes(target)) {
          // click the <div role="button"> wrapper if needed, otherwise the cell itself
          const btn = c.closest('[role="button"]') || c;
          (btn).dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true })
          );
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        // Surface some labels so we can debug mismatches
        const sample = cells.slice(0, 10).map((c) => c.getAttribute("aria-label"));
        console.warn(
          "[Google] Could not find any date cell containing:",
          needle,
          "Sample labels:",
          sample
        );
      }

      return clicked;
    }, labelPart);
  }

  const okIn = await clickDateByLabelPart(inLabelPart);
  // tiny pause before selecting checkout
  await page.waitForTimeout(300);
  const okOut = await clickDateByLabelPart(outLabelPart);

  // Click "Done"/"Apply"/"Save" if present
  const doneSelectors = [
    'button:has-text("Done")',
    'button:has-text("Apply")',
    'button:has-text("Save")',
  ];
  for (const sel of doneSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      try {
        await btn.click();
        break;
      } catch (e) {
        console.warn("[Google] Failed clicking date dialog button", sel, e.toString());
      }
    }
  }

  // Wait for prices to refresh after date change (a bit longer to be safe)
  await page.waitForTimeout(5000);

  console.log(
    "[Google] Date range set in UI via label parts",
    inLabelPart,
    "→",
    outLabelPart,
    "success:",
    okIn && okOut
  );
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
 * Get ONE Google reference nightly price for a hotel for a specific date range.
 * Expects explicit checkIn/checkOut (YYYY-MM-DD).
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
    console.log("[Google] Opening:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Let the base UI load
    await page.waitForTimeout(3000);

    // Try to set date range via UI to override Google's default dates
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

