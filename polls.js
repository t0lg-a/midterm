/* ========== Polls Page Module ========== */
(function(){

let pollsInited = false;
const POLLS_UI = {};
const POLLS_MAP = {};
const POLLS_STATE = { senate: null, governor: null }; // currently selected state per mode

/* ---------- Init ---------- */
function initPollsPage(){
  if (pollsInited) return;
  pollsInited = true;

  initPollsUI("gb");
  initPollsUI("senate");
  initPollsUI("governor");

  renderGBColumn();
  initPollsModeColumn("senate");
  initPollsModeColumn("governor");
}

function initPollsUI(mode){
  const root = document.querySelector(`[data-polls-mode='${mode}']`);
  if (!root) return;
  POLLS_UI[mode] = {
    root,
    topCard: root.querySelector(".topCard"),
    dPill: root.querySelector("[data-polls-d]"),
    rPill: root.querySelector("[data-polls-r]"),
    dBig: root.querySelector("[data-polls-d-big]"),
    rBig: root.querySelector("[data-polls-r-big]"),
    histCanvas: root.querySelector("[data-polls-hist]"),
    chart: root.querySelector("[data-polls-chart]"),
    chartTitle: root.querySelector("[data-polls-chart-title]"),
    ylabel: root.querySelector("[data-polls-ylabel]"),
    mapSvg: root.querySelector("[data-polls-map]"),
    stateChart: root.querySelector("[data-polls-state-chart]"),
    stateChartTitle: root.querySelector("[data-polls-state-chart-title]"),
    stateChartWrap: root.querySelector("[data-polls-state-wrap]"),
    pollList: root.querySelector("[data-polls-list]"),
  };
}

/* ========== Generic Ballot Column ========== */
function renderGBColumn(){
  const ui = POLLS_UI.gb;
  if (!ui) return;

  const latest = GB_SRC.latest;
  if (!latest) return;

  const pair = normalizePair(latest.dem, latest.rep);
  const dPct = Math.round(pair.D);
  const rPct = Math.round(pair.R);

  if (ui.dPill) ui.dPill.textContent = pair.D.toFixed(1);
  if (ui.rPill) ui.rPill.textContent = pair.R.toFixed(1);
  if (ui.dBig) ui.dBig.textContent = dPct;
  if (ui.rBig) ui.rBig.textContent = rPct;

  // Color top card border
  if (ui.topCard){
    ui.topCard.classList.remove("leads-d","leads-r");
    if (pair.D > pair.R) ui.topCard.classList.add("leads-d");
    else if (pair.R > pair.D) ui.topCard.classList.add("leads-r");
  }

  // Histogram of individual poll margins
  renderGBHistogram(ui);

  // Scatter plot with moving average
  renderGBScatter(ui);

  // Poll list table
  renderGBPollList(ui);
}

function renderGBHistogram(ui){
  const canvas = ui.histCanvas;
  if (!canvas) return;

  const raw = (GB_SRC.raw || []).filter(p => p && p.date && isFinite(p.dem) && isFinite(p.rep));
  const strict = !!GB_SRC.filterStrict;
  const polls = raw.filter(p => isAllowedPollster(p.pollster, strict));

  // Compute margins (D - R) for each poll
  const margins = polls.map(p => {
    const n = normalizePair(p.dem, p.rep);
    return n.D - n.R; // positive = D lead
  });

  // Bin from -15 to +15 in 1-point bins
  const binMin = -15, binMax = 15;
  const bins = binMax - binMin + 1;
  const counts = new Array(bins).fill(0);
  for (const m of margins){
    const idx = Math.round(m) - binMin;
    if (idx >= 0 && idx < bins) counts[idx]++;
  }

  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 26;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  const maxC = Math.max(...counts) || 1;
  const barW = cssW / bins;
  const cs = getComputedStyle(document.documentElement);
  const blue = cs.getPropertyValue("--blue").trim() || "#2563eb";
  const red  = cs.getPropertyValue("--red").trim()  || "#dc2626";
  const yellow = "#fde047";

  for (let i = 0; i < bins; i++){
    const val = binMin + i;
    const h = (counts[i] / maxC) * (cssH - 2);
    const x = i * barW;
    if (val > 0) ctx.fillStyle = blue;
    else if (val < 0) ctx.fillStyle = red;
    else ctx.fillStyle = yellow;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x + 0.5, cssH - h, barW - 1, h);
  }
  ctx.globalAlpha = 1;
}

function renderGBScatter(ui){
  const svgEl = ui.chart;
  if (!svgEl) return;

  const raw = (GB_SRC.raw || []).filter(p => p && p.date && isFinite(p.dem) && isFinite(p.rep));
  const strict = !!GB_SRC.filterStrict;
  const polls = raw.filter(p => isAllowedPollster(p.pollster, strict))
    .map(p => ({ date: p.date, dem: p.dem, rep: p.rep, pollster: p.pollster }))
    .sort((a,b) => a.date - b.date);

  const series = GB_SRC.series || [];

  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 400));
  const height = Math.max(200, Math.floor(rect.height || 240));

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const m = { l:38, r:10, t:10, b:26 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;

  if (!polls.length) return;

  // Compute normalized percentages
  const pollPts = polls.map(p => {
    const n = normalizePair(p.dem, p.rep);
    return { date: p.date, D: n.D, R: n.R, pollster: p.pollster };
  });

  // Moving average line data
  const avgPts = series.map(s => {
    const dt = parseDate(s.date);
    const n = normalizePair(s.dem, s.rep);
    return { date: dt, D: n.D, R: n.R };
  }).filter(d => d.date);

  const allDates = pollPts.map(d => d.date).concat(avgPts.map(d => d.date));
  const xExt = d3.extent(allDates);

  const x = d3.scaleTime().domain(xExt).range([m.l, m.l + iw]);
  const y = d3.scaleLinear().domain([40, 60]).range([m.t + ih, m.t]).nice();

  // Axes
  svg.append("g").attr("class","oddsAxis")
    .attr("transform",`translate(0,${m.t+ih})`)
    .call(d3.axisBottom(x).ticks(Math.min(6, Math.floor(iw/100))).tickFormat(d3.timeFormat("%b")));
  svg.append("g").attr("class","oddsAxis")
    .attr("transform",`translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}%`));

  // 50% line
  svg.append("line")
    .attr("x1", m.l).attr("x2", m.l + iw)
    .attr("y1", y(50)).attr("y2", y(50))
    .attr("class","seatMajLine");

  // Dots
  const cs = getComputedStyle(document.documentElement);
  const blue = cs.getPropertyValue("--blue").trim() || "#2563eb";
  const red  = cs.getPropertyValue("--red").trim()  || "#dc2626";

  svg.selectAll(".dotD")
    .data(pollPts)
    .join("circle")
    .attr("cx", d => x(d.date))
    .attr("cy", d => y(d.D))
    .attr("r", 2.5)
    .attr("fill", blue)
    .attr("opacity", 0.3);

  svg.selectAll(".dotR")
    .data(pollPts)
    .join("circle")
    .attr("cx", d => x(d.date))
    .attr("cy", d => y(d.R))
    .attr("r", 2.5)
    .attr("fill", red)
    .attr("opacity", 0.3);

  // Moving average lines
  if (avgPts.length > 1){
    const lineD = d3.line().x(d => x(d.date)).y(d => y(d.D)).curve(d3.curveMonotoneX);
    const lineR = d3.line().x(d => x(d.date)).y(d => y(d.R)).curve(d3.curveMonotoneX);

    svg.append("path").datum(avgPts).attr("d", lineD)
      .attr("fill","none").attr("stroke", blue).attr("stroke-width", 2.5)
      .attr("stroke-linejoin","round").attr("stroke-linecap","round");

    svg.append("path").datum(avgPts).attr("d", lineR)
      .attr("fill","none").attr("stroke", red).attr("stroke-width", 2.5)
      .attr("stroke-linejoin","round").attr("stroke-linecap","round");
  }

  // Hover overlay
  const dot = svg.append("circle").attr("r",4).attr("fill",blue).style("opacity",0);
  const bisect = d3.bisector(d => d.date).left;

  svg.append("rect")
    .attr("x", m.l).attr("y", m.t).attr("width", iw).attr("height", ih)
    .style("fill","transparent").style("cursor","crosshair")
    .on("mousemove", (ev) => {
      if (!avgPts.length) return;
      const [mx] = d3.pointer(ev);
      const xd = x.invert(mx);
      const i = clamp(bisect(avgPts, xd), 1, avgPts.length - 1);
      const a = avgPts[i-1], b = avgPts[i];
      const d = (xd - a.date) > (b.date - xd) ? b : a;
      dot.attr("cx", x(d.date)).attr("cy", y(d.D)).style("opacity", 1);
      showSimTip(ev,
        `<div class="stDate">${ds(d.date)}</div>` +
        `<div class="stRow"><span class="stDot" style="background:${blue}"></span><span class="stLbl">D</span><span class="stVal">${d.D.toFixed(1)}%</span></div>` +
        `<div class="stRow"><span class="stDot" style="background:${red}"></span><span class="stLbl">R</span><span class="stVal">${d.R.toFixed(1)}%</span></div>`
      );
    })
    .on("mouseleave", () => { dot.style("opacity",0); hideSimTip(); });
}

