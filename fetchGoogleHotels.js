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
 * Try to set the date range via the *actual* calendar UI.
 * Returns { success, uiCheckIn, uiCheckOut } where uiCheckIn/out are the strings
 * shown in the input boxes (e.g. "Wed, Nov 26").
 */
async function setDateRangeInUi(page, checkIn, checkOut) {
  const inLabelPart = dayjs(checkIn).format("MMMM D, YYYY");   // e.g. "November 26, 2025"
  const outLabelPart = dayjs(checkOut).format("MMMM D, YYYY"); // e.g. "November 28, 2025"

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

  // 2) Wait for date cells to appear (your real selector)
  try {
    await page
      .locator('div[jsname="nEWxA"][aria-label]')
      .first()
      .waitFor({ timeout: 5000 });
  } catch {
    console.warn("[Google] No date cells (div[jsname='nEWxA']) appeared after opening calendar.");
    // still continue, but success likely false
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

  // Sometimes there's a Done/Apply button; try to click if present, but it's optional
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
 * Extract nightly price for the selected dates from the hotel card:
 *  1) Find <a> whose aria-label roughly matches the hotel name
 *  2) Inside that <a>, look for any "$XX" text, prefer "$XX nightly" if present
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
 * We ONLY trust the price if the UI dates contain the requested month+day.
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

    // Try to set date range via UI
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
      };
    }

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

