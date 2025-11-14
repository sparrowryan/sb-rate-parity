// index.js
import dayjs from "dayjs";
import fetch from "node-fetch";
import { getSparrowHotels } from "./scrapeSparrowBid.js";
import { getGoogleHotelsPriceSimple } from "./fetchGoogleHotels.js";

const WEBHOOK = process.env.WEBHOOK_URL;
const CHECKIN_OFFSET_DAYS = Number(process.env.CHECKIN_OFFSET_DAYS || 7);
const NIGHTS = Number(process.env.NIGHTS || 2);

// webhook tuning
const BATCH_SIZE = 20;
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (typeof x === "number" && isFinite(x) ? x : "");

/**
 * Construct a "good enough" SparrowBid URL that lands on a search
 * for this hotel + city.
 */
function makeSparrowBidUrl(name, city) {
  const parts = [];
  if (name) parts.push(name);
  if (city) parts.push(city);
  const q = encodeURIComponent(parts.join(" "));
  return `https://www.sparrowbid.com/explore?search=${q}`;
}

/**
 * Post one chunk of rows to the Google Apps Script webhook,
 * with retries on 429 / 5xx.
 */
async function postRowsChunk(rowsChunk, chunkIndex, totalChunks) {
  if (!rowsChunk.length) return;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `Posting chunk ${chunkIndex}/${totalChunks} to webhook (rows: ${rowsChunk.length}, attempt: ${attempt})`
      );

      const res = await fetch(WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowsChunk }),
      });

      const text = await res.text();
      console.log(
        `Webhook response for chunk ${chunkIndex}: HTTP ${res.status}, body: ${text.slice(
          0,
          200
        )}`
      );

      if (res.ok) return;

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `Chunk ${chunkIndex} got ${res.status}. Backing off for ${delay}ms before retry.`
        );
        await sleep(delay);
        continue;
      }

      console.error(
        `Non-retriable webhook error for chunk ${chunkIndex}: ${res.status} ${text}`
      );
      return;
    } catch (err) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.error(
        `Network error posting chunk ${chunkIndex} (attempt ${attempt}):`,
        err && err.message ? err.message : err
      );
      await sleep(delay);
    }
  }

  console.error(
    `Chunk ${chunkIndex} failed after ${MAX_RETRIES} attempts. Skipping this chunk.`
  );
}

(async () => {
  try {
    if (!WEBHOOK || !/^https?:\/\//i.test(WEBHOOK)) {
      throw new Error(
        "WEBHOOK_URL is not set or invalid. Add it under Settings → Secrets → Actions."
      );
    }

    // ---------------------------------------------------------------------
    //  Compute one shared date window for SB + Google
    // ---------------------------------------------------------------------
    const checkInDate = dayjs().add(CHECKIN_OFFSET_DAYS, "day");
    const checkOutDate = dayjs().add(CHECKIN_OFFSET_DAYS + NIGHTS, "day");
    const CHECK_IN_STR = checkInDate.format("YYYY-MM-DD");
    const CHECK_OUT_STR = checkOutDate.format("YYYY-MM-DD");

    console.log("Using date window:", CHECK_IN_STR, "to", CHECK_OUT_STR);

    // ---------------------------------------------------------------------
    //  SCRAPE SPARROWBID (LIMIT TO 100 HOTELS)
    // ---------------------------------------------------------------------
    const hotels = await getSparrowHotels({
      maxHotels: 100,
      maxPages: 40,
      checkIn: CHECK_IN_STR,
      checkOut: CHECK_OUT_STR,
    });

    console.log("Found hotels:", hotels.length);
    console.log("Sample:", hotels.slice(0, 5));

    if (!hotels.length)
      throw new Error(
        "SparrowBid scraper returned 0 hotels. Check selectors / pagination."
      );

    // ---------------------------------------------------------------------
    //  BUILD ROWS
    // ---------------------------------------------------------------------
    const today = dayjs().format("YYYY-MM-DD");
    const rows = [];

    for (const h of hotels) {
      const sbPrice =
        h.priceRaw && typeof h.priceRaw === "string"
          ? Number(h.priceRaw.replace(/[^0-9.]/g, ""))
          : null;

      const sbUrl = makeSparrowBidUrl(h.name, h.city);

      let gh = null;

      // Get the single Google reference price for the SAME dates
      try {
        gh = await getGoogleHotelsPriceSimple(h.name, h.city, {
          checkIn: CHECK_IN_STR,
          checkOut: CHECK_OUT_STR,
        });
      } catch (err) {
        console.error(
          `Google price scrape failed for "${h.name}" – SB-only row:`,
          err && err.message ? err.message : err
        );

        // SB-only row when Google fails completely
        rows.push([
          today,         // Date
          "",            // Check-in
          "",            // Check-out
          h.name,        // Property
          h.city || "",  // City
          num(sbPrice),  // SB Price
          "",            // Google Best
          "", "", "", "", "", "",   // OTA columns (unused)
          "", "",        // Advantage $ and %
          sbUrl,         // SB URL
          "",            // Google URL
        ]);
        continue;
      }

      const googleBest = gh?.google_best ?? null;
      const adv$ =
        sbPrice != null && googleBest != null ? googleBest - sbPrice : null;
      const advPct =
        sbPrice != null && googleBest != null && googleBest > 0
          ? (googleBest - sbPrice) / googleBest
          : null;

      rows.push([
        today,                // Date
        gh.check_in,          // Check-in
        gh.check_out,         // Check-out
        h.name,               // Property
        h.city || "",         // City
        num(sbPrice),         // SB Price
        num(googleBest),      // Google Best (single ref rate)
        "", "", "", "", "", "",   // OTA columns intentionally blank
        num(adv$),            // SB Advantage $
        advPct != null ? advPct : "", // SB Advantage %
        sbUrl,                // SB URL (search link)
        gh.url || "",         // Google URL (search prices page)
      ]);

      // polite pacing between Google price fetches
      await sleep(1000 + Math.floor(Math.random() * 600));
    }

    console.log(`Prepared ${rows.length} rows total.`);

    // ---------------------------------------------------------------------
    //  SEND TO GOOGLE SHEET IN BATCHES
    // ---------------------------------------------------------------------
    const totalChunks = Math.ceil(rows.length / BATCH_SIZE);
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunkIndex = i / BATCH_SIZE + 1;
      const chunk = rows.slice(i, i + BATCH_SIZE);
      await postRowsChunk(chunk, chunkIndex, totalChunks);
    }

    console.log("All chunks processed. Done.");

  } catch (err) {
    console.error("FATAL:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();

