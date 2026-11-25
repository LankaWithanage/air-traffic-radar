// Pure geometry and pass tracking. No DOM: also loaded by tests/test_geo.mjs under Node.
(function (root) {
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const GONE_S = 45;                         // a pass ends when the aircraft has not been seen for this long

  /** Local flat-earth offset in km (x east, y north) from home to a point. Fine within a few dozen km. */
  function enu(homeLat, homeLon, lat, lon) {
    return [(lon - homeLon) * 111.32 * Math.cos(homeLat * Math.PI / 180), (lat - homeLat) * 110.574];
  }

  function compass(deg) { return COMPASS[Math.floor((((deg % 360) + 360) % 360 + 22.5) / 45) % 8]; }

  function airborne(a) { return a && typeof a.lat === "number" && typeof a.lon === "number" && a.alt_baro !== "ground" && a.alt_baro != null; }

  function phase(a) {
    const r = a.baro_rate ?? a.geom_rate ?? 0;
    return r > 300 ? "climbing" : r < -300 ? "descending" : "level";
  }

  /** Closest approach to home, looking ahead at most `horizon` seconds along the track at ground speed.
   *  Returns { km, ahead (s), nowKm, x, y (now), bearing (deg from home at the closest point) }. */
  function closest(homeLat, homeLon, a, horizon) {
    let [x, y] = enu(homeLat, homeLon, a.lat, a.lon);
    const nowX = x, nowY = y, nowKm = Math.hypot(x, y);
    let t = 0;
    if (a.gs && a.track != null) {
      const v = a.gs * 0.000514444;                         // knots -> km/s
      const vx = v * Math.sin(a.track * Math.PI / 180), vy = v * Math.cos(a.track * Math.PI / 180);
      const vv = vx * vx + vy * vy;
      if (vv > 0) {
        t = Math.max(0, Math.min(horizon, -(x * vx + y * vy) / vv));
        x += vx * t; y += vy * t;
      }
    }
    return { km: Math.hypot(x, y), ahead: t, nowKm, x: nowX, y: nowY, bearing: ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360 };
  }

  /** Turns feed snapshots into passes; update() returns the passes that just ended. */
  class Tracker {
    constructor(homeLat, homeLon) { this.lat = homeLat; this.lon = homeLon; this.live = new Map(); }
    update(aircraft, now, horizon) {
      for (const a of aircraft) {
        if (!airborne(a)) continue;
        const c = closest(this.lat, this.lon, a, horizon);
        let p = this.live.get(a.hex);
        if (!p) { p = { hex: a.hex, first: now, min_km: 99, samples: 0 }; this.live.set(a.hex, p); }
        p.samples++; p.last = now;
        for (const [src, k] of [["flight", "callsign"], ["r", "reg"], ["t", "type"], ["desc", "type_name"]]) {
          const v = a[src];
          if (v != null && v !== "") p[k] = typeof v === "string" ? v.trim() : v;
        }
        if (c.km < p.min_km) {
          const rate = a.baro_rate ?? a.geom_rate ?? 0;
          Object.assign(p, { min_km: Math.round(c.km * 1000) / 1000, closest_ts: now + c.ahead, side: compass(c.bearing),
            alt: Math.round(a.alt_baro + rate * c.ahead / 60), gs: a.gs, track: a.track, phase: phase(a) });
        }
      }
      const ended = [];
      for (const [hex, p] of this.live) if (now - p.last > GONE_S) { ended.push(p); this.live.delete(hex); }
      return ended;
    }
  }

  root.Geo = { enu, compass, airborne, phase, closest, Tracker, GONE_S };
})(typeof window !== "undefined" ? window : globalThis);
