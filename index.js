// index.js
import dayjs from "dayjs";
import fetch from "node-fetch";
import { getSparrowHotels } from "./scrapeSparrowBid.js";
import { getGoogleHotelsPrices } from "./fetchGoogleHotels.js";

const WEBHOOK = process.env.WEBHOOK_URL;
const CHECKIN_OFFSET_DAYS = Number(process.env.CHECKIN_OFFSET_DAYS || 7);
const NIGHTS = Number(process.env.NIGHTS || 2);

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (typeof x === "number" && isFinite(x) ? x : "");

(async () => {
  try {
    if (!WEBHOOK || !/^https?:\/\//i.test(WEBHOOK)) {
      throw new Error(
        "WEBHOOK_URL is not set or invalid. Add it under Settings → Secrets → Actions."
      );
    }

    // ---------------------------------------------------------------------
    //  SCRAPE SPARROWBID
    // ---------------------------------------------------------------------
    const hotels = await getSparrowHotels({
      maxHotels: 600,
      maxPages: 40,
      fetchUrls: true,
      settleMs: 500,
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

      let gh = null;

      // ---------------------------------------------------------
      // Try OTA scrape per-hotel with fail-soft behavior
      // ---------------------------------------------------------
      try {
        gh = await getGoogleHotelsPrices(h.name, h.city, {
          checkInOffsetDays: CHECKIN_OFFSET_DAYS,
          nights: NIGHTS,
        });
      } catch (err) {
        console.error(
          `OTA scrape failed for "${h.name}" – skipping OTA rates for this one:`,
          err.message || err
        );

        // Write SB-only row
        rows.push([
          today,         // Date
          "",            // Check-in (unknown)
          "",            // Check-out
          h.name,        // Property
          h.city || "",  // City
          num(sbPrice),  // SB Price
          "", "", "", "", "", "",   // OTA columns blank
          "", "",        // Advantage $ and %
          h.url || "",   // SB URL
          "",            // OTA URL
        ]);

        continue; // move to next hotel, do NOT kill the run
      }

      // ---------------------------------------------------------
      // Compute OTA min + advantage
      // ---------------------------------------------------------
      const candidates = [
        gh.google_best,
        gh.expedia,
        gh.booking,
        gh.hotels,
        gh.priceline,
        gh.travelocity,
      ].filter((v) => typeof v === "number" && isFinite(v));

      const minOta = candidates.length ? Math.min(...candidates) : null;
      const adv$ =
        sbPrice != null && minOta != null ? minOta - sbPrice : null;
      const advPct =
        sbPrice != null && minOta != null && minOta > 0
          ? (minOta - sbPrice) / minOta
          : null;

      // ---------------------------------------------------------
      // Add FULL row (SB + OTA)
      // ---------------------------------------------------------
      rows.push([
        today,               // Date
        gh.check_in,         // Check-in
        gh.check_out,        // Check-out
        h.name,              // Property
        h.city || "",        // City
        num(sbPrice),        // SB Price
        num(gh.google_best), // Google Best (min OTA)
        num(gh.expedia),     // Expedia
        num(gh.booking),     // Booking.com
        num(gh.hotels),      // Hotels.com
        num(gh.priceline),   // Priceline
        num(gh.travelocity), // Travelocity
        num(adv$),           // SB Advantage $
        advPct != null ? advPct : "", // SB Advantage %
        h.url || "",         // SB URL
        gh.url || "",        // OTA URL (Google search prices page)
      ]);

      // polite pacing between Google price fetches
      await sleep(1000 + Math.floor(Math.random() * 600));
    }

    // ---------------------------------------------------------------------
    //  SEND TO GOOGLE SHEET
    // ---------------------------------------------------------------------
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });

    const text = await res.text();
    console.log("Webhook HTTP", res.status, text);

    if (!res.ok) {
      throw new Error(`Webhook failed: ${res.status} ${text}`);
    }

  } catch (err) {
    console.error("FATAL:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
