/* ========== Ratings Page Module ========== */
(function(){

const RTG_COLORS = {
  "Safe D":   "#1e40af",
  "Likely D": "#2563eb",
  "Lean D":   "#93c5fd",
  "Tossup":   "#fde047",
  "Lean R":   "#fca5a5",
  "Likely R": "#dc2626",
  "Safe R":   "#991b1b"
};
const RTG_ORDER = ["Safe D","Likely D","Lean D","Tossup","Lean R","Likely R","Safe R"];
const RTG_LABELS = ["Safe D","Likely D","Lean D","Tossup","Lean R","Likely R","Safe R"];

// Store perRace data for tooltip lookups
const RTG_PER_RACE = { senate: {}, governor: {}, house: {} };

function ratingFromMargin(m){
  if (!isFinite(m)) return null;
  const a = Math.abs(m);
  const side = m < 0 ? "D" : "R";
  if (a < 2.5) return "Tossup";
  if (a < 7.5) return `Lean ${side}`;
  if (a < 15)  return `Likely ${side}`;
  return `Safe ${side}`;
}

function computeAllRatings(modeKey, gbOverride){
  const origGb = DATA[modeKey]?.gb;
  if (gbOverride) DATA[modeKey].gb = gbOverride;

  const counts = {};
  RTG_ORDER.forEach(k => counts[k] = 0);
  const perRace = {};

  if (modeKey === "house"){
    if (gbOverride){ DATA.house.gb = gbOverride; }
    for (const did of Object.keys(DATA.house.ratios || {})){
      const model = getHouseModel(did);
      if (!model) continue;
      const mm = marginRD(model.combinedPair);
      const r = ratingFromMargin(mm);
      if (r){ counts[r]++; perRace[did] = { margin: mm, rating: r }; }
    }
  } else {
    const indNat = IND_CACHE[modeKey];
    for (const st of Object.keys(DATA[modeKey]?.ratios || {})){
      const model = getStateModel(modeKey, st, indNat);
      if (!model) continue;
      const mm = marginRD(model.combinedPair);
      const r = ratingFromMargin(mm);
      if (r){ counts[r]++; perRace[st] = { margin: mm, rating: r }; }
    }
  }

  if (gbOverride) DATA[modeKey].gb = origGb;
  return { counts, perRace };
}

/* --- UI refs --- */
const RTG_UI = {};
function initRtgUI(mode){
  const root = document.querySelector(`[data-ratings-mode='${mode}']`);
  if (!root) return;
  RTG_UI[mode] = {
    root,
    topCard: root.querySelector(".ratingsTopCard"),
    countsEl: root.querySelector("[data-rtg-counts]"),
    bar: root.querySelector("[data-rtg-bar]"),
    labels: root.querySelector("[data-rtg-labels]"),
    totals: root.querySelector("[data-rtg-totals]"),
    mapSvg: root.querySelector("[data-rtg-map]"),
    chart: root.querySelector("[data-rtg-chart]"),
    ylabel: root.querySelector("[data-rtg-ylabel]"),
    _chartMode: "detailed"
  };
}

/* --- Rating summary bar + colored numbers --- */
function renderRatingBar(mode, counts){
  const ui = RTG_UI[mode];
  if (!ui) return;

  const total = RTG_ORDER.reduce((s,k) => s + (counts[k]||0), 0);
  if (!total) return;

  const dSeats = (counts["Safe D"]||0) + (counts["Likely D"]||0) + (counts["Lean D"]||0);
  const rSeats = (counts["Safe R"]||0) + (counts["Likely R"]||0) + (counts["Lean R"]||0);

  // Color top card border
  if (ui.topCard){
    ui.topCard.classList.remove("leads-d","leads-r");
    if (dSeats > rSeats) ui.topCard.classList.add("leads-d");
    else if (rSeats > dSeats) ui.topCard.classList.add("leads-r");
  }

  // Colored tier numbers with incumbent (not up) seats at edges
  const dTiers = ["Safe D","Likely D","Lean D"];
  const rTiers = ["Lean R","Likely R","Safe R"];
  const rules = SEAT_RULES[mode];
  const baseD = rules?.baseD || 0;
  const baseR = rules?.baseR || 0;

  const numColor = (k) => {
    if (k === "Tossup") return "#a16207";
    if (k === "Lean D") return "#60a5fa";
    if (k === "Lean R") return "#f87171";
    return RTG_COLORS[k];
  };
  const numSpan = (k) => {
    const n = counts[k] || 0;
    return `<span class="rtgNum" style="color:${numColor(k)}">${n}</span>`;
  };
  const sep = `<span class="rtgSep">-</span>`;

  // Incumbents in near-black
  const incD = baseD > 0 ? `<span class="rtgNum" style="color:#1e293b">${baseD}</span>${sep}` : "";
  const incR = baseR > 0 ? `${sep}<span class="rtgNum" style="color:#1e293b">${baseR}</span>` : "";

  const dPart = incD + dTiers.map(numSpan).join(sep);
  const rPart = rTiers.map(numSpan).join(sep) + incR;
  const tPart = `<span class="rtgNum" style="color:#a16207">${counts["Tossup"]||0}</span>`;

  ui.countsEl.innerHTML = dPart + `<div class="divider"></div>` + tPart + `<div class="divider"></div>` + rPart;

  // Stacked bar
  ui.bar.innerHTML = RTG_ORDER.map(k => {
    const n = counts[k] || 0;
    if (!n) return "";
    const pct = (n / total * 100);
    const cls = k === "Tossup" ? "seg tossup" : "seg";
    return `<div class="${cls}" style="flex:${pct};background:${RTG_COLORS[k]}">${n > 0 && pct > 5 ? `<span>${n}</span>` : ""}</div>`;
  }).join("");

  // Labels under bar
  if (ui.labels){
    ui.labels.innerHTML = RTG_ORDER.map(k => {
      const n = counts[k] || 0;
      if (!n) return "";
      const pct = (n / total * 100);
      const shortLabel = k.replace("Likely ","Lkly ").replace("Tossup","Toss");
      const lblColor = (k === "Safe D") ? "#1e40af" : (k === "Safe R") ? "#991b1b" : (k === "Tossup") ? "#a16207" : (k === "Lean D") ? "#3b82f6" : (k === "Lean R") ? "#ef4444" : RTG_COLORS[k];
      return `<div class="rlbl" style="flex:${pct};color:${lblColor}">${pct > 6 ? shortLabel : ""}</div>`;
    }).join("");
  }

  // Totals under labels: D | Tossup | R
  if (ui.totals){
    const toss = counts["Tossup"] || 0;
    const totalD = dSeats + (rules?.baseD || 0);
    const totalR = rSeats + (rules?.baseR || 0);
    ui.totals.innerHTML =
      `<span class="rtD">D ${totalD}</span>` +
      `<span class="rtT">${toss} Tossup</span>` +
      `<span class="rtR">R ${totalR}</span>`;
  }
}

/* --- Map --- */
const RTG_MAP = {};
async function initRtgMap(modeKey){
  const ui = RTG_UI[modeKey];
  if (!ui?.mapSvg) return;

  if (modeKey === "house"){
    await initRtgHouseMap(ui, modeKey);
    return;
  }

  const geo = await loadStateGeo();
  const width = 960, height = 600;
  const svg = d3.select(ui.mapSvg);
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.selectAll("*").remove();

  const projection = d3.geoAlbersUsa();
  projection.fitExtent([[18,18],[width-18,height-18]], geo);
  const pathGen = d3.geoPath(projection);

  const gRoot = svg.append("g");
  gRoot.selectAll("path")
    .data(geo.features)
    .join("path")
    .attr("class", d => {
      const st = fipsToUsps(d.id);
      return (st && DATA[modeKey]?.ratios[st]) ? "state active" : "state";
    })
    .attr("data-st", d => fipsToUsps(d.id))
    .attr("d", d => pathGen(d))
    .attr("fill","#e5e7eb")
    .on("mouseenter", (event, d) => {
      const st = fipsToUsps(d.id);
      if (!st || !DATA[modeKey]?.ratios[st]) return;
      d3.select(event.currentTarget).classed("hovered", true);
      const info = RTG_PER_RACE[modeKey]?.[st];
      const name = USPS_TO_NAME[st] || st;
      const rating = info ? info.rating : "—";
      const color = info ? RTG_COLORS[rating] : "var(--muted)";
      showSimTip(event, `<span style="font-weight:900">${name}</span> <span style="color:${color};font-weight:800">${rating}</span>`);
    })
    .on("mousemove", (event) => {
      const el = document.getElementById("simTip");
      if (el) showSimTip(event, el.innerHTML);
    })
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hovered", false);
      hideSimTip();
    });

  RTG_MAP[modeKey] = { svg, gRoot };
}