function renderGBPollList(ui){
  const el = ui.pollList;
  if (!el) return;

  const raw = (GB_SRC.raw || []).filter(p => p && p.date && isFinite(p.dem) && isFinite(p.rep));
  const strict = !!GB_SRC.filterStrict;
  const polls = raw.filter(p => isAllowedPollster(p.pollster, strict))
    .sort((a,b) => b.date - a.date);

  if (!polls.length){
    el.innerHTML = `<div style="padding:16px;color:var(--muted);font-size:12px;">No polls available</div>`;
    return;
  }

  const blue = "var(--blue)";
  const red  = "var(--red)";

  let html = `<table class="pollTable"><thead><tr>
    <th>Date</th><th>Pollster</th><th style="color:${blue}">D</th><th style="color:${red}">R</th><th>Margin</th>
  </tr></thead><tbody>`;

  for (const p of polls.slice(0, 100)){
    const n = normalizePair(p.dem, p.rep);
    const margin = n.D - n.R;
    const mStr = Math.abs(margin) < 0.05 ? "Tied" :
      (margin > 0 ? `D+${margin.toFixed(1)}` : `R+${Math.abs(margin).toFixed(1)}`);
    const mColor = margin > 0 ? blue : (margin < 0 ? red : "var(--muted)");
    const dateStr = ds(p.date);
    const pollster = String(p.pollster || "Unknown").slice(0, 28);

    html += `<tr>
      <td>${dateStr}</td>
      <td class="pollTd">${pollster}</td>
      <td style="color:${blue}">${n.D.toFixed(1)}</td>
      <td style="color:${red}">${n.R.toFixed(1)}</td>
      <td style="color:${mColor};font-weight:700">${mStr}</td>
    </tr>`;
  }

  html += `</tbody></table>`;
  el.innerHTML = html;
}


