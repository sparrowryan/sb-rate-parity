// fetchGoogleHotels.js
import dayjs from "dayjs";
import { chromium } from "playwright";

function dollarsToNumber(s) {
  const m = String(s || "").match(/(\d[\d,]*)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export function makeGoogleSearchUrl(name, city, checkIn, checkOut) {
  const q = encodeURIComponent([name, city].filter(Boolean).join(" "));
  return `https://www.google.com/travel/search?hl=en&gl=us&q=${q}&checkin=${checkIn}&checkout=${checkOut}`;
}

function extractBrandPrices(text) {
  const brands = ["Expedia", "Booking.com", "Hotels.com", "Priceline", "Travelocity"];
  const out = {};

  for (const brand of brands) {
    // Look up to ~80 characters after the brand for the first $price
    const re = new RegExp(
      `${brand}[\\s\\S]{0,80}?\\$\\s?(\\d[\\d,]*)`,
      "i"
    );
    const m = text.match(re);
    if (m) {
      out[brand.toLowerCase()] = dollarsToNumber(m[1]);
    }
  }

  return out;
}

export async function getGoogleHotelsPrices(
  hotelName,
  city,
  { checkInOffsetDays = 7, nights = 2 } = {}
) {
  const check_in = dayjs().add(checkInOffsetDays, "day").format("YYYY-MM-DD");
  const check_out = dayjs().add(checkInOffsetDays + nights, "day").format("YYYY-MM-DD");

  const url = makeGoogleSearchUrl(hotelName, city, check_in, check_out);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Let prices load and scroll a bit so lazy content appears
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
    }

    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const pairs = extractBrandPrices(bodyText);

    // Map to the columns we care about
    const expedia = pairs["expedia"] ?? null;
    const booking = pairs["booking.com"] ?? pairs["booking"] ?? null;
    const hotels = pairs["hotels.com"] ?? pairs["hotels"] ?? null;
    const priceline = pairs["priceline"] ?? null;
    const travelocity = pairs["travelocity"] ?? null;

    const otaValues = [expedia, booking, hotels, priceline, travelocity].filter(
      (v) => typeof v === "number" && isFinite(v)
    );

    // Define google_best as the min OTA rate when possible (more stable)
    const google_best = otaValues.length ? Math.min(...otaValues) : null;

    return {
      check_in,
      check_out,
      url,          // search "prices" URL
      google_best,
      expedia,
      booking,
      hotels,
      priceline,
      travelocity,
    };
  } finally {
    await browser.close();
  }
}

