// index.js
import dayjs from "dayjs";
import fetch from "node-fetch";
import { getSparrowHotels } from "./scrapeSparrowBid.js";
// Adjust this import name if your Google file exports a different name
import { getGoogleHotelsPriceSimple as getGoogleHotelsPrices } from "./fetchGoogleHotels.js";

const WEBHOOK = process.env.WEBHOOK_URL;

// Existing config
const CHECKIN_OFFSET_DAYS = Number(process.env.CHECKIN_OFFSET_DAYS || 7);
const NIGHTS = Number(process.env.NIGHTS || 2);

// NEW: testing controls
const MAX_HOTELS = Number(process.env.MAX_HOTELS || 10); // how many hotels to process per run
const DRY_RUN =
  String(process.env.DRY_RUN || "").toLowerCase() === "true" ||
  process.env.DRY_RUN === "1";

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (typeof x === "number" && isFinite(x) ? x : "");

// For testing: shorter delays if you're only hitting a few hotels
function getPoliteDelayMs() {
  if (MAX_HOTELS <= 5) return 300; // faster when testing small sample
  if (MAX_HOTELS <= 20) return 800;
  return 1400; // safer for big runs
}

(async () => {
  try {
    if (!WEBHOOK || !/^https?:\/\//i.test(WEBHOOK)) {
      throw new Error(
        "WEBHOOK_URL is not set or invalid. Add it under Settings → Secrets → Actions."
      );
    }

    // Derive SparrowBid check-in/check-out window from env
    const base = dayjs().add(CHECKIN_OFFSET_DAYS, "day");
    const checkIn = base.format("YYYY-MM-DD");
    const checkOut = base.add(NIGHTS, "day").format("YYYY-MM-DD");

    console.log("=== sb-rate-parity run starting ===");
    console.log("CONFIG:", {
      MAX_HOTELS,
      DRY_RUN,
      CHECKIN_OFFSET_DAYS,
      NIGHTS,
      sbCheckIn: checkIn,
      sbCheckOut: checkOut,
    });

    // -------- SCRAPE SPARROWBID (with pagination + SB URL capture) --------
    const allHotels = await getSparrowHotels({
      maxHotels: 600, // still scrape a big pool so we have options
      maxPages: 40,
      checkIn,
      checkOut,
    });

    console.log("Total hotels scraped from SparrowBid:", allHotels.length);

    // Apply test cap
    const hotels = allHotels.slice(0, MAX_HOTELS);
    console.log(
      `Processing ${hotels.length} hotels this run (MAX_HOTELS=${MAX_HOTELS})`
    );
    console.log("Sample hotels:", hotels.slice(0, 3));

    if (!hotels.length) {
      throw new Error(
        "SparrowBid scraper returned 0 hotels after slicing. Check selectors."
      );
    }

    const today = dayjs().format("YYYY-MM-DD");
    const rows = [];
    const politeDelay = getPoliteDelayMs();

    for (let i = 0; i < hotels.length; i++) {
      const h = hotels[i];

      console.log(
        `\n--- [${i + 1}/${hotels.length}] ${h.name} (${h.city || "no city"}) ---`
      );

      // SB price from card (your existing logic)
      const sbPrice = h.priceRaw
        ? Number(h.priceRaw.replace(/[^0-9.]/g, ""))
        : null;

      console.log("[SB] raw card price:", h.priceRaw, "parsed:", sbPrice);

      // ---- GOOGLE SIDE ----
      // NOTE: adjust the args here to match your actual getGoogle... signature.
      // If you're on the "simple" version that takes explicit dates, update accordingly.
      const gh = await getGoogleHotelsPrices(h.name, h.city, {
        checkInOffsetDays: CHECKIN_OFFSET_DAYS,
        nights: NIGHTS,
      });

      console.log("[Google] result object:", gh);

      const googleBest =
        typeof gh.google_best === "number" && isFinite(gh.google_best)
          ? gh.google_best
          : null;

      // If later you return ota_min instead of google_best, you can swap that here:
      // const googleBest = typeof gh.ota_min === "number" && isFinite(gh.ota_min) ? gh.ota_min : null;

      const candidates = [googleBest].filter(
        (v) => typeof v === "number" && isFinite(v)
      );
      const minOta = candidates.length ? Math.min(...candidates) : null;

      const adv$ =
        sbPrice != null && minOta != null ? minOta - sbPrice : null;
      const advPct =
        sbPrice != null && minOta != null && minOta > 0
          ? (minOta - sbPrice) / minOta
          : null;

      console.log("[Computed]", {
        googleBest,
        minOta,
        adv$,
        advPct,
      });

      const row = [
        today, // Date
        gh.check_in || "", // Check-in (if your gh object provides it)
        gh.check_out || "", // Check-out
        h.name, // Property
        h.city || "", // City
        num(sbPrice), // SB Price
        num(googleBest), // Google Best / OTA-min
        num(adv$), // SB Advantage $
        advPct != null ? advPct : "", // SB Advantage %
        h.url || "", // SB URL (still empty from scraper unless you add it later)
        gh.url || "", // Google URL
      ];

      if (DRY_RUN) {
        console.log("[DRY_RUN] Would append row:", row);
      } else {
        rows.push(row);
      }

      // Polite pacing between hotel lookups
      await sleep(politeDelay + Math.floor(Math.random() * 250));
    }

    if (DRY_RUN) {
      console.log(
        `\n[DRY_RUN] Built ${hotels.length} rows but NOT sending to webhook.`
      );
      console.log("[DRY_RUN] End of run.");
      return;
    }

    // -------- SEND TO GOOGLE SHEET VIA WEBHOOK --------
    console.log("\nSending rows to webhook:", rows.length);

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

