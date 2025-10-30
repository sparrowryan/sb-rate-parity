import { chromium } from "playwright";

export async function getSparrowHotels(max = 40) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("https://www.sparrowbid.com/explore", { waitUntil: "networkidle", timeout: 120000 });

  // Scroll to load cards
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }

  // ⚠️ One-time tweak may be needed: refine these selectors after a first run.
  const hotels = await page.$$eval("a, article, div", nodes => {
    const out = [];
    for (const n of nodes) {
      const txt = (n.innerText || "").trim();
      if (!txt) continue;
      const price = (txt.match(/\$\s?\d[\d,]*/)||[])[0] || null;
      const name = txt.split("\n")[0]?.trim();
      const url = n.closest("a")?.href || null;
      const lines = txt.split("\n").map(s=>s.trim()).filter(Boolean);
      const city = lines[1] || "";

      // crude filter to reduce noise
      const looksCard = name && (price || /hotel|resort|inn|suite/i.test(txt));
      if (looksCard) out.push({ name, city, priceRaw: price, url });
    }
    // dedupe by name
    const seen = new Set();
    return out.filter(x => {
      const k = (x.name||"").toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

  await browser.close();
  return hotels.slice(0, max);
}
