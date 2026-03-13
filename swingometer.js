/* ===== Swingometer Page =====
   Pure ratio-based "what if" tool. Users drag D/R sliders to set the
   national two-party vote share, and every state/district recomputes
   via ratios alone (no polls, no indicators, no MC). */

console.log("swingometer.js v1 loaded");

const SWING = {
  inited: false,
  modes: ["senate","governor","house"],
  ui: {},        // per-mode DOM handles
  maps: {},      // per-mode map state
  sliders: {},   // per-mode {inputD, inputR, valD, valR}
  natGB: {},     // per-mode {D, R} current slider values
};

/* ---------- Init ---------- */
async function initSwingometerPage(){
  if (SWING.inited) {
    // Just refresh on re-show
    for (const mode of SWING.modes) swingUpdate(mode);
    return;
  }
  SWING.inited = true;

  for (const mode of SWING.modes){
    const root = document.querySelector(`#swingometerPage .modeCol[data-swing-mode='${mode}']`);
    if (!root) continue;

    SWING.ui[mode] = {
      root,
      topCard: root.querySelector(".topCard"),
      pillD: root.querySelector("[data-swing-pill-d]"),
      pillR: root.querySelector("[data-swing-pill-r]"),
      seatsD: root.querySelector("[data-swing-seats-d]"),
      seatsR: root.querySelector("[data-swing-seats-r]"),
      simCanvas: root.querySelector("[data-swing-sim]"),
      svgEl: root.querySelector("svg.mapSvg"),
      inputD: root.querySelector("[data-swing-slider-d]"),
      inputR: root.querySelector("[data-swing-slider-r]"),
      valD: root.querySelector("[data-swing-val-d]"),
      valR: root.querySelector("[data-swing-val-r]"),
      marginLabel: root.querySelector("[data-swing-margin]"),
    };

    // Set initial slider values from current model GB
    const gb = DATA[mode]?.gb || {D:50, R:50};
    const ui = SWING.ui[mode];
    SWING.natGB[mode] = { D: gb.D, R: gb.R };

    if (ui.inputD){
      ui.inputD.value = gb.D.toFixed(1);
      ui.inputD.addEventListener("input", () => onSwingSlider(mode, "D"));
    }
    if (ui.inputR){
      ui.inputR.value = gb.R.toFixed(1);
      ui.inputR.addEventListener("input", () => onSwingSlider(mode, "R"));
    }

    // Init map — MUST await so districts are tagged before swingUpdate
    await initSwingMap(mode);

    // Initial computation
    swingUpdate(mode);
  }

  // Resize handler
  window.addEventListener("resize", () => {
    for (const mode of SWING.modes){
      const ui = SWING.ui[mode];
      if (ui?.simCanvas && ui._lastHist){
        drawSeatSimMini(ui.simCanvas, ui._lastHist, ui._lastMaj);
      }
    }
  }, {passive:true});
}

/* ---------- Slider handler ---------- */
function onSwingSlider(mode, party){
  const ui = SWING.ui[mode];
  if (!ui) return;

  const rawD = parseFloat(ui.inputD?.value || "50");
  const rawR = parseFloat(ui.inputR?.value || "50");

  // Normalize to 100
  const pair = normalizePair(rawD, rawR);
  SWING.natGB[mode] = pair;

  swingUpdate(mode);
}

/* ---------- Recompute everything for a mode ---------- */
function swingUpdate(mode){
  const ui = SWING.ui[mode];
  if (!ui) return;

  const gb = SWING.natGB[mode] || {D:50, R:50};

  // Update display values
  if (ui.valD) ui.valD.textContent = gb.D.toFixed(1);
  if (ui.valR) ui.valR.textContent = gb.R.toFixed(1);

  // Margin label
  const m = gb.R - gb.D;
  if (ui.marginLabel){
    ui.marginLabel.textContent = fmtLead(m);
    ui.marginLabel.style.color = m < 0 ? "var(--blue)" : m > 0 ? "var(--red)" : "var(--ink)";
  }

  // Top card pills
  if (ui.pillD) ui.pillD.textContent = gb.D.toFixed(1);
  if (ui.pillR) ui.pillR.textContent = gb.R.toFixed(1);
  if (ui.topCard){
    ui.topCard.classList.toggle("leads-d", gb.D > gb.R);
    ui.topCard.classList.toggle("leads-r", gb.R > gb.D);
  }

  // Compute seat tallies
  const tally = swingComputeSeats(mode, gb);
  if (ui.seatsD) ui.seatsD.textContent = String(tally.totalD);
  if (ui.seatsR) ui.seatsR.textContent = String(tally.totalR);

  // Histogram from tally distribution
  if (ui.simCanvas && tally.margins){
    const rules = SEAT_RULES[mode];
    const thr = (mode === "senate") ? SENATE_CONTROL_RULE.demAtLeast
              : (mode === "governor") ? 26
              : rules.majorityLine;
    const hist = swingBuildHistogram(mode, gb, tally);
    ui._lastHist = hist;
    ui._lastMaj = thr;
    drawSeatSimMini(ui.simCanvas, hist, thr);
    const total = hist.isProb ? 1 : ((hist.counts || []).reduce((a,b)=>a+b,0) || 1);
    ui.simCanvas._simMeta = { hist, threshold: thr, total };
    ensureSimHover(ui.simCanvas);
  }

  // Recolor map
  swingRecolorMap(mode, gb);
}

