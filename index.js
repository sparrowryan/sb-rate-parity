// index.js
import dayjs from "dayjs";
import fetch from "node-fetch";
import { getSparrowHotels } from "./scrapeSparrowBid.js";
import { getGoogleHotelsPriceSimple } from "./fetchGoogleHotels.js";

const WEBHOOK = process.env.WEBHOOK_URL;
const CHECKIN_OFFSET_DAYS = Number(process.env.CHECKIN_OFFSET_DAYS || 7);
const NIGHTS = Number(process.env.NIGHTS || 2);
const MAX_HOTELS = Number(process.env.MAX_HOTELS || 10);
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) =>
  typeof x === "number" && Number.isFinite(x) ? x : "";

// -------- MAIN --------
(async () => {
  try {
    console.log("=== sb-rate-parity run starting ===");
    console.log("CONFIG:", {
      CHECKIN_OFFSET_DAYS,
      NIGHTS,
      MAX_HOTELS,
      DRY_RUN,
    });

    if (!WEBHOOK || !/^https?:\/\//i.test(WEBHOOK)) {
      throw new Error(
        "WEBHOOK_URL is not set or invalid. Add it under Settings → Secrets → Actions."
      );
    }

    const runDate = dayjs().format("YYYY-MM-DD");
    const checkIn = dayjs().add(CHECKIN_OFFSET_DAYS, "day").format("YYYY-MM-DD");
    const checkOut = dayjs(checkIn).add(NIGHTS, "day").format("YYYY-MM-DD");

    // -------- SCRAPE SPARROWBID (using date-filtered Explore URL) --------
    const allHotels = await getSparrowHotels({
      maxHotels: 600,  // upper bound for uniqueness
      maxPages: 40,
      checkIn,
      checkOut,
    });

    console.log("Total hotels scraped from SparrowBid:", allHotels.length);

    const hotels = allHotels.slice(0, MAX_HOTELS);
    console.log(`Processing ${hotels.length} hotels this run (MAX_HOTELS=${MAX_HOTELS})`);
    console.log("Sample hotels:", hotels.slice(0, 3));

    const rows = [];

    for (let i = 0; i < hotels.length; i++) {
      const h = hotels[i];
      console.log(`\n--- [${i + 1}/${hotels.length}] ${h.name} (${h.city}) ---`);

      const sbPrice = h.priceRaw
        ? Number(h.priceRaw.replace(/[^0-9.]/g, ""))
        : null;
      console.log("[SB] raw card price:", h.priceRaw, "parsed:", sbPrice);

      // Google reference prices (best + major-best)
      const gh = await getGoogleHotelsPriceSimple(h.name, h.city, {
        checkIn,
        checkOut,
      });

      const googleBest = gh.google_best ?? null;
      const googleMajorBest = gh.google_major_best ?? null;

      // SB vs Google Best
      let advAll$ = null;
      let advAllPct = null;
      if (sbPrice != null && googleBest != null) {
        advAll$ = googleBest - sbPrice;
        if (googleBest > 0) {
          advAllPct = advAll$ / googleBest;
        }
      }

      // SB vs Google Major Best
      let advMajor$ = null;
      let advMajorPct = null;
      if (sbPrice != null && googleMajorBest != null) {
        advMajor$ = googleMajorBest - sbPrice;
        if (googleMajorBest > 0) {
          advMajorPct = advMajor$ / googleMajorBest;
        }
      }

      console.log("[Computed]", {
        googleBest,
        googleMajorBest,
        advAll$,
        advAllPct,
        advMajor$,
        advMajorPct,
      });

      // Build row:
      // 0  Date run
      // 1  Check-in
      // 2  Check-out
      // 3  Property
      // 4  City
      // 5  SB Price
      // 6  Google Best (all OTAs)
      // 7  Google Major Best (Expedia/Booking/Priceline/Kayak/Hotels.com/Orbitz/Travelocity)
      // 8  SB Adv vs All $
      // 9  SB Adv vs All %
      // 10 SB Adv vs Major $
      // 11 SB Adv vs Major %
      // 12 SB URL (blank for now — you’re synthesizing this from the name)
      // 13 Google URL
      const row = [
        runDate,
        gh.check_in,
        gh.check_out,
        h.name,
        h.city || "",
        num(sbPrice),
        num(googleBest),
        num(googleMajorBest),
        num(advAll$),
        advAllPct != null ? advAllPct : "",
        num(advMajor$),
        advMajorPct != null ? advMajorPct : "",
        h.url || "",
        gh.url || "",
      ];

      if (DRY_RUN) {
        console.log("[DRY_RUN] Would append row:", row);
      }

      rows.push(row);

      // polite pacing between Google Hotels fetches
      await sleep(1000 + Math.floor(Math.random() * 600));
    }

    if (DRY_RUN) {
      console.log("[DRY_RUN] Built", rows.length, "rows but NOT sending to webhook.");
      console.log("[DRY_RUN] End of run.");
      return;
    }

    // -------- SEND TO GOOGLE SHEET VIA WEBHOOK --------
    console.log("Posting", rows.length, "rows to webhook…");
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const text = await res.text();
    console.log("Webhook HTTP", res.status, text);
    if (!res.ok) throw new Error(`Webhook failed: ${res.status} ${text}`);

    console.log("=== sb-rate-parity run complete ===");
  } catch (err) {
    console.error(
      "FATAL:",
      err && err.stack ? err.stack : err
    );
    process.exit(1);
  }
})();



