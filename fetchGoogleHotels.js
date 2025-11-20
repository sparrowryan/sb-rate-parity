// fetchGoogleHotels.js
import dayjs from "dayjs";
import { chromium } from "playwright";

// Build a Google Travel search URL
function cleanCity(cityRaw) {
  if (!cityRaw) return "";
  let c = String(cityRaw);
  c = c.split(" - ")[0]; // "New York, US - 5385 mi away" → "New York, US"
  return c.trim();
}

export function makeGoogleSearchUrl(name, city) {
  const qParts = [];
  if (name) qParts.push(name);
  const cityClean = cleanCity(city);
  if (cityClean) qParts.push(cityClean);
  const q = encodeURIComponent(qParts.join(" "));
  return `https://www.google.com/travel/search?hl=en&gl=us&q=${q}`;
}

/**
 * Try to set the date range via the *actual* calendar UI.
 * Returns { success, uiCheckIn, uiCheckOut } where uiCheckIn/out are the strings
 * shown in the input boxes (e.g. "Wed, Nov 26").
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

  // 1) Open the date picker via the Check-in input
  const dateInput = page.locator(
    'input[aria-label*="Check-in"], input[aria-label*="Check in"]'
  );
  if ((await dateInput.count()) === 0) {
    console.warn("[Google] No Check-in input found; cannot open calendar.");
    return { success: false, uiCheckIn: "", uiCheckOut: "" };
  }

  await dateInput.first().click();
  // Give the calendar time to appear
  await page.waitForTimeout(1500);

  // 2) Wait for date cells to appear (the real calendar selector you captured)
  try {
    await page
      .locator('div[jsname="nEWxA"][aria-label]')
      .first()
      .waitFor({ timeout: 5000 });
  } catch {
    console.warn("[Google] No date cells (div[jsname='nEWxA']) appeared after opening calendar.");
  }

  // Helper to click a date cell by part of its aria-label
  async function clickDateByLabelPart(labelPart) {
    if (!labelPart) return false;
    const locator = page.locator(
      `div[role="button"] div[jsname="nEWxA"][aria-label*="${labelPart}"]`
    );
    const count = await locator.count();
    if (!count) {
      console.warn("[Google] Could not find date cell for label part:", labelPart);
      return false;
    }
    try {
      await locator.first().click();
      return true;
    } catch (err) {
      console.warn("[Google] Failed clicking date cell for:", labelPart, String(err));
      return false;
    }
  }

  const okIn = await clickDateByLabelPart(inLabelPart);
  await page.waitForTimeout(300);
  const okOut = await clickDateByLabelPart(outLabelPart);

  // "Done"/"Apply" if present
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
      } catch {
        // ignore
      }
    }
  }

  // Wait for prices to refresh after date change
  await page.waitForTimeout(4000);

  // Read back what the UI actually shows
  const { uiCheckIn, uiCheckOut } = await page.evaluate(() => {
    const inEl =
      document.querySelector('input[aria-label*="Check-in"], input[aria-label*="Check in"]');
    const outEl =
      document.querySelector('input[aria-label*="Check-out"], input[aria-label*="Check out"]');
    return {
      uiCheckIn: inEl?.value || "",
      uiCheckOut: outEl?.value || "",
    };
  });

  console.log("[Google] UI date inputs now:", { uiCheckIn, uiCheckOut });

  return { success: okIn && okOut, uiCheckIn, uiCheckOut };
}

/**
 * Extract prices from the page for the current date range.
 * - lowestAll: lowest nightly price from *any* OTA (all providers)
 * - lowestMajor: lowest nightly price among major OTAs:
 *   Expedia, Booking.com, Priceline, Kayak, Hotels.com, Orbitz, Travelocity
 *
 * Uses the provider rows you showed (class ADs2Tc, span.iqYCVb, h3.RjilDd).
 */
async function extractPriceSummary(page) {
  return await page.evaluate(() => {
    const priceRegex = /\$\s?(\d[\d,]*)/;
    const parsePrice = (text) => {
      if (!text) return null;
      const t = String(text).replace(/\s+/g, " ").trim();
      const m = t.match(priceRegex);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    };

    // 1) Lowest price among *all* OTAs (any provider)
    const allPrices = [];
    const priceSpans = document.querySelectorAll("span.iqYCVb");
    priceSpans.forEach((el) => {
      const num = parsePrice(el.textContent || "");
      if (Number.isFinite(num)) allPrices.push(num);
    });

    // 2) Lowest price among major OTAs only
    const majorBrands = [
      "expedia",
      "booking.com",
      "priceline",
      "kayak",
      "hotels.com",
      "orbitz",
      "travelocity",
    ];
    const majorPrices = [];

    const providerBlocks = document.querySelectorAll(".ADs2Tc");
    providerBlocks.forEach((block) => {
      const nameEl = block.querySelector("h3.RjilDd");
      if (!nameEl) return;

      const providerName = (nameEl.textContent || "").trim().toLowerCase();
      const isMajor = majorBrands.some((brand) => providerName.includes(brand));
      if (!isMajor) return;

      const blockPrices = [];
      const spans = block.querySelectorAll("span.iqYCVb");
      spans.forEach((s) => {
        const num = parsePrice(s.textContent || "");
        if (Number.isFinite(num)) blockPrices.push(num);
      });

      if (blockPrices.length) {
        const minForProvider = Math.min(...blockPrices);
        majorPrices.push(minForProvider);
      }
    });

    const lowestAll = allPrices.length ? Math.min(...allPrices) : null;
    const lowestMajor = majorPrices.length ? Math.min(...majorPrices) : null;

    return { lowestAll, lowestMajor };
  });
}

/**
 * Get ONE Google reference nightly price for a hotel for a specific date range.
 * We ONLY trust the price if the UI dates contain the requested month+day.
 *
 * Returned fields:
 *   - check_in
 *   - check_out
 *   - url
 *   - google_best          → lowest OTA overall (all providers)
 *   - google_major_best    → lowest OTA among the specified major brands
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

    // Set date range via UI and read back the actual dates shown
    const setRes = await setDateRangeInUi(page, checkIn, checkOut);

    // Check if the UI actually shows the dates we wanted (by month+day)
    const wantInShort = dayjs(checkIn).format("MMM D");   // "Nov 26"
    const wantOutShort = dayjs(checkOut).format("MMM D"); // "Nov 28"
    const uiIn = setRes.uiCheckIn || "";
    const uiOut = setRes.uiCheckOut || "";

    const datesMatch =
      uiIn.includes(wantInShort) &&
      uiOut.includes(wantOutShort);

    if (!datesMatch) {
      console.warn("[Google] Date mismatch – skipping price for hotel:", hotelName, {
        requestedCheckIn: checkIn,
        requestedCheckOut: checkOut,
        uiCheckIn: uiIn,
        uiCheckOut: uiOut,
      });

      return {
        check_in: checkIn,
        check_out: checkOut,
        url,
        google_best: null,
        google_major_best: null,
      };
    }

    // Scroll a bit so cards & tooltips render
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
    }

    // Extract price summary for these dates
    const { lowestAll, lowestMajor } = await extractPriceSummary(page);
    console.log("[Google] price summary for", hotelName, "=", {
      lowestAll,
      lowestMajor,
    });

    return {
      check_in: checkIn,
      check_out: checkOut,
      url,
      google_best: lowestAll,        // lowest OTA overall
      google_major_best: lowestMajor // lowest among major OTAs
    };
  } finally {
    await browser.close();
  }
}