async function initRtgHouseMap(ui, modeKey){
  const width = 960, height = 600;
  const svg = d3.select(ui.mapSvg);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const gZoom = svg.append("g");
  const gRoot = gZoom.append("g");

  if (!HOUSE_SVG_TEXT) return; // house.svg not loaded yet

  const doc = new DOMParser().parseFromString(HOUSE_SVG_TEXT, "image/svg+xml");
  const shapes = doc.getElementById("district-shapes");
  if (!shapes) return;

  const imported = document.importNode(shapes, true);
  gRoot.node().appendChild(imported);

  requestAnimationFrame(() => {
    try {
      const bbox = imported.getBBox();
      const pad = 18;
      const scale = Math.min((width-pad*2)/bbox.width, (height-pad*2)/bbox.height);
      const tx = (width - bbox.width*scale)/2 - bbox.x*scale;
      const ty = (height - bbox.height*scale)/2 - bbox.y*scale;
      gRoot.attr("transform", `translate(${tx},${ty}) scale(${scale})`);
    } catch(e){}
  });

  gRoot.selectAll("#district-shapes *").each(function(){
    const rawId = String(this.id || "").trim();
    if (!rawId) return;
    let did = rawId;
    if (!DATA.house.ratios[did]){
      const digits = rawId.replace(/\D/g,"");
      if (digits) did = digits.padStart(4,"0").slice(-4);
    }
    if (!DATA.house.ratios[did]) return;
    this.classList.add("district","active");
    this.setAttribute("data-did", did);

    // Tag with state USPS for zoom grouping
    const meta = DATA.house.meta[did];
    if (meta?.usps) this.setAttribute("data-state", meta.usps);
  });

  // Hover tooltips for districts
  gRoot.selectAll(".district.active")
    .on("mouseenter", (event) => {
      let did = event.currentTarget.getAttribute("data-did") || "";
      if (!did || !DATA.house.ratios[did]) return;
      d3.select(event.currentTarget).classed("hovered", true);
      const info = RTG_PER_RACE.house?.[did];
      const meta = DATA.house.meta[did];
      const name = meta ? houseDistrictName(meta.state, meta.cd) : did;
      const rating = info ? info.rating : "—";
      const color = info ? RTG_COLORS[rating] : "var(--muted)";
      showSimTip(event, `<span style="font-weight:900">${name}</span> <span style="color:${color};font-weight:800">${rating}</span>`);
    })
    .on("mousemove", (event) => {
      const el = document.getElementById("simTip");
      if (el) showSimTip(event, el.innerHTML);
    })
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hovered", false);
      hideSimTip();
    });

  // ── D3 Zoom ──
  const zoom = d3.zoom()
    .scaleExtent([1, 12])
    .on("zoom", (event) => {
      gZoom.attr("transform", event.transform);
    });

  svg.call(zoom);

  // Double-click resets to US
  svg.on("dblclick.zoom", null);
  svg.on("dblclick", () => {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    setActiveRtgZoomBtn("us");
  });

  RTG_MAP[modeKey] = { svg, gRoot, gZoom, zoom, width, height };

  // Click district → zoom to its state
  gRoot.selectAll(".district.active").on("click", (event) => {
    const st = event.currentTarget.getAttribute("data-state");
    if (st) zoomRtgHouseTo(st);
  });

  // ── Setup zoom controls ──
  requestAnimationFrame(() => setupRtgHouseZoomControls());
}

