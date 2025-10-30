import dayjs from "dayjs";
import { chromium } from "playwright";

export function makeGoogleHotelsUrl(name, city, checkIn, checkOut) {
  const q = encodeURIComponent([name, city].filter(Boolean).join(" "));
  return `https://www.google.com/travel/hotels?hl=en&gl=us&q=${q}&checkin=${checkIn}&checkout=${checkOut}`;
}

function dollarsToNumber(s) {
  const m = String(s || "").match(/(\d[\d,]*)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export async function getGoogleHotelsPrices(hotelName, city, { checkInOffsetDays = 7, nights = 2 } = {}) {
  const check_in = dayjs().add(checkInOffsetDays, "day").format("YYYY-MM-DD");
  const check_out = dayjs().add(checkInOffsetDays + nights, "day").format("YYYY-MM-DD");
  const url = makeGoogleHotelsUrl(hotelName, city, check_in, check_out);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

  // give content time, open Prices tab if present, and expand more rates
  await page.waitForTimeout(2500);
  const pricesTab = page.locator('button:has-text("Prices"), a:has-text("Prices")');
  if (await pricesTab.count()) {
    await pricesTab.first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  const expandMore = page.locator('button:has-text("View more"), button:has-text("More options"), a:has-text("View more")');
  if (await expandMore.count()) {
    await expandMore.first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  // Extract brand → price from visible list/table
  const { googleBest, pairs } = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const best = (text.match(/\$\s?(\d[\d,]*)\s*(?:per\s*night|\/\s*night)/i) || [])[1] || null;

    const brands = ["Expedia", "Booking.com", "Hotels.com", "Priceline", "Travelocity"];
    const out = {};
    for (const b of brands) {
      // find nearest $xxx within the same line or next line
      const re = new RegExp(`${b}[\\s·:]*\\$\\s?(\\d[\\d,]*)`, "i");
      const m = text.match(re);
      if (m) out[b.toLowerCase()] = m[1];
    }
    return { googleBest: best, pairs: out };
  });

  await browser.close();

  return {
    check_in,
    check_out,
    url,
    google_best: dollarsToNumber(googleBest),
    expedia: dollarsToNumber(pairs["expedia"]),
    booking: dollarsToNumber(pairs["booking.com"]) ?? dollarsToNumber(pairs["booking"]),
    hotels: dollarsToNumber(pairs["hotels.com"]) ?? dollarsToNumber(pairs["hotels"]),
    priceline: dollarsToNumber(pairs["priceline"]),
    travelocity: dollarsToNumber(pairs["travelocity"]),
  };
}

