// Settings, the aircraft feed (your own API or a demo), route/photo lookups and the pass history.
// Everything personal (your location, your API address) lives only in this browser's localStorage or in the
// page address after "#", which browsers never send to any server.
(function () {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  // ------------------------------------------------------------------ settings
  // A public spot used only for the demo until you set your own location (London Heathrow's western approach).
  const DEMO_SPOT = { lat: 51.4706, lon: -0.5010, label: "Demo · Heathrow approach" };
  const RANGES = [1, 2, 5, 10, 30];
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const o = {};
    if (h.has("lat") && h.has("lon")) { o.lat = +h.get("lat"); o.lon = +h.get("lon"); }
    if (h.has("api")) o.api = h.get("api");
    if (h.has("r")) o.range = +h.get("r");
    if (h.has("label")) o.label = h.get("label");
    if (h.has("demo")) o.demo = h.get("demo") !== "0";
    if (h.has("kiosk")) o.kiosk = h.get("kiosk") !== "0";
    return o;
  }
  function settings() {
    const s = Object.assign({ range: 2, label: "Home", demo: true, api: "" }, LS.get("atr.settings", {}), readHash());
    if (!RANGES.includes(s.range)) s.range = 2;
    s.hasHome = Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180;
    if (!s.api) s.demo = true;
    if (!s.hasHome) { s.lat = DEMO_SPOT.lat; s.lon = DEMO_SPOT.lon; s.demo = true; s.label = DEMO_SPOT.label; }
    return s;
  }
  function saveSettings(patch) {
    const cur = LS.get("atr.settings", {});
    return LS.set("atr.settings", Object.assign(cur, patch));
  }

  // ------------------------------------------------------------------ lookups (adsbdb: free, no key, allows browsers)
  const CACHE_KEY = "atr.lookups", ROUTE_TTL = 7 * 86400, AC_TTL = 30 * 86400, MISS_TTL = 2 * 86400;
  const cache = LS.get(CACHE_KEY, {});
  let cacheDirty = false;
  const queue = [], pending = new Set();
  function cached(kind, key) {
    const e = cache[kind + ":" + key];
    if (!e) return undefined;
    const ttl = e.d == null ? MISS_TTL : kind === "route" ? ROUTE_TTL : AC_TTL;
    return Date.now() / 1000 - e.t < ttl ? e.d : undefined;
  }
  function want(kind, key) {
    if (!key || pending.has(kind + ":" + key) || cached(kind, key) !== undefined) return;
    pending.add(kind + ":" + key); queue.push([kind, key]);
  }
  async function lookupLoop() {
    for (;;) {
      const job = queue.shift();
      if (!job) { await sleep(500); continue; }
      const [kind, key] = job;
      try {
        const r = await fetch(`https://api.adsbdb.com/v0/${kind === "route" ? "callsign" : "aircraft"}/${encodeURIComponent(key)}`);
        let d = null;
        if (r.ok) { const j = await r.json(); d = (kind === "route" ? j.response?.flightroute : j.response?.aircraft) || null; }
        else if (r.status !== 404) throw new Error(r.status);
        cache[kind + ":" + key] = { t: Date.now() / 1000, d: slim(kind, d) }; cacheDirty = true;
      } catch (e) { /* try again on a later sighting */ }
      pending.delete(kind + ":" + key);
      await sleep(1000);                       // far below adsbdb's limits
    }
  }
  function slim(kind, d) {                    // keep the cache small
    if (!d) return null;
    if (kind === "route") {
      const ap = (a) => a && { iata: a.iata_code, icao: a.icao_code, city: a.municipality, lat: a.latitude, lon: a.longitude };
      return { airline: d.airline?.name, iata: d.callsign_iata, o: ap(d.origin), d: ap(d.destination) };
    }
    return { model: [d.manufacturer, d.type].filter(Boolean).join(" "), owner: d.registered_owner, photo: d.url_photo, thumb: d.url_photo_thumbnail };
  }
  setInterval(() => {                         // save the cache now and then, pruning the oldest entries
    if (!cacheDirty) return;
    const keys = Object.keys(cache);
    if (keys.length > 3000) keys.sort((a, b) => cache[a].t - cache[b].t).slice(0, keys.length - 2500).forEach((k) => delete cache[k]);
    LS.set(CACHE_KEY, cache); cacheDirty = false;
  }, 15000);

  function enrich(p, s) {
    const cs = p.callsign, out = {};
    if (cs) want("route", cs);
    if (p.hex && !String(p.hex).startsWith("~")) want("aircraft", p.hex);
    const fr = cs ? cached("route", cs) : null, ac = p.hex ? cached("aircraft", p.hex) : null;
    if (fr) {
      Object.assign(out, { airline: fr.airline, flight_iata: fr.iata, origin: fr.o?.iata || fr.o?.icao, origin_city: fr.o?.city,
        dest: fr.d?.iata || fr.d?.icao, dest_city: fr.d?.city });
      // a low pass whose route neither starts nor ends within 80 km is probably an out-of-date route
      const near = (a) => a && Number.isFinite(a.lat) && Math.hypot(...Geo.enu(s.lat, s.lon, a.lat, a.lon)) < 80;
      const alt = p.alt ?? p.alt_now;
      out.route_ok = typeof alt === "number" && alt < 6000 && !near(fr.o) && !near(fr.d) ? 0 : 1;
    }
    if (ac) Object.assign(out, { photo: ac.photo, thumb: ac.thumb, model: ac.model });
    if (!out.airline) out.airline = (ac && ac.owner) || undefined;
    return out;
  }

  // ------------------------------------------------------------------ demo traffic (simulated, no network)
  const DEMO_AIRLINES = ["Demo Air", "Sample Airways", "Example Jet", "Test Wings"];
  const DEMO_TYPES = [["A320", "Airbus A320"], ["B738", "Boeing 737-800"], ["E75L", "Embraer 175"], ["B789", "Boeing 787-9"], ["DH8D", "Dash 8-400"], ["A21N", "Airbus A321neo"]];
  const DEMO_CITIES = ["Northport", "Lakeside", "Riverton", "Hillcrest", "Bayview", "Eastfield"];
  let demo = [], demoN = 0;
  function demoPlane(R) {
    const ang = Math.random() * Math.PI * 2, start = R * 2.2 + 2, miss = (Math.random() - 0.5) * R * 1.6;
    const x0 = Math.sin(ang) * start, y0 = Math.cos(ang) * start;
    const trackRad = Math.atan2(-x0, -y0) + Math.atan2(miss, start);
    const low = Math.random() < 0.6, alt = low ? 1200 + Math.random() * 4000 : 12000 + Math.random() * 25000;
    const [t, desc] = DEMO_TYPES[demoN % DEMO_TYPES.length];
    const n = ++demoN;
    return { hex: "~demo" + n, flight: "DMO" + (100 + n), t, desc, x: x0, y: y0, track: (trackRad * 180 / Math.PI + 360) % 360,
      gs: low ? 140 + Math.random() * 60 : 380 + Math.random() * 80, alt_baro: Math.round(alt / 25) * 25,
      baro_rate: low ? (Math.random() < 0.5 ? -800 : 1500) : 0,
      demo: { airline: DEMO_AIRLINES[n % 4], o: DEMO_CITIES[n % 6], d: DEMO_CITIES[(n + 3) % 6] } };
  }
  function demoTick(s, dt) {
    const R = s.range;
    if (!demo.length) for (let i = 0; i < 5; i++) {          // start part-way along their paths so they are spread out
      const p = demoPlane(R), dd = (0.15 + i * 0.4) * (R * 2.2 + 2);
      p.x += dd * Math.sin(p.track * Math.PI / 180); p.y += dd * Math.cos(p.track * Math.PI / 180); demo.push(p);
    }
    for (const p of demo) {
      const v = p.gs * 0.000514444 * dt;
      p.x += v * Math.sin(p.track * Math.PI / 180); p.y += v * Math.cos(p.track * Math.PI / 180);
      p.alt_baro = Math.max(400, Math.round((p.alt_baro + p.baro_rate * dt / 60) / 25) * 25);
    }
    demo = demo.filter((p) => Math.hypot(p.x, p.y) < R * 2.4 + 3);
    while (demo.length < 5) demo.push(demoPlane(R));
    // as lat/lon around the location, so the rest of the page treats it like real data
    const kx = 111.32 * Math.cos(s.lat * Math.PI / 180);
    return demo.map((p) => Object.assign({}, p, { lat: s.lat + p.y / 110.574, lon: s.lon + p.x / kx }));
  }

  // ------------------------------------------------------------------ pass history (this browser only)
  const HIST_KEY = "atr.passes";
  let history = LS.get(HIST_KEY, []);
  function savePass(p, s) {
    const e = p.demo ? {} : enrich(p, s);
    history.unshift({ closest_ts: p.closest_ts, callsign: p.callsign, flight_iata: e.flight_iata, airline: e.airline || p.demoAirline,
      type: p.type, alt: p.alt, phase: p.phase, min_km: p.min_km, side: p.side, origin: e.origin || p.demoO, origin_city: e.origin_city,
      dest: e.dest || p.demoD, dest_city: e.dest_city, route_ok: e.route_ok, demo: !!p.demo });
    history = history.slice(0, 300);
    LS.set(HIST_KEY, history);
  }

  // ------------------------------------------------------------------ the feed
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let tracker = null, trackerKey = "", lastDemo = 0;

  /** One update: returns { ok, source, error, aircraft: [...relative to home...], recent, today }. */
  async function poll(s) {
    const key = `${s.lat},${s.lon},${s.demo}`;
    if (key !== trackerKey) { tracker = new Geo.Tracker(s.lat, s.lon); trackerKey = key; demo = []; }
    let raw, source, error = null;
    if (s.demo) {
      const now = performance.now(), dt = lastDemo ? Math.min(10, (now - lastDemo) / 1000) : 0;
      lastDemo = now; raw = demoTick(s, dt); source = "demo";
    } else {
      // the API only ever sees a point rounded to ~1 km and a radius; true distances are worked out here
      const dist = Math.max(4, Math.min(30, Math.ceil(s.range * 1.35 / 1.852 + 2)));
      const url = `${s.api.replace(/\/+$/, "")}/?lat=${s.lat.toFixed(2)}&lon=${s.lon.toFixed(2)}&dist=${dist}`;
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        raw = j.ac || j.aircraft || []; source = j.source || "api";
      } catch (e) { return { ok: false, error: `Your API did not answer (${e.message}). Check its address in Settings.`, aircraft: [] }; }
    }
    const now = Date.now() / 1000;
    const ended = tracker.update(raw, now, 7);
    for (const p of ended) if (p.min_km <= 5) {
      if (String(p.hex).startsWith("~demo")) p.demo = true;
      savePass(p, s);
    }
    const aircraft = [];
    for (const a of raw) {
      if (!Geo.airborne(a)) continue;
      const c = Geo.closest(s.lat, s.lon, a, 900);
      const cs = (a.flight || "").trim();
      const base = { hex: a.hex, callsign: cs, alt_now: a.alt_baro };
      const e = a.demo ? { airline: a.demo.airline, origin_city: a.demo.o, dest_city: a.demo.d, origin: a.demo.o, dest: a.demo.d, route_ok: 1 } : enrich(base, s);
      if (a.demo) { const tp = tracker.live.get(a.hex); if (tp) Object.assign(tp, { demoAirline: a.demo.airline, demoO: a.demo.o, demoD: a.demo.d }); }
      aircraft.push({ hex: a.hex, callsign: cs || null, flight: e.flight_iata || cs || null, airline: e.airline, type: a.t,
        type_name: e.model || a.desc, reg: a.r, alt: a.alt_baro, gs: a.gs, track: a.track, phase: Geo.phase(a),
        x: Math.round(c.x * 1000) / 1000, y: Math.round(c.y * 1000) / 1000, km: Math.round(c.nowKm * 100) / 100,
        home_km: Math.round(c.km * 100) / 100, home_in: Math.round(c.ahead), origin: e.origin, origin_city: e.origin_city,
        dest: e.dest, dest_city: e.dest_city, route_ok: e.route_ok, photo: e.photo });
    }
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const lim = Math.min(s.range, 5);
    const mine = history.filter((h) => !!h.demo === !!s.demo);
    return { ok: true, source, error, aircraft,
      recent: mine.filter((h) => h.min_km <= lim && h.closest_ts > now - 3 * 3600).slice(0, 12),
      today: mine.filter((h) => h.min_km <= lim && h.closest_ts * 1000 >= midnight.getTime()).length };
  }

  function clearHistory() { history = []; LS.set(HIST_KEY, history); }

  lookupLoop();
  window.ATR = { settings, saveSettings, poll, RANGES, DEMO_SPOT, clearHistory, LS };
})();
