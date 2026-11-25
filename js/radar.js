// Air Traffic Radar: scope, side panel and settings. Data comes from js/data.js (your API or the demo), the map
// from js/map.js. Between updates planes are moved along their track at their ground speed so motion is smooth.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let S = ATR.settings();
  let R = S.range, VIEW_KM = R * 1.3, RINGS = [];
  const RING_SETS = { 1: [0.25, 0.5, 1], 2: [0.5, 1, 1.5, 2], 5: [1, 2, 5], 10: [2, 5, 10], 30: [5, 10, 20, 30] };
  const cv = $("cv"), ctx = cv.getContext("2d");
  let data = null, gotAt = 0, W = 0, dpr = 1, u = 1;   // u: drawing scale (1 = a 700 px scope)
  const trails = new Map();                            // hex -> [[x, y, t]...]
  document.body.classList.toggle("kiosk", !!S.kiosk);

  const ALT_COL = [[3000, "#ffb347", "below 3,000 ft"], [10000, "#3ef2ff", "3,000-10,000 ft"], [25000, "#b388ff", "10,000-25,000 ft"], [1e9, "#e8f1ff", "above 25,000 ft"]];
  const altCol = (a) => typeof a === "number" ? ALT_COL.find((c) => a < c[0])[1] : "#888";
  $("legend").innerHTML = ALT_COL.map((c) => `<div><i style="background:${c[1]}"></i>${c[2]}</div>`).join("") + '<div><i style="background:#ff3ec8"></i>next overhead</div>';
  $("zoom").innerHTML = ATR.RANGES.map((r) => `<button data-r="${r}">${r} km</button>`).join("");
  $("zoom").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { ATR.saveSettings({ range: +b.dataset.r }); apply(); } });

  function setRange(r) {
    R = r; VIEW_KM = R * 1.3; RINGS = RING_SETS[R];
    $("rng").textContent = `· ${R} km around ${S.label}`;
    document.querySelectorAll("#zoom button").forEach((b) => b.classList.toggle("on", +b.dataset.r === R));
    for (const h of document.querySelectorAll("section h2[data-in]")) h.textContent = `Inside ${R} km now`;
  }

  // ---------------------------------------------------------------------------------- data
  let timer = null, MAPD = null, mapCv = null, mapKey = "", mapFor = "";
  function apply() {                          // (re)read settings, reset what depends on them
    S = ATR.settings(); setRange(S.range); trails.clear(); data = null; mapKey = "";
    loadMap();
    banner();
    clearTimeout(timer); load();
  }
  let mapTried = 0;
  function loadMap() {
    const where = `${S.lat.toFixed(5)},${S.lon.toFixed(5)},${S.range <= 5 ? "near" : "far"}`;
    if (where === mapFor) return;
    mapFor = where; MAPD = null; mapTried = Date.now();
    const note = (t) => { $("mapnote").textContent = t; $("mapnote").classList.toggle("on", !!t && !S.kiosk); };
    note("Loading the street map… (the first time can take up to a minute)");
    SketchMap.load(S.lat, S.lon, S.range).then((m) => { if (mapFor === where) { MAPD = m; mapKey = ""; note(""); } })
      .catch(() => { if (mapFor === where) { mapFor = ""; note("Street map servers are busy; trying again in 2 minutes"); } });
  }
  setInterval(() => { if (!MAPD && !mapFor && Date.now() - mapTried > 120000) loadMap(); }, 30000);
  function banner(err) {
    const b = $("banner");
    b.classList.toggle("err", !!err);
    b.textContent = err || (S.demo ? (S.hasHome ? "Demo: simulated planes. Add your API in Settings for live traffic." :
      "Demo: simulated planes near a sample airport. Tap here to set your location.") : "");
    b.classList.toggle("on", !!b.textContent && !S.kiosk);
  }
  $("banner").addEventListener("click", openSettings);

  async function load() {
    let d;
    try { d = await ATR.poll(S); } catch (e) { d = { ok: false, error: String(e.message || e), aircraft: [] }; }
    if (d.ok) {
      data = d; gotAt = performance.now();
      const now = Date.now() / 1000;
      for (const a of d.aircraft) {
        const t = trails.get(a.hex) || [];
        const last = t[t.length - 1];
        if (!last || last[0] !== a.x || last[1] !== a.y) t.push([a.x, a.y, now]);
        while (t.length && now - t[0][2] > 180) t.shift();
        trails.set(a.hex, t);
      }
      const live = new Set(d.aircraft.map((a) => a.hex));
      for (const k of trails.keys()) if (!live.has(k)) trails.delete(k);
      side(d);
      $("upd").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
      $("src").textContent = d.source === "demo" ? "simulated planes (demo)" : `positions ${d.source}`;
      banner();
    } else { banner(d.error); if (!data) side({ aircraft: [], recent: [], today: 0 }); }
    clearTimeout(timer); timer = setTimeout(load, S.demo ? 1000 : 3000);
  }

  // ---------------------------------------------------------------------------------- side panel
  const ftTxt = (a) => typeof a === "number" ? a.toLocaleString("en-US") + " ft" : "";
  const city = (c, code) => esc(c || code || "?");
  const row = (a, right, sub) => `<div class="r"><div class="a">${esc(a.airline || "")} <small>${esc(a.flight || a.reg || a.hex || "")}</small></div><div class="b">${right}</div><div class="c">${sub}</div></div>`;
  const route = (a) => a.origin ? `${city(a.origin_city, a.origin)} → ${city(a.dest_city, a.dest)}${a.route_ok === 0 ? " ?" : ""}` : "route unknown";
  let nextHex = null;
  function side(d) {
    const ac = d.aircraft.filter((a) => typeof a.alt === "number");
    const inside = ac.filter((a) => a.km <= R).sort((a, b) => a.km - b.km);
    const next = ac.filter((a) => a.km > R && a.home_km <= R && a.home_in > 0).sort((a, b) => a.home_in - b.home_in);
    const inS = (s) => s < 60 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
    const t12 = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("c-now").innerHTML = `<b>${inside.length}</b> overhead`;
    $("c-next").innerHTML = `<b>${next.length}</b> coming`;
    $("c-today").innerHTML = `<b>${d.today ?? 0}</b> today`;
    $("l-now").innerHTML = inside.slice(0, 3).map((a) => row(a, `${a.km.toFixed(1)} km`, `${esc(a.type || "")} · ${ftTxt(a.alt)} · ${route(a)}`)).join("") || `<div class="none">Clear sky inside ${R} km.</div>`;
    $("l-next").innerHTML = next.slice(0, 3).map((a) => row(a, inS(a.home_in), `${esc(a.type || "")} · ${ftTxt(a.alt)} · passes ${a.home_km.toFixed(1)} km away`)).join("") || '<div class="none">Nothing heading this way yet.</div>';
    $("l-past").innerHTML = (d.recent || []).map((p) => row({ airline: p.airline, flight: p.flight_iata || p.callsign }, t12(p.closest_ts),
      `${esc(p.type || "")} · ${ftTxt(p.alt)} · ${p.min_km.toFixed(1)} km ${esc(p.side || "")} · ${route(p)}`)).join("") || '<div class="none">Passes inside the circle show up here (kept in this browser).</div>';
    requestAnimationFrame(fitLists);
    // the next one overhead: inside 2 km now, or predicted to pass within 2 km
    const near = Math.min(2, R);
    const cand = ac.filter((a) => a.km <= near || (a.home_km <= near && a.home_in > 0)).sort((a, b) => (a.km <= near ? a.km - 9 : a.home_in) - (b.km <= near ? b.km - 9 : b.home_in));
    const n = cand[0];
    nextHex = n ? n.hex : null;
    const el = $("next");
    el.classList.toggle("quiet", !n);
    if (!n) { el.innerHTML = '<div><div class="k">Next overhead</div><div class="s">Nothing heading overhead right now.</div></div>'; return; }
    const when = n.km <= near ? "Overhead now" : n.home_in < 60 ? `Overhead in ${n.home_in} s` : `Overhead in ${Math.round(n.home_in / 60)} min`;
    el.innerHTML = (n.photo ? `<img src="${esc(n.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : "") +
      `<div><div class="k">${when}</div><div class="t">${esc(n.airline || "")} ${esc(n.flight || n.hex)}</div>` +
      `<div class="s">${route(n)}</div><div class="m">${esc(n.type_name || n.type || "")} · ${ftTxt(n.alt)} · ` +
      `${n.phase === "climbing" ? '<span class="up">▲ climbing</span>' : n.phase === "descending" ? '<span class="down">▼ descending</span>' : "level"}</div></div>`;
  }
  function fitLists() {
    for (const l of document.querySelectorAll(".lst")) {
      const limit = l.closest("section").getBoundingClientRect().bottom - 6;
      for (const r of l.querySelectorAll(".r")) r.style.display = "";
      for (const r of l.querySelectorAll(".r")) if (r.getBoundingClientRect().bottom > limit) r.style.display = "none";
    }
  }

  // ---------------------------------------------------------------------------------- sketch map
  const STY = {
    park: { fill: "rgba(60,200,120,0.09)", max: 5 }, water: { fill: "rgba(40,120,255,0.20)" },
    shore: { stroke: "rgba(90,170,255,0.75)", w: 2.2 }, river: { stroke: "rgba(90,170,255,0.65)", w: 2.6 },
    stream: { stroke: "rgba(90,170,255,0.40)", w: 1.2, max: 5 }, street: { stroke: "rgba(160,200,240,0.20)", w: 1.1, max: 5 },
    link: { stroke: "rgba(255,179,71,0.30)", w: 1.4, max: 10 }, rail: { stroke: "rgba(210,210,230,0.32)", w: 1.4, dash: [6, 5] },
    major: { stroke: "rgba(160,205,255,0.36)", w: 2 }, hwy: { stroke: "rgba(255,179,71,0.55)", w: 3.6 },
    runway: { stroke: "rgba(93,255,156,0.6)", w: 6 },
  };
  const ORDER = ["park", "water", "shore", "river", "stream", "street", "link", "rail", "major", "hwy", "runway"];
  function renderMap(c, k) {
    if (!mapCv) mapCv = document.createElement("canvas");
    mapCv.width = W; mapCv.height = W;
    const m = mapCv.getContext("2d");
    const P = (x, y) => [c + x * k, c - y * k];
    m.save(); m.beginPath(); m.arc(c, c, c - 2, 0, 7); m.clip();
    m.lineJoin = m.lineCap = "round";
    const lim = VIEW_KM * 1.05, inView = (f) => f.p.some(([x, y]) => Math.abs(x) < lim && Math.abs(y) < lim);
    const byKind = {};
    for (const f of MAPD.features) (byKind[f.k] = byKind[f.k] || []).push(f);
    for (const kind of ORDER) {
      const st = STY[kind];
      if (!st || (st.max && R > st.max)) continue;
      for (const f of byKind[kind] || []) {
        if (!inView(f)) continue;
        m.beginPath();
        f.p.forEach(([x, y], i) => { const [px, py] = P(x, y); i ? m.lineTo(px, py) : m.moveTo(px, py); });
        if (st.fill) { m.fillStyle = st.fill; m.fill(); }
        else {
          m.strokeStyle = kind === "major" && R >= 30 ? "rgba(160,205,255,0.2)" : st.stroke;
          m.lineWidth = st.w * u * (R <= 2 && kind === "major" ? 1.25 : 1);
          m.setLineDash(st.dash ? st.dash.map((d) => d * u) : []); m.stroke();
        }
      }
    }
    m.setLineDash([]);
    // labels: the longest visible piece of each name, no overlaps
    const want = { hwy: 10, river: 5, major: R <= 10 ? 16 : 0, street: R <= 2 ? 16 : R <= 5 ? 8 : 0, park: R <= 2 ? 6 : 0 };
    const best = new Map();
    for (const f of MAPD.features) {
      const name = f.k === "hwy" ? (f.ref || f.n) : f.n;
      if (!name || !want[f.k]) continue;
      const vis = f.p.filter(([x, y]) => Math.hypot(x, y) < VIEW_KM * 0.92);
      if (vis.length < 2) continue;
      let len = 0; for (let i = 1; i < vis.length; i++) len += Math.hypot(vis[i][0] - vis[i - 1][0], vis[i][1] - vis[i - 1][1]);
      const key = f.k + "|" + name;
      if (!best.has(key) || best.get(key).len < len) best.set(key, { f, name, vis, len });
    }
    const boxes = [], count = {};
    const sorted = [...best.values()].sort((a, b) => ORDER.indexOf(b.f.k) - ORDER.indexOf(a.f.k) || b.len - a.len);
    for (const L of sorted) {
      const kind = L.f.k;
      if ((count[kind] = (count[kind] || 0) + 1) > want[kind]) continue;
      const i = Math.floor(L.vis.length / 2), a = L.vis[Math.max(0, i - 1)], b = L.vis[Math.min(L.vis.length - 1, i)];
      const [x1, y1] = P(a[0], a[1]), [x2, y2] = P(b[0], b[1]);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      let ang = Math.atan2(y2 - y1, x2 - x1); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      const hw = kind === "hwy";
      const size = (hw ? 13 : kind === "street" ? 11.5 : 12.5) * u;
      m.font = `${hw ? "bold " : ""}${size}px "Share Tech Mono", monospace`;
      const tw = m.measureText(L.name).width + 8 * u, th = size + 6 * u, r = Math.max(tw, th) / 2;
      if (boxes.some(([bx, by, br]) => Math.hypot(bx - mx, by - my) < br + r)) continue;
      boxes.push([mx, my, r]);
      m.save(); m.translate(mx, my);
      if (hw) {                                                         // highway shield
        m.fillStyle = "rgba(60,36,6,0.9)"; m.strokeStyle = "rgba(255,179,71,0.8)"; m.lineWidth = 1.2 * u;
        m.beginPath(); m.rect(-tw / 2, -th / 2, tw, th); m.fill(); m.stroke();
        m.fillStyle = "#ffcf8a"; m.textAlign = "center"; m.textBaseline = "middle"; m.fillText(L.name, 0, 1 * u);
      } else {
        m.rotate(ang); m.textAlign = "center"; m.textBaseline = "middle";
        m.fillStyle = kind === "river" ? "rgba(140,200,255,0.85)" : kind === "park" ? "rgba(110,220,150,0.7)" : kind === "street" ? "rgba(190,215,240,0.55)" : "rgba(200,225,255,0.75)";
        m.strokeStyle = "rgba(2,6,12,0.85)"; m.lineWidth = 3 * u; m.strokeText(L.name, 0, 0); m.fillText(L.name, 0, 0);
      }
      m.restore();
    }
    m.restore();
  }

  // ---------------------------------------------------------------------------------- scope
  function size() {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(200, Math.round(r.width * dpr));
    cv.width = W; cv.height = W; u = W / 700; mapKey = "";
  }
  window.addEventListener("resize", () => { size(); if (data) side(data); setTimeout(fitLists, 300); });

  let sweep = 0, lastDraw = 0;
  function draw(ts) {
    requestAnimationFrame(draw);
    if (ts - lastDraw < 50) return;           // ~20 fps is plenty and keeps small computers cool
    const dt = (ts - lastDraw) / 1000; lastDraw = ts;
    if (!W) size();
    const c = W / 2, k = (W / 2 - 6 * u) / VIEW_KM;   // px per km
    const P = (x, y) => [c + x * k, c - y * k];
    ctx.clearRect(0, 0, W, W);
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, "rgba(10,40,60,0.55)"); g.addColorStop(1, "rgba(2,6,12,0.2)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c, c, c - 2, 0, 7); ctx.fill();
    if (MAPD) {
      if (mapKey !== `${W}|${R}`) { renderMap(c, k); mapKey = `${W}|${R}`; }
      ctx.drawImage(mapCv, 0, 0);
    }
    ctx.lineWidth = Math.max(1, 1.2 * u); ctx.font = `${12 * u}px "Share Tech Mono", monospace`; ctx.textAlign = "left";
    for (const r of RINGS) {
      const key = r === Math.min(2, R);
      ctx.strokeStyle = key ? "rgba(255,179,71,0.55)" : "rgba(62,242,255,0.22)";
      ctx.setLineDash(key ? [4 * u, 4 * u] : []);
      ctx.beginPath(); ctx.arc(c, c, r * k, 0, 7); ctx.stroke();
      ctx.fillStyle = "rgba(170,225,235,0.55)"; ctx.fillText(r < 1 ? `${r * 1000} m` : `${r} km`, c + 4 * u, c - r * k + 14 * u);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(62,242,255,0.10)"; ctx.beginPath(); ctx.moveTo(c, 0); ctx.lineTo(c, W); ctx.moveTo(0, c); ctx.lineTo(W, c); ctx.stroke();
    ctx.fillStyle = "rgba(170,225,235,0.6)"; ctx.textAlign = "center"; ctx.font = `${15 * u}px Orbitron, sans-serif`;
    ctx.fillText("N", c, 18 * u); ctx.fillText("S", c, W - 6 * u); ctx.fillText("E", W - 10 * u, c + 5 * u); ctx.fillText("W", 10 * u, c + 5 * u);
    sweep = (sweep + dt * 0.9) % (Math.PI * 2);
    if (ctx.createConicGradient) {
      const sg = ctx.createConicGradient(sweep - Math.PI / 2 - 0.6, c, c);
      sg.addColorStop(0, "rgba(62,242,255,0)"); sg.addColorStop(0.095, "rgba(62,242,255,0.16)"); sg.addColorStop(0.1, "rgba(62,242,255,0)");
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(c, c, c - 2, 0, 7); ctx.fill();
    }
    // airports: on the scope, or pinned to the rim with their distance when off it (within 25 km)
    for (const p of (MAPD && MAPD.places) || []) {
      let [px, py] = P(p.x, p.y);
      const far = Math.hypot(p.x, p.y);
      if (far > Math.max(25, VIEW_KM)) continue;
      ctx.fillStyle = "rgba(93,255,156,0.8)"; ctx.font = `${13 * u}px "Share Tech Mono", monospace`; ctx.textAlign = "center";
      if (far > VIEW_KM) {
        const ang = Math.atan2(p.x, p.y), rr = c - 26 * u;
        px = c + Math.sin(ang) * rr; py = c - Math.cos(ang) * rr;
        ctx.fillText(`${p.name} ${far.toFixed(1)} km`, px, py + (Math.cos(ang) > 0 ? 16 : -8) * u);
        ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(0, -9 * u); ctx.lineTo(6 * u, 0); ctx.lineTo(-6 * u, 0); ctx.closePath(); ctx.fill(); ctx.restore();
        continue;
      }
      ctx.save(); ctx.translate(px, py); ctx.rotate(Math.PI / 4); ctx.fillRect(-5 * u, -5 * u, 10 * u, 10 * u); ctx.restore();
      ctx.fillText(`${p.name} ${p.id}`, px, py + 20 * u);
    }
    // home
    ctx.fillStyle = "#ffb347"; ctx.beginPath(); ctx.arc(c, c, 6 * u, 0, 7); ctx.fill();
    ctx.strokeStyle = "#ffb347"; ctx.beginPath(); ctx.arc(c, c, 11 * u, 0, 7); ctx.stroke();
    ctx.font = `${13 * u}px Orbitron, sans-serif`; ctx.fillText(String(S.label).toUpperCase().slice(0, 20), c, c - 16 * u);
    if (!data) return;
    ctx.save(); ctx.beginPath(); ctx.arc(c, c, c - 2, 0, 7); ctx.clip();
    const rim = [];
    const age = Math.min(8, (performance.now() - gotAt) / 1000);
    const now = Date.now() / 1000;
    for (const a of data.aircraft) {                // trails
      const t = trails.get(a.hex);
      if (!t || t.length < 2) continue;
      ctx.strokeStyle = altCol(a.alt); ctx.lineWidth = 1.5 * u;
      for (let i = 1; i < t.length; i++) {
        ctx.globalAlpha = Math.max(0.05, 0.08 + 0.4 * (1 - (now - t[i][2]) / 180));
        const [x1, y1] = P(t[i - 1][0], t[i - 1][1]), [x2, y2] = P(t[i][0], t[i][1]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    const list = data.aircraft.slice().sort((a, b) => (b.alt || 0) - (a.alt || 0));   // low ones drawn last, on top
    for (const a of list) {
      let x = a.x, y = a.y;
      if (a.gs && a.track != null) {
        const v = a.gs * 0.000514444 * age, th = a.track * Math.PI / 180;
        x += v * Math.sin(th); y += v * Math.cos(th);
      }
      const [px, py] = P(x, y);
      if (Math.hypot(px - c, py - c) > c - 4 * u) {
        if (a.home_km <= Math.max(2.5, R) && a.home_in > 0) rim.push([a, Math.atan2(x, y)]);
        continue;
      }
      const hot = a.hex === nextHex, col = hot ? "#ff3ec8" : altCol(a.alt);
      const s = (hot ? 2.2 : a.alt < 10000 ? 1.8 : 1.3) * u;
      ctx.save(); ctx.translate(px, py); ctx.rotate(((a.track || 0) * Math.PI) / 180); ctx.scale(s, s);
      ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = hot ? 14 : 6;
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(2, -3); ctx.lineTo(10, 2); ctx.lineTo(10, 4); ctx.lineTo(2, 2); ctx.lineTo(1.5, 7);
      ctx.lineTo(4, 9); ctx.lineTo(4, 10.5); ctx.lineTo(0, 9.5); ctx.lineTo(-4, 10.5); ctx.lineTo(-4, 9); ctx.lineTo(-1.5, 7);
      ctx.lineTo(-2, 2); ctx.lineTo(-10, 4); ctx.lineTo(-10, 2); ctx.lineTo(-2, -3); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.textAlign = "left"; ctx.shadowBlur = 0;
      ctx.font = `${(hot ? 15 : 12.5) * u}px "Share Tech Mono", monospace`;
      ctx.fillStyle = hot ? "#ff9be6" : "rgba(223,252,255,0.92)";
      ctx.fillText(a.flight || a.reg || a.hex, px + 12 * u, py - 3 * u);
      ctx.fillStyle = "rgba(170,225,235,0.75)"; ctx.font = `${11 * u}px "Share Tech Mono", monospace`;
      const arrow = a.phase === "climbing" ? "↑" : a.phase === "descending" ? "↓" : "";
      ctx.fillText(`${typeof a.alt === "number" ? Math.round(a.alt / 100).toString().padStart(3, "0") : "---"}${arrow} ${a.type || ""}`, px + 12 * u, py + 10 * u);
    }
    ctx.restore();
    for (const [a, ang] of rim) {                   // heading this way but still off the scope: chevron on the rim
      const rr = c - 14 * u, px = c + Math.sin(ang) * rr, py = c - Math.cos(ang) * rr;
      const col = a.hex === nextHex ? "#ff3ec8" : altCol(a.alt);
      ctx.save(); ctx.translate(px, py); ctx.rotate(ang + Math.PI);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, -10 * u); ctx.lineTo(8 * u, 4 * u); ctx.lineTo(-8 * u, 4 * u); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = col; ctx.font = `${12.5 * u}px "Share Tech Mono", monospace`; ctx.textAlign = "center";
      ctx.fillText(`${a.flight || a.hex} · ${a.home_in < 60 ? a.home_in + " s" : Math.round(a.home_in / 60) + " min"}`, px - Math.sin(ang) * 22 * u, py + Math.cos(ang) * 22 * u + 4 * u);
    }
  }

  // ---------------------------------------------------------------------------------- settings dialog
  let fRange = 2;
  function openSettings() {
    const saved = ATR.LS.get("atr.settings", {});
    $("f-lat").value = Number.isFinite(saved.lat) ? saved.lat : "";
    $("f-lon").value = Number.isFinite(saved.lon) ? saved.lon : "";
    $("f-label").value = saved.label || "";
    $("f-api").value = saved.api || "";
    document.querySelector(`input[name=src][value=${saved.api && saved.demo === false ? "api" : "demo"}]`).checked = true;
    fRange = S.range;
    $("f-range").innerHTML = ATR.RANGES.map((r) => `<button type="button" data-r="${r}" class="${r === fRange ? "on" : ""}">${r} km</button>`).join("");
    $("f-err").textContent = "";
    $("settings").showModal();
  }
  $("gear").addEventListener("click", openSettings);
  $("f-range").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    fRange = +b.dataset.r; $("f-range").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("f-lat").addEventListener("input", () => {               // pasting "lat, lon" into the first box fills both
    const m = $("f-lat").value.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { $("f-lat").value = m[1]; $("f-lon").value = m[2]; }
  });
  $("f-geo").addEventListener("click", () => {
    if (!navigator.geolocation) { $("f-err").textContent = "This browser can't share its location."; return; }
    $("f-err").textContent = "Asking the browser for your location…";
    navigator.geolocation.getCurrentPosition((p) => {
      $("f-lat").value = p.coords.latitude.toFixed(5); $("f-lon").value = p.coords.longitude.toFixed(5); $("f-err").textContent = "";
    }, (e) => { $("f-err").textContent = `No location: ${e.message}`; }, { enableHighAccuracy: true, timeout: 15000 });
  });
  $("f-cancel").addEventListener("click", () => $("settings").close());
  $("f-clear").addEventListener("click", () => { ATR.clearHistory(); $("f-err").textContent = "Pass history cleared."; });
  $("sform").addEventListener("submit", (e) => {
    const lat = $("f-lat").value.trim(), lon = $("f-lon").value.trim();
    const src = document.querySelector("input[name=src]:checked").value, api = $("f-api").value.trim();
    const patch = { range: fRange, label: $("f-label").value.trim() || "Home", demo: src === "demo", api };
    if (lat || lon) {
      const la = +lat, lo = +lon;
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) { e.preventDefault(); $("f-err").textContent = "Latitude must be -90 to 90 and longitude -180 to 180."; return; }
      Object.assign(patch, { lat: la, lon: lo });
    } else Object.assign(patch, { lat: null, lon: null });
    if (src === "api" && !/^https?:\/\/\S+$/.test(api)) { e.preventDefault(); $("f-err").textContent = "Enter your API address (it starts with https://)."; return; }
    if (src === "api" && !(lat && lon)) { e.preventDefault(); $("f-err").textContent = "Live data needs your location too."; return; }
    ATR.saveSettings(patch);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);   // the saved settings win now
    apply();
  });
  window.addEventListener("hashchange", apply);

  function clock() { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  clock(); setInterval(clock, 10000);
  size(); apply(); requestAnimationFrame(draw);
  if (!S.hasHome && !S.kiosk && !ATR.LS.get("atr.seenIntro", false)) { ATR.LS.set("atr.seenIntro", true); setTimeout(openSettings, 1200); }
})();
