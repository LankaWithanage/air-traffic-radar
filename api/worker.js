// Air Traffic Radar API: a tiny Cloudflare Worker (free plan is plenty).
//
// Why it exists: the free flight-position services (adsb.fi, adsb.lol) don't let web pages call them directly, so the
// radar page asks this Worker, which asks them and passes the answer back with permission for your page.
//
// GET /?lat=51.47&lon=-0.50&dist=4   -> {"source": "adsb.fi", "ac": [...aircraft...]}
//   lat/lon: a point near you (the page rounds it to 2 decimals, about 1 km); dist: radius in nautical miles, 1-30.
//
// Settings (Worker > Settings > Variables and Secrets):
//   ALLOWED_ORIGINS  who may use it, comma separated, e.g. "https://your-name.github.io"   (default "*" = anyone)
//
// Nothing is stored. Please respect the data providers: personal, non-commercial use, and keep the credit on the page.

const SOURCES = [
  (la, lo, d) => `https://opendata.adsb.fi/api/v3/lat/${la}/lon/${lo}/dist/${d}`,   // 1 request/s limit
  (la, lo, d) => `https://api.adsb.lol/v2/point/${la}/${lo}/${d}`,                // backup
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
    const anyone = allowed.includes("*");
    const cors = {
      "Access-Control-Allow-Origin": anyone ? "*" : origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors, ...extra } });

    if (!anyone && !allowed.includes(origin)) return json(403, { error: "This page is not allowed to use this API (see ALLOWED_ORIGINS)." });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json(405, { error: "GET only" });

    const q = new URL(request.url).searchParams;
    const lat = Number(q.get("lat")), lon = Number(q.get("lon")), dist = Math.round(Number(q.get("dist") || 4));
    if (!q.get("lat") || !q.get("lon") || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return json(400, { error: "lat and lon are required" });
    const la = lat.toFixed(2), lo = lon.toFixed(2), d = Math.max(1, Math.min(30, dist || 4));

    // share one upstream answer between viewers for 2 s (works on a custom domain; on workers.dev it is skipped)
    const cache = caches.default, key = new Request(`https://cache.invalid/${la}/${lo}/${d}`);
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { "Content-Type": "application/json", ...cors } });

    let last = "no source answered";
    for (const src of SOURCES) {
      try {
        const r = await fetch(src(la, lo, d), { headers: { "User-Agent": "air-traffic-radar (personal use)" } });
        if (!r.ok) { last = `${new URL(src(la, lo, d)).hostname}: HTTP ${r.status}`; continue; }
        const j = await r.json();
        const body = JSON.stringify({ source: new URL(src(la, lo, d)).hostname, now: Date.now() / 1000, ac: j.ac || j.aircraft || [] });
        ctx.waitUntil(cache.put(key, new Response(body, { headers: { "Cache-Control": "max-age=2" } })));
        return new Response(body, { headers: { "Content-Type": "application/json", ...cors } });
      } catch (e) { last = String(e); }
    }
    return json(502, { error: last });
  },
};
