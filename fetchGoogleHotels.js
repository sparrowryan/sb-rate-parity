// fetchGoogleHotels.js
import dayjs from "dayjs";
import { chromium } from "playwright";

// ---------- Helpers: city & URL ----------

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

// ---------- Date picker (UI) ----------
// This is the critical piece: we *do* set the dates in Google’s calendar UI.

async function setDateRangeInUi(page, checkIn, checkOut) {
  const inLabelPart = dayjs(checkIn).format("MMMM D, YYYY");   // e.g. "November 26, 2025"
  const outLabelPart = dayjs(checkOut).format("MMMM D, YYYY"); // e.g. "November 28, 2025"

  console.log("[Google] Trying to set dates via UI:", {
    checkIn,
    checkOut,
    inLabelPart,
    outLabelPart,
  });

  // 1) Open the date picker by clicking the Check-in input
  try {
    const input = page
      .locator('input[aria-label*="Check-in"], input[aria-label*="Check in"]')
      .first();

    if (!(await input.count())) {
      console.warn("[Google] No Check-in input found; leaving Google default dates.");
      return false;
    }

    await input.click({ force: true, timeout: 5000 });
  } catch (err) {
    console.warn(
      "[Google] Failed to click Check-in input; leaving Google default dates.",
      String(err)
    );
    return false;
  }

  // Give the calendar time to appear
  await page.waitForTimeout(1000);

  // Helper to click a date cell by aria-label substring
  async function clickDate(labelPart) {
    const loc = page.locator(`div[aria-label*="${labelPart}"]`).first();
    try {
      await loc.waitFor({ state: "visible", timeout: 5000 });
      await loc.click({ force: true });
      return true;
    } catch (err) {
      console.warn("[Google] Could not click date for labelPart:", labelPart, String(err));
      return false;
    }
  }

  const okIn = await clickDate(inLabelPart);
  await page.waitForTimeout(300);
  const okOut = await clickDate(outLabelPart);

  // Click "Done" / "Apply" / "Save" if present
  try {
    const doneBtn = page
      .locator(
        'button:has-text("Done"), button:has-text("Apply"), button:has-text("Save")'
      )
      .first();
    if (await doneBtn.count()) {
      await doneBtn.click({ timeout: 5000 }).catch(() => {});
    }
  } catch {
    // non-fatal
  }

  // Let prices refresh
  await page.waitForTimeout(3000);

  // Log what the UI thinks the dates are
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

  return okIn && okOut;
}

// ---------- Card-level price (this is your Google BEST) ----------

async function extractSelectedDatesPrice(page, hotelName) {
  return await page.evaluate((hotelNameInner) => {
    if (!hotelNameInner) return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(hotelNameInner);
    const priceRegex = /\$\s?(\d[\d,]*)/;

    const anchors = Array.from(document.querySelectorAll("a[aria-label]"));

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

      // Prefer "$XX nightly" if available
      const nightly = texts.find(
        (t) => /nightly/i.test(t) && priceRegex.test(t)
      );
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

// ---------- "View prices" + Major OTA block ----------

async function openViewPricesIfExists(page) {
  const btn = page.locator('button:has-text("View prices")');
  const count = await btn.count();
  if (!count) {
    console.log(
      "[Google] No 'View prices' button found; maybe already expanded or different layout."
    );
    return false;
  }
  try {
    await btn.first().click();
    await page.waitForTimeout(3000); // let provider panel load
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
      const isMajor = majorBrands.some((brand) =>
        providerName.includes(brand)
      );
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

// ---------- Main exported function ----------
// IMPORTANT:
//   • We DO set dates in the UI (so Google matches SB dates).
//   • google_best comes from the card for those dates.
//   • google_major_best is best-effort and cannot crash the run.

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
    await page.waitForTimeout(3000); // base load

    // Set Google to the SAME dates we’re using on SparrowBid
    await setDateRangeInUi(page, checkIn, checkOut);

    // Scroll a bit so cards/tooltips render
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
    }

    // 1) Google all-OTA reference price (this is what was working before)
    const google_best = await extractSelectedDatesPrice(page, hotelName);
    console.log(
      "[Google] selected-dates price for",
      hotelName,
      "=",
      google_best,
      "URL:",
      url
    );

    // 2) OPTIONAL: "major OTA" price (Expedia/Booking/etc.) — totally non-fatal
    let google_major_best = null;
    try {
      await openViewPricesIfExists(page);
      google_major_best = await extractMajorProviderPrice(page);
      console.log(
        "[Google] major-provider price for",
        hotelName,
        "=",
        google_major_best
      );
    } catch (err) {
      console.warn(
        "[Google] major-provider extraction failed (non-fatal):",
        String(err)
      );
      google_major_best = null;
    }

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


