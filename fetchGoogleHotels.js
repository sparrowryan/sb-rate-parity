// fetchGoogleHotels.js
import dayjs from "dayjs";
import { chromium } from "playwright";

function escRx(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function dollarsToNumber(s){ const m = String(s||"").match(/(\d[\d,]*)/); return m ? Number(m[1].replace(/,/g,"")) : null; }

export function makeGoogleSearchUrl(name, city, checkIn, checkOut) {
  const q = encodeURIComponent([name, city].filter(Boolean).join(" "));
  return `https://www.google.com/travel/search?hl=en&gl=us&q=${q}&checkin=${checkIn}&checkout=${checkOut}`;
}

async function openHotelFromSearch(page, hotelName) {
  // Try exact heading match first
  const exact = page.getByRole("heading", { name: new RegExp(`^${escRx(hotelName)}$`, "i") }).first();
  if (await exact.count()) {
    await exact.click({ timeout: 8000 }).catch(()=>{});
    return true;
  }
  // Fallback: partial heading
  const partial = page.getByRole("heading", { name: new RegExp(escRx(hotelName.slice(0, Math.min(20, hotelName.length))), "i") }).first();
  if (await partial.count()) {
    await partial.click({ timeout: 8000 }).catch(()=>{});
    return true;
  }
  // Last resort: any link containing the name
  const linkLike = page.locator(`a:has-text("${hotelName.split(" ").slice(0,2).join(" ")}")`).first();
  if (await linkLike.count()) {
    await linkLike.click({ timeout: 8000 }).catch(()=>{});
    return true;
  }
  return false;
}

async function openPricesPanel(page) {
  // Try a Prices tab
  const pricesTab = page.getByRole("tab", { name: /prices/i }).first();
  if (await pricesTab.count()) {
    await pricesTab.click().catch(()=>{});
    await page.waitForTimeout(900);
  }
  // Try buttons/links that reveal more rates
  const more = page.locator('button:has-text("View more"), button:has-text("More options"), a:has-text("View more")').first();
  if (await more.count()) {
    await more.click().catch(()=>{});
    await page.waitForTimeout(900);
  }
}

function extractBrandPricesFromText(text) {
  const brands = ["Expedia","Booking.com","Hotels.com","Priceline","Travelocity"];
  const out = {};
  for (const b of brands) {
    const re = new RegExp(`${b}[\\s·:]*\\$\\s?(\\d[\\d,]*)`,"i");
    const m = text.match(re);
    if (m) out[b.toLowerCase()] = dollarsToNumber(m[1]);
  }
  // Google’s “best” (per-night) token
  const best = (text.match(/\$\s?(\d[\d,]*)\s*(?:per\s*night|\/\s*night)/i) || [])[1] || null;
  return { googleBest: dollarsToNumber(best), pairs: out };
}

export async function getGoogleHotelsPrices(hotelName, city, { checkInOffsetDays = 7, nights = 2 } = {}) {
  const check_in  = dayjs().add(checkInOffsetDays,"day").format("YYYY-MM-DD");
  const check_out = dayjs().add(checkInOffsetDays+nights,"day").format("YYYY-MM-DD");
  const urlSearch = makeGoogleSearchUrl(hotelName, city, check_in, check_out);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(urlSearch, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(1500);

  // Click into the correct hotel card from the Search view
  const opened = await openHotelFromSearch(page, hotelName);
  if (!opened) {
    // Fallback: stay on search page and parse any provider prices shown there
    const text = await page.evaluate(() => document.body.innerText || "");
    const { googleBest, pairs } = extractBrandPricesFromText(text);
    await browser.close();
    return {
      check_in, check_out,
      url: urlSearch,
      google_best: googleBest,
      expedia: pairs["expedia"] ?? null,
      booking: pairs["booking.com"] ?? pairs["booking"] ?? null,
      hotels: pairs["hotels.com"] ?? pairs["hotels"] ?? null,
      priceline: pairs["priceline"] ?? null,
      travelocity: pairs["travelocity"] ?? null
    };
  }

  // We should now be on the hotel’s detail page (URL changes to /travel/hotels/...).
  await page.waitForTimeout(1200);
  await openPricesPanel(page);

  // Final extraction from the detail page with Prices open/expanded
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  const { googleBest, pairs } = extractBrandPricesFromText(bodyText);

  const finalUrl = page.url();
  await browser.close();

  return {
    check_in, check_out,
    url: finalUrl,                 // detail URL you actually scraped from
    google_best: googleBest,
    expedia: pairs["expedia"] ?? null,
    booking: pairs["booking.com"] ?? pairs["booking"] ?? null,
    hotels: pairs["hotels.com"] ?? pairs["hotels"] ?? null,
    priceline: pairs["priceline"] ?? null,
    travelocity: pairs["travelocity"] ?? null
  };
}