/* ---------- Ratings House map zoom presets ---------- */
const RTG_METRO_DISTRICTS = {
  nyc: ["NY-05","NY-06","NY-07","NY-08","NY-09","NY-10","NY-11","NY-12","NY-13","NY-14","NY-15","NY-16","NY-17","NJ-08","NJ-09","NJ-10","NJ-11"],
  la:  ["CA-25","CA-26","CA-27","CA-28","CA-29","CA-30","CA-31","CA-32","CA-33","CA-34","CA-35","CA-36","CA-37","CA-38","CA-39","CA-40","CA-43","CA-44","CA-45","CA-46","CA-47"],
  chi: ["IL-01","IL-02","IL-03","IL-04","IL-05","IL-06","IL-07","IL-08","IL-09","IL-10","IL-11"],
  dfw: ["TX-03","TX-05","TX-06","TX-12","TX-24","TX-25","TX-26","TX-30","TX-32","TX-33"],
  hou: ["TX-02","TX-07","TX-08","TX-09","TX-10","TX-18","TX-22","TX-29","TX-36","TX-38"],
  atl: ["GA-04","GA-05","GA-06","GA-07","GA-10","GA-11","GA-13"],
  dc:  ["VA-07","VA-08","VA-10","VA-11","MD-03","MD-04","MD-05","MD-06","MD-08","DC-AL"],
  phx: ["AZ-01","AZ-03","AZ-04","AZ-08","AZ-09"],
  mia: ["FL-20","FL-21","FL-22","FL-23","FL-24","FL-25","FL-26","FL-27","FL-28"],
};

