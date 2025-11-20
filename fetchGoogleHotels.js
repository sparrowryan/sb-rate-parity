// fetchGoogleHotels.js
import dayjs from "dayjs";
import { chromium } from "playwright";

// ----- URL helpers -----

function cleanCity(cityRaw) {
  if (!cityRaw) return "";
  let c = String(cityRaw);
  // "New York, US - 5385.12 mi away" → "New York, US"
  c = c.split(" - ")[0];
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

// ----- Date selection in UI -----

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
  await page.waitForTimeout(1500); // let calendar open

  // 2) Wait for date cells to appear (your real calendar selector)
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

  // Click Done / Apply / Save if present
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

// ----- Fallback / main-card price (this was working) -----

async function extractSelectedDatesPrice(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);

    const anchors = Array.from(document.querySelectorAll('a[aria-label]'));
    const priceRegex = /\$\s?(\d[\d,]*)/;

    for (const a of anchors) {
      const label = a.getAttribute("aria-label") || "";
      const labelNorm = norm(label);

      // Loose match: label contains hotel name or vice versa
      if (!labelNorm.includes(target) && !target.includes(labelNorm)) continue;

      const texts = [];
      const nodes = Array.from(a.querySelectorAll("span, div"));
      for (const n of nodes) {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (!priceRegex.test(t)) continue;
        texts.push(t);
      }

      if (!texts.length) continue;

      // Prefer "$XX nightly"
      const nightly = texts.find((t) => /nightly/i.test(t) && priceRegex.test(t));
      const chosenText = nightly || texts[0];

      const m = chosenText.match(priceRegex);
      if (!m) continue;
      const num = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(num)) continue;

      return num;
    }

    return null;
  }, hotelName);
}

// ----- "View prices" and major-provider parsing -----

async function openViewPricesIfExists(page) {
  const btn = page.locator('button:has-text("View prices")');
  const count = await btn.count();
  if (!count) {
    console.log("[Google] No 'View prices' button found; maybe already expanded.");
    return false;
  }
  try {
    await btn.first().click();
    await page.waitForTimeout(3000); // give panel time to load providers
    console.log("[Google] Clicked 'View prices' button.");
    return true;
  } catch (err) {
    console.warn("[Google] Failed to click 'View prices':", String(err));
    return false;
  }
}

async function extractMajorProviderPrice(page) {
  return await page.evaluate(() => {
    const priceRegex = /\$\s?(\d[\d,]*)/;
    const parsePrice = (text) => {
      if (!text) return null;
      const t = String(text).replace(/\s+/g, " ").trim();
      const m = t.match(priceRegex);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    };

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

    if (!majorPrices.length) return null;
    return Math.min(...majorPrices);
  });
}

// ----- Main exported function -----

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
    await page.waitForTimeout(3000); // initial load

    // 1) Set date range via UI and read back actual dates
    const setRes = await setDateRangeInUi(page, checkIn, checkOut);

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

    // 2) Scroll a bit to ensure cards & buttons render
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
    }

    // 3) FIRST: do the same safe "headline" extraction we already know works
    const google_best = await extractSelectedDatesPrice(page, hotelName);
    console.log("[Google] selected-dates price for", hotelName, "=", google_best, "URL:", url);

    // 4) THEN: try to open provider panel and compute lowest major OTA price
    let google_major_best = null;
    await openViewPricesIfExists(page);
    google_major_best = await extractMajorProviderPrice(page);

    console.log("[Google] major-provider price for", hotelName, "=", google_major_best);

    return {
      check_in: checkIn,
      check_out: checkOut,
      url,
      google_best,
      google_major_best,
    };
  } finally {
    await browser.close();
  }
}


