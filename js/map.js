// Sketch map under the radar, from OpenStreetMap via the free Overpass API (no key; it allows browser requests).
// Asked for once per location around a point rounded to ~1 km, simplified, stored as km from home and cached in this
// browser for 30 days. Also finds nearby airports with an IATA code for the markers on the scope.
(function () {
  const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"];
  const TTL = 30 * 86400 * 1000;

  function simplify(pts, tol) {               // Douglas-Peucker, points in km
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, ll = Math.hypot(dx, dy) || 1e-9;
      let best = 0, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / ll;
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function classify(t) {
    const h = t.highway || "", w = t.waterway || "";
    if (h === "motorway" || h === "trunk") return "hwy";
    if (h === "primary" || h === "secondary") return "major";
    if (h.endsWith("_link")) return "link";
    if (["tertiary", "residential", "unclassified", "living_street"].includes(h)) return "street";
    if (t.railway === "rail") return "rail";
    if (w === "river" || w === "canal") return "river";
    if (w === "stream") return "stream";
    if (t.natural === "coastline") return "shore";
    if (t.natural === "water") return "water";
    if (t.leisure === "park" || t.leisure === "golf_course" || t.landuse === "cemetery") return "park";
    if (t.aeroway === "runway") return "runway";
    return null;
  }

  async function overpass(q) {
    let last;
    for (const url of MIRRORS) {
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
        const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), signal: ctl.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        clearTimeout(t);
        if (r.ok) return await r.json();
        last = new Error(`HTTP ${r.status}`);
      } catch (e) { last = e; }
    }
    throw last;
  }

  /** Map for a location and range: { features: [{k, p:[[x,y]...], n?, ref?}], places: [{id, name, x, y}] }.
   *  Two detail levels so each request stays small: "near" (ranges up to 5 km: every street within ~5 km) and
   *  "far" (10 and 30 km: highways, main roads, rail, water and runways within ~35 km). */
  async function load(lat, lon, range) {
    const level = range <= 5 ? "near" : "far";
    const qlat = +lat.toFixed(2), qlon = +lon.toFixed(2);
    const key = `atr.map.${level}.${lat.toFixed(5)},${lon.toFixed(5)}`;   // stored in this browser only
    const hit = ATR.LS.get(key, null);
    if (hit && Date.now() - hit.built < TTL) return hit;
    const box = (d) => { const dl = d / Math.cos(qlat * Math.PI / 180); return `(${(qlat - d).toFixed(4)},${(qlon - dl).toFixed(4)},${(qlat + d).toFixed(4)},${(qlon + dl).toFixed(4)})`; };
    const near = box(0.05), wide = box(0.32), mid = box(0.12);
    const parts = level === "near" ? [
      `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|motorway_link|trunk_link|primary_link|secondary_link)$"]${near}`,
      `way["railway"="rail"]${near}`, `way["waterway"~"^(river|canal|stream)$"]${near}`, `way["natural"~"^(coastline|water)$"]${near}`,
      `way["leisure"~"^(park|golf_course)$"]${near}`, `way["landuse"="cemetery"]${near}`, `way["aeroway"="runway"]${near}`,
    ] : [
      `way["highway"~"^(motorway|trunk|primary)$"]${wide}`, `way["highway"="secondary"]${mid}`, `way["railway"="rail"]${mid}`,
      `way["waterway"~"^(river|canal)$"]${wide}`, `way["natural"="coastline"]${wide}`, `way["aeroway"="runway"]${wide}`,
    ];
    const q = `[out:json][timeout:60];(${parts.join(";")};);out geom;nwr["aeroway"="aerodrome"]["iata"]${box(0.3)};out center;`;
    const raw = await overpass(q);
    const tol = { hwy: 0.02, major: 0.012, river: 0.02, shore: 0.03, water: 0.02, rail: 0.015, runway: 0.01 };
    const features = [], places = [];
    for (const el of raw.elements || []) {
      const t = el.tags || {};
      if (t.aeroway === "aerodrome") {
        const c = el.center || (el.lat != null ? el : null);
        if (c) { const [x, y] = Geo.enu(lat, lon, c.lat, c.lon); places.push({ id: t.iata, name: t["name:en"] || t.name || t.iata, x: +x.toFixed(2), y: +y.toFixed(2) }); }
        continue;
      }
      const k = classify(t);
      if (!k || !el.geometry) continue;
      let pts = el.geometry.map((g) => Geo.enu(lat, lon, g.lat, g.lon));
      pts = simplify(pts, tol[k] || 0.004).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
      const f = { k, p: pts };
      if (k === "hwy" && t.ref) f.ref = t.ref.split(";")[0];
      if (t.name && ["hwy", "major", "river", "park", "water", "street"].includes(k)) f.n = t.name;
      features.push(f);
    }
    const data = { built: Date.now(), features, places };
    try { for (const k of Object.keys(localStorage)) if (k.startsWith("atr.map.") && !k.endsWith(`.${lat.toFixed(5)},${lon.toFixed(5)}`)) localStorage.removeItem(k); } catch (e) {}
    ATR.LS.set(key, data);                     // may fail if the browser's storage is full: then it is fetched again next time
    return data;
  }

  window.SketchMap = { load };
})();