function setActiveRtgZoomBtn(id){
  const root = document.querySelector('[data-ratings-mode="house"]');
  if (!root) return;
  root.querySelectorAll(".zoomBtn").forEach(b => b.classList.toggle("active", b.dataset.zoom === id));
}

function zoomRtgHouseTo(targetId){
  const m = RTG_MAP.house;
  if (!m?.zoom || !m?.svg) return;

  if (targetId === "us"){
    m.svg.transition().duration(500).call(m.zoom.transform, d3.zoomIdentity);
    setActiveRtgZoomBtn("us");
    return;
  }

  // Collect district elements to zoom to
  let districts = d3.selectAll([]); // empty

  // Metro preset — match by district code
  const metroCodes = RTG_METRO_DISTRICTS[targetId];
  if (metroCodes){
    const codeSet = new Set(metroCodes);
    const dids = [];
    for (const [did, meta] of Object.entries(DATA.house.meta || {})){
      if (meta?.code && codeSet.has(meta.code)) dids.push(did);
    }
    if (dids.length){
      const sel = dids.map(d => `.district[data-did="${d}"]`).join(",");
      districts = m.gRoot.selectAll(sel);
    }
  }

  // State zoom
  if (districts.empty()){
    const usps = targetId.toUpperCase();
    districts = m.gRoot.selectAll(`.district[data-state="${usps}"]`);
  }

  if (districts.empty()) return;

  // Compute combined bbox in gRoot space, then transform to viewBox
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  districts.each(function(){
    try {
      const bb = this.getBBox();
      if (bb.x < x0) x0 = bb.x;
      if (bb.y < y0) y0 = bb.y;
      if (bb.x + bb.width > x1) x1 = bb.x + bb.width;
      if (bb.y + bb.height > y1) y1 = bb.y + bb.height;
    } catch(e){}
  });

  if (!isFinite(x0)) return;

  // gRoot has a fit transform — apply to get viewBox coords
  const gT = m.gRoot.attr("transform") || "";
  const tm = gT.match(/translate\(([\d.\-e]+),([\d.\-e]+)\)\s*scale\(([\d.\-e]+)\)/);
  let gtx = 0, gty = 0, gs = 1;
  if (tm){ gtx = +tm[1]; gty = +tm[2]; gs = +tm[3]; }

  const vx0 = x0 * gs + gtx, vy0 = y0 * gs + gty;
  const vx1 = x1 * gs + gtx, vy1 = y1 * gs + gty;
  const bw = vx1 - vx0, bh = vy1 - vy0;
  const cx = (vx0 + vx1) / 2, cy = (vy0 + vy1) / 2;

  const pad = 1.2;
  const k = Math.min(m.width / (bw * pad), m.height / (bh * pad), 10);
  const tx = m.width / 2 - cx * k;
  const ty = m.height / 2 - cy * k;

  const t = d3.zoomIdentity.translate(tx, ty).scale(k);
  m.svg.transition().duration(500).call(m.zoom.transform, t);
  setActiveRtgZoomBtn(metroCodes ? targetId : "");
}

