// index.js
import dayjs from "dayjs";
import fetch from "node-fetch";
import { getSparrowHotels } from "./scrapeSparrowBid.js";
import { getGoogleHotelsPriceSimple } from "./fetchGoogleHotels.js";

const WEBHOOK = process.env.WEBHOOK_URL;
const CHECKIN_OFFSET_DAYS = Number(process.env.CHECKIN_OFFSET_DAYS || 7);
const NIGHTS = Number(process.env.NIGHTS || 2);
const MAX_HOTELS = Number(process.env.MAX_HOTELS || 100);
const SCRAPE_MAX_HOTELS = Number(process.env.SCRAPE_MAX_HOTELS || 200); // how many we scrape from Sparrow total
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (typeof x === "number" && isFinite(x) ? x : "");

// Guard: WEBHOOK required unless DRY_RUN
if (!DRY_RUN) {
  if (!WEBHOOK || !/^https?:\/\//i.test(WEBHOOK)) {
    console.error(
      "WEBHOOK_URL is not set or invalid. Add it under Settings → Secrets → Actions."
    );
    process.exit(1);
  }
}

(async () => {
  try {
    console.log("=== sb-rate-parity run starting ===");
    console.log("CONFIG:", {
      MAX_HOTELS,
      SCRAPE_MAX_HOTELS,
      DRY_RUN,
      CHECKIN_OFFSET_DAYS,
      NIGHTS,
    });

    const base = dayjs().add(CHECKIN_OFFSET_DAYS, "day");
    const checkIn = base.format("YYYY-MM-DD");
    const checkOut = base.add(NIGHTS, "day").format("YYYY-MM-DD");

    // -------- SCRAPE SPARROWBID (DATE-FILTERED) --------
    const hotels = await getSparrowHotels({
      maxHotels: SCRAPE_MAX_HOTELS,
      maxPages: 40,
      checkIn,
      checkOut,
    });

    console.log("Total hotels scraped from SparrowBid:", hotels.length);

    if (!hotels.length) {
      throw new Error("SparrowBid scraper returned 0 hotels. Check selectors.");
    }

    const toProcess = Math.min(MAX_HOTELS, hotels.length);
    console.log(`Processing ${toProcess} hotels this run (MAX_HOTELS=${MAX_HOTELS})`);
    console.log("Sample hotels:", hotels.slice(0, 3));

    const today = dayjs().format("YYYY-MM-DD");
    const rows = [];

    for (let i = 0; i < toProcess; i++) {
      const h = hotels[i];
      console.log(
        `--- [${i + 1}/${toProcess}] ${h.name} (${h.city || "no city"}) ---`
      );

      const sbPrice = h.priceRaw
        ? Number(h.priceRaw.replace(/[^0-9.]/g, ""))
        : null;
      console.log("[SB] raw card price:", h.priceRaw, "parsed:", sbPrice);

      // Query Google Hotels for this hotel
      const gh = await getGoogleHotelsPriceSimple(h.name, h.city, {
        checkIn,
        checkOut,
      });

      console.log("[Google] result object:", gh);

      const googleAll =
        typeof gh.google_best === "number" && isFinite(gh.google_best)
          ? gh.google_best
          : null;
      const googleMajor =
        typeof gh.google_major_best === "number" && isFinite(gh.google_major_best)
          ? gh.google_major_best
          : null;

      // SB vs lowest OTA (all providers)
      const advAll$ =
        sbPrice != null && googleAll != null ? googleAll - sbPrice : null;
      const advAllPct =
        sbPrice != null && googleAll != null && googleAll > 0
          ? (googleAll - sbPrice) / googleAll
          : null;

      // SB vs lowest Major OTA
      const advMaj$ =
        sbPrice != null && googleMajor != null ? googleMajor - sbPrice : null;
      const advMajPct =
        sbPrice != null && googleMajor != null && googleMajor > 0
          ? (googleMajor - sbPrice) / googleMajor
          : null;

      const row = [
        today,              // Date of run
        gh.check_in,        // Check-in
        gh.check_out,       // Check-out
        h.name,             // Property
        h.city || "",       // City
        num(sbPrice),       // SparrowBid price
        num(googleAll),     // Lowest OTA (all providers)
        num(googleMajor),   // Lowest Major OTA (Expedia/Booking/etc.)
        num(advAll$),       // SB advantage vs ALL OTAs ($)
        advAllPct != null ? advAllPct : "", // SB advantage vs ALL OTAs (%)
        num(advMaj$),       // SB advantage vs Major OTAs ($)
        advMajPct != null ? advMajPct : "", // SB advantage vs Major OTAs (%)
        h.url || "",        // SB URL (we still synthesize later if needed)
        gh.url || "",       // Google Hotels URL
      ];

      if (DRY_RUN) {
        console.log("[DRY_RUN] Would append row:", row);
      }

      rows.push(row);

      // polite pacing between Google Hotels fetches
      await sleep(1000 + Math.floor(Math.random() * 600));
    }

    if (DRY_RUN) {
      console.log(
        `[DRY_RUN] Built ${rows.length} rows but NOT sending to webhook.`
      );
      console.log("[DRY_RUN] End of run.");
      return;
    }

    // -------- SEND TO GOOGLE SHEET VIA WEBHOOK --------
    console.log("Sending", rows.length, "rows to webhook.");
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const text = await res.text();
    console.log("Webhook HTTP", res.status, text);
    if (!res.ok) throw new Error(`Webhook failed: ${res.status} ${text}`);

    console.log("=== sb-rate-parity run completed successfully ===");
  } catch (err) {
    console.error("FATAL:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();