/* ========== Senate / Governor Columns ========== */
async function initPollsModeColumn(modeKey){
  const ui = POLLS_UI[modeKey];
  if (!ui) return;

  // Seat counts
  const tally = computeSeatTally(modeKey, IND_CACHE[modeKey]);
  if (ui.dBig) ui.dBig.textContent = tally.totalD;
  if (ui.rBig) ui.rBig.textContent = tally.totalR;

  // Color top card
  if (ui.topCard){
    ui.topCard.classList.remove("leads-d","leads-r");
    if (tally.totalD > tally.totalR) ui.topCard.classList.add("leads-d");
    else if (tally.totalR > tally.totalD) ui.topCard.classList.add("leads-r");
  }

  // Seat histogram
  renderPollsHist(modeKey);

  // Map
  await initPollsMap(modeKey);
  recolorPollsMap(modeKey);

  // Default: show "click a state" message
  if (ui.stateChartTitle) ui.stateChartTitle.textContent = "Click a state to see polls";
}

function renderPollsHist(modeKey){
  const ui = POLLS_UI[modeKey];
  const canvas = ui?.histCanvas;
  if (!canvas) return;

  // Get the same histogram data as the model page
  const cachedIndNat = IND_CACHE[modeKey];
  const rules = SEAT_RULES[modeKey];
  const ratios = DATA[modeKey]?.ratios;
  if (!ratios || !rules) return;

  const pDem = [];
  for (const key of Object.keys(ratios)){
    const model = getStateModel(modeKey, key, cachedIndNat);
    pDem.push(model ? model.winProb.pD : 0.5);
  }

  // Poisson-binomial distribution
  const dist = poissonBinomialDist(pDem);
  const baseD = rules.baseD;

  // Draw as histogram
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 26;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  const n = dist.length;
  if (!n) return;
  const maxP = Math.max(...dist) || 1;
  const barW = cssW / n;

  const cs = getComputedStyle(document.documentElement);
  const blue = cs.getPropertyValue("--blue").trim() || "#2563eb";
  const red  = cs.getPropertyValue("--red").trim()  || "#dc2626";
  const majLine = rules.majorityLine;

  for (let i = 0; i < n; i++){
    const seats = baseD + i;
    const h = (dist[i] / maxP) * (cssH - 2);
    const x = i * barW;
    ctx.fillStyle = seats >= majLine ? blue : red;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(x + 0.5, cssH - h, barW - 1, h);
  }
  ctx.globalAlpha = 1;
}


