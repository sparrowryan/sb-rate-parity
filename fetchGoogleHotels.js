// fetchGoogleHotels.js
import dayjs from "dayjs";
import { chromium } from "playwright";

/**
 * Utility: turn "$123" / "123" / "1,234" into number or null
 */
function dollarsToNumber(s) {
  const m = String(s || "").match(/(\d[\d,]*)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/**
 * Clean city text (drop “mi away”, keep just city/region)
 * "New York, US - 5385.12 mi away" → "New York, US"
 */
function cleanCity(cityRaw) {
  if (!cityRaw) return "";
  let c = String(cityRaw);
  c = c.split(" - ")[0];
  return c.trim();
}

/**
 * Build a Google Travel search URL using hotel name + city.
 */
export function makeGoogleSearchUrl(name, city) {
  const qParts = [];
  if (name) qParts.push(name);
  const cityClean = cleanCity(city);
  if (cityClean) qParts.push(cityClean);
  const q = encodeURIComponent(qParts.join(" "));
  return `https://www.google.com/travel/search?hl=en&gl=us&q=${q}`;
}

/**
 * Use the Google date picker UI to set the desired check-in/check-out.
 * We do this ONCE per hotel, then reuse those dates for both prices.
 */
async function setDateRangeInUi(page, checkIn, checkOut) {
  const inLabelPart = dayjs(checkIn).format("MMMM D, YYYY");   // "November 26, 2025"
  const outLabelPart = dayjs(checkOut).format("MMMM D, YYYY"); // "November 28, 2025"

  console.log("[Google] Trying to set dates via UI:", {
    checkIn,
    checkOut,
    inLabelPart,
    outLabelPart,
  });

  // 1) Open date picker by clicking the check-in input
  const checkInInput = page
    .locator('input[aria-label*="Check-in"], input[aria-label*="Check in"]')
    .first();

  try {
    await checkInInput.waitFor({ timeout: 15000 });
    await checkInInput.click();
  } catch (e) {
    console.warn("[Google] Could not open date picker:", e?.message || e);
    return;
  }

  // Wait for calendar gridcells to appear
  const gridcellSelector = '[role="gridcell"][aria-label]';
  try {
    await page.waitForSelector(gridcellSelector, { timeout: 8000 });
  } catch {
    console.warn("[Google] No date gridcells appeared after opening calendar.");
    return;
  }

  // Helper to click a date cell based on an aria-label containing the date text
  async function clickDateCellByPartialLabel(labelPart) {
    const sel = `${gridcellSelector}[aria-label*="${labelPart}"]`;
    const cell = await page.$(sel);
    if (!cell) {
      console.warn("[Google] Could not find date cell for label:", labelPart);
      return false;
    }
    await cell.click();
    return true;
  }

  const okIn = await clickDateCellByPartialLabel(inLabelPart);
  await page.waitForTimeout(300);
  const okOut = await clickDateCellByPartialLabel(outLabelPart);

  // Click Done / Apply / Save if present
  const doneSelectors = [
    'button:has-text("Done")',
    'button:has-text("Apply")',
    'button:has-text("Save")',
  ];
  for (const sel of doneSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        break;
      }
    } catch {
      // ignore
    }
  }

  await page.waitForTimeout(4000);

  // Log the values in the UI so we can confirm in logs
  const uiValues = await page.evaluate(() => {
    const inputs = document.querySelectorAll(
      'input[aria-label*="Check-in"], input[aria-label*="Check in"]'
    );
    const out = {
      uiCheckIn: inputs[0]?.value || null,
      uiCheckOut: inputs[1]?.value || null,
    };
    return out;
  });
  console.log("[Google] UI date inputs now:", uiValues);
}

/**
 * Extract the "Google best" nightly price from the hotel card
 * for the current selected dates.
 *
 * This is the method that has been working well.
 */