function setupRtgHouseZoomControls(){
  const root = document.querySelector('[data-ratings-mode="house"]');
  if (!root) return;

  // Populate state dropdown
  const select = root.querySelector("[data-rtg-zoom-select]");
  if (select){
    const states = new Set();
    for (const did of Object.keys(DATA.house.meta || {})){
      const usps = DATA.house.meta[did]?.usps;
      if (usps) states.add(usps);
    }
    const sorted = Array.from(states).sort();
    for (const usps of sorted){
      const opt = document.createElement("option");
      opt.value = usps;
      opt.textContent = USPS_TO_NAME[usps] || usps;
      select.appendChild(opt);
    }
    select.addEventListener("change", ()=>{
      if (select.value) zoomRtgHouseTo(select.value);
      select.value = "";
    });
  }

  // Preset buttons
  root.querySelectorAll(".zoomBtn[data-zoom]").forEach(btn=>{
    btn.addEventListener("click", ()=> zoomRtgHouseTo(btn.dataset.zoom));
  });

  // "More…" metro dropdown
  const metroMore = root.querySelector("[data-rtg-zoom-metro-more]");
  if (metroMore){
    metroMore.addEventListener("change", ()=>{
      if (metroMore.value) zoomRtgHouseTo(metroMore.value);
      metroMore.value = "";
    });
  }
}

function recolorRtgMap(modeKey, perRace){
  const m = RTG_MAP[modeKey];
  if (!m?.gRoot) return;

  if (modeKey === "house"){
    m.gRoot.selectAll(".district").each(function(){
      const did = this.getAttribute("data-did");
      const info = perRace[did];
      this.style.fill = info ? RTG_COLORS[info.rating] : "#e5e7eb";
    });
  } else {
    m.gRoot.selectAll("path.state").each(function(){
      const st = this.getAttribute("data-st");
      const info = perRace[st];
      this.style.fill = info ? RTG_COLORS[info.rating] : "#e5e7eb";
    });
  }
}

