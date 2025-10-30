import dayjs from "dayjs";
import { chromium } from "playwright";

export function makeGoogleHotelsUrl(name, city, checkIn, checkOut) {
  const q = encodeURIComponent([name, city].filter(Boolean).join(" "));
  return `https://www.google.com/travel/hotels?hl=en&gl=us&q=${q}&checkin=${checkIn}&checkout=${checkOut}`;
}

function dollarsToNumber(s){
  const m = String(s||"").match(/(\d[\d,]*)/);
  return m ? Number(m[1].replace(/,/g,"")) : null;
}

function extractOtas(text){
  const brands = ["Expedia","Booking.com","Hotels.com","Priceline","Travelocity"];
  const out = {};
  for (const b of brands){
    const re = new RegExp(`${b}[\\s·:]*\\$\\s?(\\d[\\d,]*)`, "i");
    const m = text.match(re);
    if (m) out[b] = dollarsToNumber(m[1]);
  }
  return out;
}

export async function getGoogleHotelsPrices(hotelName, city, { checkInOffsetDays=7, nights=2 } = {}) {
  const checkIn = dayjs().add(checkInOffsetDays,"day").format("YYYY-MM-DD");
  const checkOut = dayjs().add(checkInOffsetDays+nights,"day").format("YYYY-MM-DD");
  const url = makeGoogleHotelsUrl(hotelName, city, checkIn, checkOut);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2500);

  const text = await page.evaluate(() => document.body.innerText || "");
  await browser.close();

  const bestMatch = text.match(/\$\s?(\d[\d,]*)\s*(?:per\s*night|\/\s*night)/i);
  const googleBest = bestMatch ? dollarsToNumber(bestMatch[1]) : null;

  const otas = extractOtas(text);
  return {
    check_in: checkIn,
    check_out: checkOut,
    url,
    google_best: googleBest,
    expedia: otas["Expedia"] ?? null,
    booking: otas["Booking.com"] ?? null,
    hotels: otas["Hotels.com"] ?? null,
    priceline: otas["Priceline"] ?? null,
    travelocity: otas["Travelocity"] ?? null
  };
}
