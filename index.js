import dayjs from "dayjs";
import fetch from "node-fetch";
import { getSparrowHotels } from "./scrapeSparrowBid.js";
import { getGoogleHotelsPrices } from "./fetchGoogleHotels.js";

const WEBHOOK = process.env.WEBHOOK_URL; // Apps Script Web App URL
const CHECKIN_OFFSET_DAYS = Number(process.env.CHECKIN_OFFSET_DAYS || 7);
const NIGHTS = Number(process.env.NIGHTS || 2);

function n(x){ return (typeof x === "number" && isFinite(x)) ? x : ""; }

(async () => {
  const today = dayjs().format("YYYY-MM-DD");
  const hotels = await getSparrowHotels(40);

  const rows = [];
  for (const h of hotels) {
    const sbPrice = h.priceRaw ? Number(h.priceRaw.replace(/[^0-9.]/g,"")) : null;
    const gh = await getGoogleHotelsPrices(h.name, h.city, { checkInOffsetDays: CHECKIN_OFFSET_DAYS, nights: NIGHTS });

    const candidates = [gh.google_best, gh.expedia, gh.booking, gh.hotels, gh.priceline, gh.travelocity]
      .filter(v => typeof v === "number" && isFinite(v));
    const minOta = candidates.length ? Math.min(...candidates) : null;

    const adv$ = (sbPrice!=null && minOta!=null) ? (minOta - sbPrice) : null;
    const advPct = (sbPrice!=null && minOta!=null && minOta>0) ? ((minOta - sbPrice)/minOta) : null;

    rows.push([
      today,
      gh.check_in,
      gh.check_out,
      h.name,
      h.city || "",
      n(sbPrice),
      n(gh.google_best),
      n(gh.expedia),
      n(gh.booking),
      n(gh.hotels),
      n(gh.priceline),
      n(gh.travelocity),
      n(adv$),
      advPct != null ? advPct : "",
      h.url || "",
      gh.url || ""
    ]);

    // polite pacing
    await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random()*800)));
  }

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows })
  });
  const json = await res.json().catch(()=>({}));
  console.log("Webhook result:", json);
})();