async function extractSelectedDatesPrice(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) =>
      (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);

    const anchors = Array.from(document.querySelectorAll("a[aria-label]"));

    for (const a of anchors) {
      const label = a.getAttribute("aria-label") || "";
      const labelNorm = norm(label);

      // Loose text match between card's aria-label and hotel name
      if (!labelNorm.includes(target) && !target.includes(labelNorm)) {
        continue;
      }

      // Inside that card anchor, find any spans/divs with dollar amounts
      const texts = [];
      const nodes = Array.from(a.querySelectorAll("span, div"));
      for (const n of nodes) {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (!/\$\s?\d/.test(t)) continue;
        texts.push(t);
      }
      if (!texts.length) continue;

      // Prefer something like "$44 nightly"
      const nightly = texts.find(
        (t) => /nightly/i.test(t) && /\$\s?\d/.test(t)
      );
      const chosen = nightly || texts[0];

      const m = chosen.match(/\$\s?(\d[\d,]*)/);
      if (!m) continue;
      const num = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(num)) continue;

      return num;
    }

    return null;
  }, hotelName);
}

/**
 * Experimental: extract lowest OTA price restricted to “major” OTAs.
 * This is *guard-railed*:
 *  - If anything looks off, returns null instead of bad data.
 *  - We never throw — errors are caught and logged.
 */
async function getGoogleMajorBest(page, hotelName) {
  try {
    // Try to click a "View prices" button. We *do not* re-touch dates here,
    // we rely on the global date filter already being set.
    const viewBtn = page.locator('button:has-text("View prices")').first();
    const count = await viewBtn.count();
    if (!count) {
      console.log("[Google major] No 'View prices' button found; returning null.");
      return null;
    }

    await viewBtn.click({ timeout: 15000 });
    await page.waitForTimeout(4000);

    // Check the main H1 hotel name on the view-prices/overlay/detail panel
    const h1Locator = page.locator("h1").first();
    const h1Text = (await h1Locator.textContent().catch(() => null)) || "";
    const norm = (s) =>
      (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

    const target = norm(hotelName);
    const got = norm(h1Text);

    if (!target || !got) {
      console.log(
        "[Google major] Missing names for fuzzy match; returning null.",
        { target, got }
      );
      return null;
    }

    // Simple fuzzy: require that either string includes the other
    if (!(got.includes(target) || target.includes(got))) {
      console.log("[Google major] H1 does not match hotel name; returning null.", {
        hotelName,
        h1Text,
      });
      return null;
    }

    // Now we are reasonably confident we’re on the right hotel.
    // Extract OTA tiles and take the minimum across major OTAs.
    const majorBest = await page.evaluate(() => {
      const MAJORS = [
        "expedia",
        "booking.com",
        "priceline",
        "kayak",
        "hotels.com",
        "orbitz",
        "travelocity",
      ];

      const norm = (s) => (s || "").toLowerCase();
      const containers = Array.from(document.querySelectorAll(".ADs2Tc"));
      const prices = [];

      for (const block of containers) {
        const nameEl = block.querySelector("h3, h4");
        if (!nameEl) continue;

        const providerName = norm(nameEl.textContent || "");
        const isMajor = MAJORS.some((m) => providerName.includes(m));
        if (!isMajor) continue;

        // Grab any dollar amounts in the usual price spans
        const spans = block.querySelectorAll("span.iqYCVb, span");
        for (const sp of spans) {
          const text = (sp.textContent || "").trim();
          const m = text.match(/\$\s?(\d[\d,]*)/);
          if (!m) continue;
          const num = Number(m[1].replace(/,/g, ""));
          if (Number.isFinite(num)) {
            prices.push(num);
          }
        }
      }

      if (!prices.length) return null;
      return Math.min(...prices);
    });

    console.log("[Google major] majorBest:", majorBest);
    return majorBest;
  } catch (e) {
    console.log("[Google major] Error while getting major best:", e?.message || e);
    return null;
  }
}

/**
 * Main entry: Get Google reference prices for a specific hotel + date range.
 *
 * Returns:
 *  {
 *    check_in: "YYYY-MM-DD",
 *    check_out: "YYYY-MM-DD",
 *    url: "https://www.google.com/travel/search?...",
 *    google_best: number | null,
 *    google_major_best: number | null
 *  }
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
    await page.waitForTimeout(3000);

    // Set date range via UI (global filter)
    await setDateRangeInUi(page, checkIn, checkOut);

    // Scroll to encourage cards/tooltips to render
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
    }

    // 1) This is the trusted metric we already know works reasonably well
    const google_best = await extractSelectedDatesPrice(page, hotelName);
    console.log(
      "[Google] selected-dates price for",
      hotelName,
      "=",
      google_best,
      "URL:",
      url
    );

    // 2) Experimental major-OTA best, heavily guard-railed
    const google_major_best = await getGoogleMajorBest(page, hotelName);

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