/* ---------- Seat computation (pure ratio-based, no polls/indicators) ---------- */
function swingComputeSeats(mode, gb){
  const rules = SEAT_RULES[mode];
  const ratios = DATA[mode]?.ratios || {};

  let winsD = 0, winsR = 0;
  const margins = [];

  for (const key of Object.keys(ratios)){
    const ratio = ratios[key];
    const pair = normalizePair(gb.D * ratio.D, gb.R * ratio.R);
    const m = pair.R - pair.D; // positive = R lead
    margins.push(m);

    if (m < -1e-9) winsD++;
    else if (m > 1e-9) winsR++;
    else winsD++; // ties go D
  }

  const totalD = rules.baseD + winsD;
  const totalR = rules.baseR + winsR;

  return { ...rules, winsD, winsR, totalD, totalR, margins };
}

/* ---------- Histogram (simplified — shows deterministic seat distribution with σ noise) ---------- */
function swingBuildHistogram(mode, gb, tally){
  // Run a lightweight MC: for each seat, P(D win) from margin, sample 2000 outcomes
  const rules = SEAT_RULES[mode];
  const ratios = DATA[mode]?.ratios || {};
  const keys = Object.keys(ratios);

  const pDems = [];
  for (const key of keys){
    const ratio = ratios[key];
    const pair = normalizePair(gb.D * ratio.D, gb.R * ratio.R);
    const m = pair.R - pair.D;
    pDems.push(winProbD_fast(m));
  }

  // Missing seats get 50/50
  const upSeats = rules.total - rules.baseD - rules.baseR;
  const missing = Math.max(0, upSeats - keys.length);
  for (let i = 0; i < missing; i++) pDems.push(0.5);

  // Poisson-binomial distribution
  const dist = poissonBinomialDist(pDems);

  // Display window
  const base = rules.baseD;
  const mean = base + pDems.reduce((s,p)=>s+p, 0);
  const halfW = Math.max(8, Math.ceil(Math.sqrt(pDems.length) * 1.5));
  const showMin = Math.max(0, Math.floor(mean - halfW));
  const showMax = Math.min(rules.total, Math.ceil(mean + halfW));

  return histogramFromProbDistRange(dist, base, showMin, showMax);
}

/* ---------- Map init + recolor ---------- */
async function initSwingMap(mode){
  const ui = SWING.ui[mode];
  if (!ui?.svgEl) return;

  if (mode === "house") return initSwingHouseMap(ui);

  const geo = await loadStateGeo();
  const features = geo.features;

  const width = 960, height = 600;
  const svg = d3.select(ui.svgEl);
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const projection = d3.geoAlbersUsa();
  projection.fitExtent([[18, 18], [width - 18, height - 18]], geo);
  const pathGen = d3.geoPath(projection);

  svg.selectAll("*").remove();
  const gRoot = svg.append("g");

  gRoot.selectAll("path")
    .data(features)
    .join("path")
    .attr("class", d => {
      const st = fipsToUsps(d.id);
      const active = st && DATA[mode]?.ratios[st];
      return active ? "state active" : "state";
    })
    .attr("data-st", d => fipsToUsps(d.id))
    .attr("d", d => pathGen(d))
    .attr("fill", "#e5e7eb")
    .on("mouseenter", (event, d) => {
      const st = fipsToUsps(d.id);
      if (!st || !DATA[mode]?.ratios[st]) return;
      d3.select(event.currentTarget).classed("hovered", true);
      showSwingTooltip(event, mode, st);
    })
    .on("mousemove", (event, d) => {
      const st = fipsToUsps(d.id);
      if (!st || !DATA[mode]?.ratios[st]) return;
      positionTooltip(event);
    })
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hovered", false);
      hideTooltip();
    });

  SWING.maps[mode] = { svg, gRoot, projection, pathGen };
}