/* --- Polls Page Maps --- */
async function initPollsMap(modeKey){
  const ui = POLLS_UI[modeKey];
  if (!ui?.mapSvg) return;

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
    .style("cursor", d => {
      const st = fipsToUsps(d.id);
      return (st && DATA[modeKey]?.ratios[st]) ? "pointer" : "default";
    })
    .on("mouseenter", (event, d) => {
      const st = fipsToUsps(d.id);
      if (!st || !DATA[modeKey]?.ratios[st]) return;
      d3.select(event.currentTarget).classed("hovered", true);
      const model = getStateModel(modeKey, st, IND_CACHE[modeKey]);
      const margin = model ? marginRD(model.combinedPair) : NaN;
      const name = USPS_TO_NAME[st] || st;
      const polls = STATE_POLL_SRC.byModeState?.[modeKey]?.[st];
      const pollCount = polls ? polls.length : 0;
      showSimTip(event,
        `<span style="font-weight:900">${name}</span> ` +
        `<span style="font-weight:700">${fmtLead(margin)}</span>` +
        `<span style="color:var(--muted);font-size:10px;margin-left:4px">${pollCount} poll${pollCount !== 1 ? "s" : ""}</span>`
      );
    })
    .on("mousemove", (event) => {
      const el = document.getElementById("simTip");
      if (el) showSimTip(event, el.innerHTML);
    })
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hovered", false);
      hideSimTip();
    })
    .on("click", (event, d) => {
      const st = fipsToUsps(d.id);
      if (!st || !DATA[modeKey]?.ratios[st]) return;
      selectPollsState(modeKey, st);
    });

  POLLS_MAP[modeKey] = { svg, gRoot };
}

function recolorPollsMap(modeKey){
  const m = POLLS_MAP[modeKey];
  if (!m?.gRoot) return;

  const cachedIndNat = IND_CACHE[modeKey];
  m.gRoot.selectAll("path.state").each(function(){
    const st = this.getAttribute("data-st");
    if (!st || !DATA[modeKey]?.ratios[st]){ this.style.fill = "#e5e7eb"; return; }
    const model = getStateModel(modeKey, st, cachedIndNat);
    if (!model){ this.style.fill = "#e5e7eb"; return; }
    const margin = marginRD(model.combinedPair);
    this.style.fill = interpColor(margin);
  });
}


/* --- State Selection & Chart --- */
function selectPollsState(modeKey, usps){
  POLLS_STATE[modeKey] = usps;
  const ui = POLLS_UI[modeKey];
  if (!ui) return;

  // Highlight on map
  const m = POLLS_MAP[modeKey];
  if (m?.gRoot){
    m.gRoot.selectAll("path.state")
      .attr("stroke", function(){
        return this.getAttribute("data-st") === usps ? "var(--ink)" : "white";
      })
      .attr("stroke-width", function(){
        return this.getAttribute("data-st") === usps ? 2.5 : 1;
      });
  }

  // Show chart
  if (ui.stateChartWrap) ui.stateChartWrap.style.display = "";
  const name = USPS_TO_NAME[usps] || usps;
  const modeLabel = modeKey === "senate" ? "Senate" : "Governor";
  if (ui.stateChartTitle) ui.stateChartTitle.textContent = `${name} — ${modeLabel} polls`;

  renderStatePollScatter(modeKey, usps);
}

