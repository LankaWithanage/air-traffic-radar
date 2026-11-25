// node tests/test_geo.mjs   - checks the distance / closest-approach / pass maths with a made-up location
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
new Function(readFileSync(new URL("../js/geo.js", import.meta.url), "utf8"))();
const { Geo } = globalThis;
const H = [45, -75];
const at = (dx, dy) => [H[0] + dy / 110.574, H[1] + dx / (111.32 * Math.cos(H[0] * Math.PI / 180))];
const ac = (hex, dx, dy, track, extra = {}) => { const [lat, lon] = at(dx, dy); return { hex, lat, lon, track, gs: 150, alt_baro: 1500, baro_rate: 0, ...extra }; };
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok", name); };

t("closest approach between samples", () => {
  const c = Geo.closest(...H, ac("a", -0.3, -1, 90), 10);      // 1 km south, flying east: passes 1 km south of home
  assert.ok(Math.abs(c.km - 1) < 0.01 && c.ahead > 3.5 && c.ahead < 4.5 && c.nowKm > 1);
  assert.equal(Geo.compass(c.bearing), "S");
});
t("moving away and the horizon", () => {
  assert.equal(Geo.closest(...H, ac("a", 3, 0, 90), 10).ahead, 0);
  assert.equal(Geo.closest(...H, ac("a", -5, 0, 90), 5).ahead, 5);
});
t("tracker records the closest point and ends the pass", () => {
  const tr = new Geo.Tracker(...H);
  assert.deepEqual(tr.update([ac("a", -2, -1, 90, { flight: "TST1  ", t: "B738" })], 0, 7), []);
  tr.update([ac("a", 0.2, -1, 90, { baro_rate: -800 })], 5, 7);
  const p = tr.live.get("a");
  assert.ok(Math.abs(p.min_km - 1) < 0.03 && p.callsign === "TST1" && p.phase === "descending" && p.side === "S");
  assert.deepEqual(tr.update([], 5 + Geo.GONE_S + 1, 7).map((e) => e.hex), ["a"]);
});
t("ground and position-less aircraft are ignored", () => {
  const tr = new Geo.Tracker(...H);
  tr.update([{ ...ac("g", 0, 0, 0), alt_baro: "ground" }, { hex: "x", alt_baro: 3000 }], 0, 7);
  assert.equal(tr.live.size, 0);
});
t("climb / descent", () => {
  assert.equal(Geo.phase({ baro_rate: 1200 }), "climbing");
  assert.equal(Geo.phase({ geom_rate: -900 }), "descending");
  assert.equal(Geo.phase({}), "level");
});
console.log(`${n} checks passed`);