async function initSwingHouseMap(ui){
  const width = 960, height = 600;
  const svg = d3.select(ui.svgEl);

  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const gZoom = svg.append("g").attr("class","houseZoomG");
  const gRoot = gZoom.append("g");

  // Reuse cached SVG text from forecast.js, or load it
  if (!HOUSE_SVG_TEXT){
    try {
      HOUSE_SVG_TEXT = await fetch("svg/house.svg", {cache:"no-store"}).then(r=>{
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
    } catch(e){
      console.warn("Swingometer: svg/house.svg not loaded:", e);
      svg.append("text")
        .attr("x", 480).attr("y", 300)
        .attr("text-anchor","middle")
        .attr("fill","var(--muted)")
        .attr("font-size","14px")
        .text("House map requires svg/house.svg");
      return;
    }
  }

  const doc = new DOMParser().parseFromString(HOUSE_SVG_TEXT, "image/svg+xml");
  const shapes = doc.getElementById("district-shapes");
  if (!shapes){
    console.warn("Swingometer: svg/house.svg missing #district-shapes");
    return;
  }

  const imported = document.importNode(shapes, true);
  // Rename ID to avoid collision with model page's #district-shapes
  imported.id = "swing-district-shapes";
  gRoot.node().appendChild(imported);

  // Fit imported SVG group to viewBox
  requestAnimationFrame(() => {
    try {
      const bbox = imported.getBBox();
      const pad = 18;
      const scale = Math.min((width - pad*2) / bbox.width, (height - pad*2) / bbox.height);
      const tx = (width - bbox.width * scale) / 2 - bbox.x * scale;
      const ty = (height - bbox.height * scale) / 2 - bbox.y * scale;
      gRoot.attr("transform", `translate(${tx},${ty}) scale(${scale})`);
    } catch (e) { /* ignore */ }
  });

  // Tag district paths with data-did — select via imported node directly (avoids duplicate-ID issue)
  d3.select(imported).selectAll("*").each(function(){
    const rawId = String(this.id || "").trim();
    if (!rawId) return;

    let did = rawId;
    if (!DATA.house.ratios[did]){
      const digits = rawId.replace(/\D/g, "");
      if (digits) did = digits.padStart(4,"0").slice(-4);
    }
    if (!DATA.house.ratios[did]) return;

    this.classList.add("district","active");
    this.setAttribute("data-did", did);

    const meta = DATA.house.meta[did];
    if (meta?.usps) this.setAttribute("data-state", meta.usps);
    try{ this.style.fill = ""; }catch(e){}
  });

  // Hover tooltips — use swingometer-specific tooltip
  gRoot.selectAll(".district.active")
    .on("mouseenter", (event) => {
      let did = event.currentTarget.getAttribute("data-did") || event.currentTarget.id || "";
      if (did && !DATA.house.ratios[did]){
        const digits = String(did).replace(/\D/g, "");
        if (digits) did = digits.padStart(4,"0").slice(-4);
      }
      if (!did || !DATA.house.ratios[did]) return;
      d3.select(event.currentTarget).classed("hovered", true);
      showSwingHouseTooltip(event, did);
    })
    .on("mousemove", (event) => {
      let did = event.currentTarget.getAttribute("data-did") || event.currentTarget.id || "";
      if (did && !DATA.house.ratios[did]){
        const digits = String(did).replace(/\D/g, "");
        if (digits) did = digits.padStart(4,"0").slice(-4);
      }
      if (!did || !DATA.house.ratios[did]) return;
      positionTooltip(event);
    })
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hovered", false);
      hideTooltip();
    });

  // D3 zoom (pan + scroll)
  const zoom = d3.zoom()
    .scaleExtent([1, 12])
    .on("zoom", (event) => {
      gZoom.attr("transform", event.transform);
    });
  svg.call(zoom);
  svg.on("dblclick.zoom", null);
  svg.on("dblclick", () => {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
  });

  SWING.maps["house"] = { kind: "house", svg, gRoot, gZoom, zoom, width, height };
}