function renderStatePollScatter(modeKey, usps){
  const ui = POLLS_UI[modeKey];
  const svgEl = ui?.stateChart;
  if (!svgEl) return;

  const polls = STATE_POLL_SRC.byModeState?.[modeKey]?.[usps] || [];

  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 400));
  const height = Math.max(180, Math.floor(rect.height || 220));

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const mg = { l:38, r:10, t:10, b:26 };
  const iw = width - mg.l - mg.r;
  const ih = height - mg.t - mg.b;

  if (!polls.length){
    svg.append("text")
      .attr("x", width/2).attr("y", height/2)
      .attr("text-anchor","middle")
      .attr("fill","var(--muted)")
      .attr("font-size","12px")
      .attr("font-weight","600")
      .text("No polls for this state");
    return;
  }

  // Normalize polls
  const pts = polls.map(p => {
    const n = normalizePair(p.D, p.R);
    return { date: p.date, D: n.D, R: n.R };
  });

  // Filter to last 120 days if many polls
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 120);
  const filtered = pts.length > 3 ? pts.filter(p => p.date >= cutoff) : pts;
  const data = filtered.length >= 2 ? filtered : pts;

  const xExt = d3.extent(data, d => d.date);
  const allVals = data.flatMap(d => [d.D, d.R]);
  const yMin = Math.max(0, d3.min(allVals) - 3);
  const yMax = Math.min(100, d3.max(allVals) + 3);

  const x = d3.scaleTime().domain(xExt).range([mg.l, mg.l + iw]);
  const y = d3.scaleLinear().domain([yMin, yMax]).range([mg.t + ih, mg.t]).nice();

  svg.append("g").attr("class","oddsAxis")
    .attr("transform",`translate(0,${mg.t+ih})`)
    .call(d3.axisBottom(x).ticks(Math.min(6, Math.floor(iw/90))).tickFormat(d3.timeFormat("%b %d")));
  svg.append("g").attr("class","oddsAxis")
    .attr("transform",`translate(${mg.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}%`));

  // 50% line
  if (y.domain()[0] <= 50 && y.domain()[1] >= 50){
    svg.append("line")
      .attr("x1", mg.l).attr("x2", mg.l + iw)
      .attr("y1", y(50)).attr("y2", y(50))
      .attr("class","seatMajLine");
  }

  const cs = getComputedStyle(document.documentElement);
  const blue = cs.getPropertyValue("--blue").trim() || "#2563eb";
  const red  = cs.getPropertyValue("--red").trim()  || "#dc2626";

  // Dots
  svg.selectAll(".dotD")
    .data(data).join("circle")
    .attr("cx", d => x(d.date)).attr("cy", d => y(d.D))
    .attr("r", 3.5).attr("fill", blue).attr("opacity", 0.4);

  svg.selectAll(".dotR")
    .data(data).join("circle")
    .attr("cx", d => x(d.date)).attr("cy", d => y(d.R))
    .attr("r", 3.5).attr("fill", red).attr("opacity", 0.4);

  // Moving average (rolling window)
  if (data.length >= 3){
    const win = Math.min(6, data.length);
    const avgD = [], avgR = [];
    for (let i = 0; i < data.length; i++){
      const lo = Math.max(0, i - win + 1);
      let sD = 0, sR = 0;
      for (let j = lo; j <= i; j++){ sD += data[j].D; sR += data[j].R; }
      const cnt = i - lo + 1;
      avgD.push({ date: data[i].date, val: sD/cnt });
      avgR.push({ date: data[i].date, val: sR/cnt });
    }

    const lineGen = d3.line().x(d => x(d.date)).y(d => y(d.val)).curve(d3.curveMonotoneX);

    svg.append("path").datum(avgD).attr("d", lineGen)
      .attr("fill","none").attr("stroke", blue).attr("stroke-width", 2.5)
      .attr("stroke-linejoin","round").attr("stroke-linecap","round");

    svg.append("path").datum(avgR).attr("d", lineGen)
      .attr("fill","none").attr("stroke", red).attr("stroke-width", 2.5)
      .attr("stroke-linejoin","round").attr("stroke-linecap","round");
  }

  // Hover
  const dot = svg.append("circle").attr("r",4).attr("fill",blue).style("opacity",0);
  const bisect = d3.bisector(d => d.date).left;

  svg.append("rect")
    .attr("x", mg.l).attr("y", mg.t).attr("width", iw).attr("height", ih)
    .style("fill","transparent").style("cursor","crosshair")
    .on("mousemove", (ev) => {
      if (data.length < 1) return;
      const [mx] = d3.pointer(ev);
      const xd = x.invert(mx);
      const i = clamp(bisect(data, xd), 1, data.length - 1);
      const a = data[i-1], b = data[i];
      const d = (xd - a.date) > (b.date - xd) ? b : a;
      dot.attr("cx", x(d.date)).attr("cy", y(d.D)).style("opacity", 1);
      showSimTip(ev,
        `<div class="stDate">${ds(d.date)}</div>` +
        `<div class="stRow"><span class="stDot" style="background:${blue}"></span><span class="stLbl">D</span><span class="stVal">${d.D.toFixed(1)}%</span></div>` +
        `<div class="stRow"><span class="stDot" style="background:${red}"></span><span class="stLbl">R</span><span class="stVal">${d.R.toFixed(1)}%</span></div>`
      );
    })
    .on("mouseleave", () => { dot.style("opacity",0); hideSimTip(); });
}


/* ========== Resize ========== */
window.addEventListener("resize", () => {
  if (!pollsInited) return;
  try{ renderGBScatter(POLLS_UI.gb); }catch(e){}
  for (const mode of ["senate","governor"]){
    if (POLLS_STATE[mode]){
      try{ renderStatePollScatter(mode, POLLS_STATE[mode]); }catch(e){}
    }
  }
}, {passive:true});


/* ========== Expose init ========== */
window.initPollsPage = initPollsPage;

})();