/* --- Chart --- */
function renderRtgChart(modeKey, chartMode){
  const ui = RTG_UI[modeKey];
  if (!ui?.chart) return;
  ui._chartMode = chartMode || ui._chartMode || "detailed";

  const series = GB_SRC?.series;
  if (!series || !series.length){ renderRtgChartSnapshot(modeKey); return; }

  // Build time series: for each GB date, compute ratings
  const timeData = [];
  for (const pt of series){
    const gb = normalizePair(pt.dem, pt.rep);
    const { counts } = computeAllRatings(modeKey, gb);
    timeData.push({ date: parseDate(pt.date), counts });
  }
  const valid = timeData.filter(d => d.date);
  if (!valid.length){ renderRtgChartSnapshot(modeKey); return; }

  const svgEl = ui.chart;
  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(200, Math.floor(rect.width || 360));
  const height = Math.max(100, Math.floor(rect.height || 180));

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const mg = {l:34, r:8, t:8, b:20};
  const iw = width - mg.l - mg.r;
  const ih = height - mg.t - mg.b;

  const x = d3.scaleTime().domain(d3.extent(valid, d=>d.date)).range([mg.l, mg.l+iw]);
  const xAxis = d3.axisBottom(x).ticks(Math.min(5, Math.floor(iw/70))).tickFormat(d3.timeFormat("%b"));

  if (ui._chartMode === "faceoff"){
    // Stacked area: D-leading vs R-leading (two colors)
    ui.ylabel.textContent = "Races leading";
    const faceData = valid.map(d => ({
      date: d.date,
      D: (d.counts["Safe D"]||0)+(d.counts["Likely D"]||0)+(d.counts["Lean D"]||0),
      R: (d.counts["Safe R"]||0)+(d.counts["Likely R"]||0)+(d.counts["Lean R"]||0),
      T: d.counts["Tossup"]||0
    }));

    const total = Object.keys(modeKey === "house" ? DATA.house.ratios : DATA[modeKey]?.ratios || {}).length;
    const y = d3.scaleLinear().domain([0, total || 50]).range([mg.t+ih, mg.t]);
    const yAxis = d3.axisLeft(y).ticks(5).tickFormat(d=>`${Math.round(d)}`);

    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${mg.t+ih})`).call(xAxis);
    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${mg.l},0)`).call(yAxis);

    const stack = d3.stack().keys(["D","T","R"]).value((d, key) => d[key] || 0);
    const stacked = stack(faceData);
    const faceColors = { D: "var(--blue)", T: "#fde047", R: "var(--red)" };

    const area = d3.area()
      .x(d => x(d.data.date))
      .y0(d => y(d[0]))
      .y1(d => y(d[1]))
      .curve(d3.curveStepAfter);

    svg.selectAll(".faceArea")
      .data(stacked)
      .join("path")
      .attr("class","faceArea")
      .attr("d", area)
      .attr("fill", (d,i) => faceColors[["D","T","R"][i]])
      .attr("opacity", 0.85);

  } else {
    // Stacked area: 7 rating categories
    ui.ylabel.textContent = "Rating counts";

    const total = Object.keys(modeKey === "house" ? DATA.house.ratios : DATA[modeKey]?.ratios || {}).length;
    const y = d3.scaleLinear().domain([0, total || 50]).range([mg.t+ih, mg.t]);
    const yAxis = d3.axisLeft(y).ticks(5).tickFormat(d=>`${Math.round(d)}`);

    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${mg.t+ih})`).call(xAxis);
    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${mg.l},0)`).call(yAxis);

    // Build stacked data
    const stack = d3.stack().keys(RTG_ORDER).value((d, key) => d.counts[key] || 0);
    const stacked = stack(valid);

    const area = d3.area()
      .x(d => x(d.data.date))
      .y0(d => y(d[0]))
      .y1(d => y(d[1]))
      .curve(d3.curveStepAfter);

    svg.selectAll(".rtgArea")
      .data(stacked)
      .join("path")
      .attr("class","rtgArea")
      .attr("d", area)
      .attr("fill", (d,i) => RTG_COLORS[RTG_ORDER[i]])
      .attr("opacity", 0.85);
  }

  // Hover overlay for both chart modes
  const bisect = d3.bisector(d=>d.date).left;
  const vline = svg.append("line").attr("y1",mg.t).attr("y2",mg.t+ih)
    .attr("stroke","var(--ink)").attr("stroke-width",1).attr("opacity",0).attr("stroke-dasharray","3 2");

  svg.append("rect").attr("x",mg.l).attr("y",mg.t).attr("width",iw).attr("height",ih)
    .style("fill","transparent").style("cursor","crosshair")
    .on("mousemove", (ev) => {
      const [mx] = d3.pointer(ev);
      const xd = x.invert(mx);
      const i = clamp(bisect(valid, xd), 1, valid.length-1);
      const a = valid[i-1], b = valid[i];
      const d = (xd - a.date) > (b.date - xd) ? b : a;

      vline.attr("x1",x(d.date)).attr("x2",x(d.date)).attr("opacity",0.4);

      let html = `<div class="stDate">${ds(d.date)}</div>`;
      if (ui._chartMode === "faceoff"){
        const dC = (d.counts["Safe D"]||0)+(d.counts["Likely D"]||0)+(d.counts["Lean D"]||0);
        const rC = (d.counts["Safe R"]||0)+(d.counts["Likely R"]||0)+(d.counts["Lean R"]||0);
        const tC = d.counts["Tossup"]||0;
        html += `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">D</span><span class="stVal">${dC}</span></div>`;
        html += `<div class="stRow"><span class="stDot" style="background:#fde047"></span><span class="stLbl">T</span><span class="stVal">${tC}</span></div>`;
        html += `<div class="stRow"><span class="stDot" style="background:var(--red)"></span><span class="stLbl">R</span><span class="stVal">${rC}</span></div>`;
      } else {
        for (const k of RTG_ORDER){
          const n = d.counts[k] || 0;
          if (!n) continue;
          html += `<div class="stRow"><span class="stDot" style="background:${RTG_COLORS[k]}"></span><span class="stLbl" style="width:auto;margin-right:4px">${k}</span><span class="stVal">${n}</span></div>`;
        }
      }
      showSimTip(ev, html);
    })
    .on("mouseleave", () => {
      vline.attr("opacity",0);
      hideSimTip();
    });
}