function swingRecolorMap(mode, gb){
  const m = SWING.maps[mode];
  if (!m) return;

  if (mode === "house"){
    swingRecolorHouseMap(gb);
    return;
  }

  const ratios = DATA[mode]?.ratios || {};
  m.gRoot.selectAll(".state.active").each(function(){
    const el = d3.select(this);
    const st = el.attr("data-st");
    const ratio = ratios[st];
    if (!ratio) return;
    const pair = normalizePair(gb.D * ratio.D, gb.R * ratio.R);
    const margin = pair.R - pair.D;
    el.attr("fill", interpColor(margin));
  });
}

function swingRecolorHouseMap(gb){
  const m = SWING.maps["house"];
  if (!m?.gRoot) return;

  const ratios = DATA.house.ratios || {};

  m.gRoot.selectAll(".district").each(function(){
    const did = this.getAttribute("data-did");
    const ratio = ratios[did];

    if (!ratio){
      this.style.fill = "#e5e7eb";
      return;
    }

    const pair = normalizePair(gb.D * ratio.D, gb.R * ratio.R);
    const margin = pair.R - pair.D;
    this.style.fill = interpColor(margin);
  });
}

/* ---------- Swing tooltip (simplified — just ratio-based) ---------- */
function showSwingTooltip(evt, mode, st){
  const gb = SWING.natGB[mode] || {D:50, R:50};
  const ratio = DATA[mode]?.ratios[st];
  if (!ratio) return;

  const pair = normalizePair(gb.D * ratio.D, gb.R * ratio.R);
  const m = pair.R - pair.D;
  const wp = winProbFromMargin(m);

  const name = USPS_TO_NAME[st] || st;
  const pD = Math.round(wp.pD * 100);
  const pR = Math.round(wp.pR * 100);

  tipState.textContent = `${name} (${st})`;
  tipMeta.textContent = `D ${pair.D.toFixed(1)} · R ${pair.R.toFixed(1)}`;

  const resDot = tipResultBadge.querySelector(".dot");
  resDot.classList.toggle("blue", m <= 0);
  resDot.classList.toggle("red",  m > 0);
  tipWinner.textContent = fmtLead(m);
  tipProb.textContent = `D ${pD}% · R ${pR}%`;

  const probDot = tipProbBadge.querySelector(".dot");
  if (pD > pR){ probDot.classList.add("blue"); probDot.classList.remove("red"); }
  else if (pR > pD){ probDot.classList.add("red"); probDot.classList.remove("blue"); }
  else { probDot.classList.remove("blue"); probDot.classList.remove("red"); }

  tip.classList.toggle("compact", true);

  // Build mini meter body
  const rows = [];
  rows.push(miniMeterHTML("Ratio → margin", m));
  tipSliders.innerHTML = rows.join("");

  tip.style.transform = "translate(0,0)";
  positionTooltip(evt);
}

/* ---------- Swing tooltip for house districts ---------- */
function showSwingHouseTooltip(evt, did){
  const gb = SWING.natGB["house"] || {D:50, R:50};
  const ratio = DATA.house.ratios[did];
  if (!ratio) return;

  const pair = normalizePair(gb.D * ratio.D, gb.R * ratio.R);
  const m = pair.R - pair.D;
  const wp = winProbFromMargin(m);

  const meta = DATA.house.meta[did] || {};
  const code = meta.code || did;
  const pD = Math.round(wp.pD * 100);
  const pR = Math.round(wp.pR * 100);

  tipState.textContent = code;
  tipMeta.textContent = meta.name ? `${meta.name} · D ${pair.D.toFixed(1)} · R ${pair.R.toFixed(1)}` : `D ${pair.D.toFixed(1)} · R ${pair.R.toFixed(1)}`;

  const resDot = tipResultBadge.querySelector(".dot");
  resDot.classList.toggle("blue", m <= 0);
  resDot.classList.toggle("red",  m > 0);
  tipWinner.textContent = fmtLead(m);
  tipProb.textContent = `D ${pD}% · R ${pR}%`;

  const probDot = tipProbBadge.querySelector(".dot");
  if (pD > pR){ probDot.classList.add("blue"); probDot.classList.remove("red"); }
  else if (pR > pD){ probDot.classList.add("red"); probDot.classList.remove("blue"); }
  else { probDot.classList.remove("blue"); probDot.classList.remove("red"); }

  tip.classList.toggle("compact", true);
  tipSliders.innerHTML = miniMeterHTML("Ratio → margin", m);

  tip.style.transform = "translate(0,0)";
  positionTooltip(evt);
}

/* ---------- Make init function globally accessible ---------- */
window.initSwingometerPage = initSwingometerPage;