function renderRtgChartSnapshot(modeKey){
  // Fallback: just show current counts as a simple message
  const ui = RTG_UI[modeKey];
  if (!ui?.chart) return;
  const svg = d3.select(ui.chart);
  svg.selectAll("*").remove();
  svg.append("text").attr("x","50%").attr("y","50%").attr("text-anchor","middle")
    .attr("font-size",12).attr("fill","var(--muted)").text("No time series data available");
}

/* --- Chart tab switching --- */
function setupRtgChartTabs(mode){
  const root = document.querySelector(`[data-ratings-mode='${mode}']`);
  if (!root) return;
  const tabs = root.querySelectorAll("[data-rtg-chart-tab]");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      renderRtgChart(mode, tab.dataset.rtgChartTab);
    });
  });
}

/* --- Main init --- */
let ratingsInited = false;
async function initRatingsPage(){
  if (ratingsInited) return;
  ratingsInited = true;

  for (const mode of MODES){
    initRtgUI(mode);
    setupRtgChartTabs(mode);
    await initRtgMap(mode);

    const { counts, perRace } = computeAllRatings(mode);
    RTG_PER_RACE[mode] = perRace;
    renderRatingBar(mode, counts);
    recolorRtgMap(mode, perRace);
    renderRtgChart(mode);
  }
}

/* ========== Page Tab Switching ========== */
document.querySelector('.pageTabs').addEventListener('click', e => {
  const btn = e.target.closest('.pageTab');
  if (!btn) return;
  document.querySelectorAll('.pageTab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const page = btn.dataset.page;
  document.getElementById('triGrid').style.display = page === 'model' ? '' : 'none';
  document.getElementById('ratingsPage').style.display = page === 'ratings' ? '' : 'none';
  document.getElementById('pollsPage').style.display = page === 'polls' ? 'grid' : 'none';
  document.getElementById('swingometerPage').style.display = page === 'swingometer' ? '' : 'none';
  document.getElementById('pastElectionsPage').style.display = page === 'past-elections' ? '' : 'none';

  if (page === 'ratings') initRatingsPage();
  if (page === 'polls' && window.initPollsPage) window.initPollsPage();
  if (page === 'swingometer' && window.initSwingometerPage) window.initSwingometerPage();
  if (page === 'past-elections' && window.initPastElectionsPage) window.initPastElectionsPage();
});

// Resize handler for ratings charts
window.addEventListener("resize", () => {
  if (!ratingsInited) return;
  for (const mode of MODES){
    try{ renderRtgChart(mode); }catch(e){}
  }
}, {passive:true});

})();
