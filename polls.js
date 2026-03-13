/* ========== Polls Page Module ========== */
(function(){

let pollsInited = false;
const POLLS_UI = {};
const POLLS_MAP = {};
const POLLS_STATE = { senate: null, governor: null };

/* ---------- Deduplication helper ---------- */
function dedupeByDatePollster(arr, dateKey, pollsterKey, valCheck){
  // Keep first per date+pollster combo
  const seen = new Set();
  return arr.filter(p => {
    const d = p[dateKey]; const ps = String(p[pollsterKey]||"").toLowerCase().trim();
    if (!d) return false;
    const key = `${ds(d)}|${ps}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return valCheck ? valCheck(p) : true;
  });
}

/* ---------- Approval data ---------- */
let APPROVAL_RAW = [];
let APPROVAL_SERIES = [];

function parseApprovalFromPollsJSON(j){
  const raw = Array.isArray(j.approval) ? j.approval : [];
  let parsed = raw.map(p => {
    const date = parseDate(p.end_date || p.start_date || p.created_at);
    let approve = null, disapprove = null;
    for (const a of (p.answers || [])){
      const c = String(a.choice || "").toLowerCase();
      if (c === "approve" || c === "yes") approve = +a.pct;
      if (c === "disapprove" || c === "no") disapprove = +a.pct;
    }
    return { date, approve, disapprove, pollster: p.pollster || "" };
  }).filter(p => p.date && isFinite(p.approve) && isFinite(p.disapprove));
  parsed.sort((a,b) => a.date - b.date);

  // Deduplicate: one per date+pollster
  APPROVAL_RAW = dedupeByDatePollster(parsed, "date", "pollster");

  const strict = !!GB_SRC.filterStrict;
  const polls = APPROVAL_RAW.filter(p => isAllowedPollster(p.pollster, strict));
  APPROVAL_SERIES = calcMovAvg(polls.map(p => ({ date:p.date, a:p.approve, b:p.disapprove })), 24);
}

function calcMovAvg(sorted, N){
  if (!sorted.length) return [];
  const n = sorted.length;
  const psA = new Float64Array(n+1), psB = new Float64Array(n+1);
  for (let i=0;i<n;i++){ psA[i+1]=psA[i]+sorted[i].a; psB[i+1]=psB[i]+sorted[i].b; }
  const t0 = sorted[0].date, lastDay = sorted[n-1].date;
  const today = new Date(); today.setHours(0,0,0,0);
  const t1 = today > lastDay ? today : lastDay;
  const out = [];
  let hi = 0;
  for (let day = new Date(t0); day <= t1; day.setDate(day.getDate()+1)){
    while (hi < n && sorted[hi].date <= day) hi++;
    const lo = Math.max(0, hi - N), cnt = hi - lo;
    if (cnt <= 0) continue;
    out.push({ date: new Date(day), a:(psA[hi]-psA[lo])/cnt, b:(psB[hi]-psB[lo])/cnt, count:cnt });
  }
  return out;
}

/* ---------- Deduplicated GB ---------- */
function getDeduplicatedGB(){
  const raw = (GB_SRC.raw || []).filter(p => p && p.date && isFinite(p.dem) && isFinite(p.rep));
  const strict = !!GB_SRC.filterStrict;
  const filtered = raw.filter(p => isAllowedPollster(p.pollster, strict));
  filtered.sort((a,b) => a.date - b.date);
  return dedupeByDatePollster(filtered, "date", "pollster");
}

let LEFT_MODE = "gb";

/* ---------- Init ---------- */
async function initPollsPage(){
  console.log("initPollsPage called, pollsInited:", pollsInited);

  try {
    if (!APPROVAL_RAW.length){
      const j = await fetch("json/polls.json", {cache:"no-store"}).then(r => r.json());
      parseApprovalFromPollsJSON(j);
    }
  } catch(e){ console.warn("Approval load failed:", e); }

  initPollsUI("gb");
  initPollsUI("senate");
  initPollsUI("governor");

  console.log("POLLS_UI.gb:", POLLS_UI.gb ? Object.entries(POLLS_UI.gb).filter(([k,v])=>v).map(([k])=>k).join(",") : "null");
  console.log("POLLS_UI.senate:", POLLS_UI.senate ? Object.entries(POLLS_UI.senate).filter(([k,v])=>v).map(([k])=>k).join(",") : "null");

  if (!pollsInited) setupLeftToggle();
  pollsInited = true;

  // Reliable wait for reflow
  await new Promise(r => setTimeout(r, 200));

  console.log("Polls: rendering after timeout. GB chart rect:", POLLS_UI.gb?.chart?.getBoundingClientRect());

  try { renderLeftColumn(); } catch(e){ console.error("Polls: GB render failed:", e); }
  try { await initPollsModeColumn("senate"); } catch(e){ console.error("Polls: Senate init failed:", e); }
  try { await initPollsModeColumn("governor"); } catch(e){ console.error("Polls: Gov init failed:", e); }

  try { selectPollsState("senate", "TX"); } catch(e){ console.error("Polls: TX select failed:", e); }
  try { selectPollsState("governor", "AZ"); } catch(e){ console.error("Polls: AZ select failed:", e); }
}

function initPollsUI(mode){
  // Flat grid: cards are siblings with data-polls-mode, not nested
  const page = document.getElementById("pollsPage");
  if (!page) return;
  const cards = page.querySelectorAll(`[data-polls-mode='${mode}']`);
  if (!cards.length) return;
  // Helper: find attribute across all cards for this mode
  const q = (sel) => {
    for (const c of cards){ const el = c.matches(sel) ? c : c.querySelector(sel); if (el) return el; }
    return null;
  };
  POLLS_UI[mode] = {
    root: page,
    topCard: q(".topCard"),
    dPill: q("[data-polls-d]"),
    rPill: q("[data-polls-r]"),
    dBig: q("[data-polls-d-big]"),
    rBig: q("[data-polls-r-big]"),
    dLbl: q("[data-polls-d-lbl]"),
    rLbl: q("[data-polls-r-lbl]"),
    histCanvas: q("[data-polls-hist]"),
    chart: q("[data-polls-chart]"),
    chartTitle: q("[data-polls-chart-title]"),
    chartSub: q("[data-polls-chart-sub]"),
    mapSvg: q("[data-polls-map]"),
    stateChart: q("[data-polls-state-chart]"),
    stateChartTitle: q("[data-polls-state-chart-title]"),
    stateChartWrap: q("[data-polls-state-wrap]"),
    pollList: q("[data-polls-list]"),
  };
}

function setupLeftToggle(){
  const page = document.getElementById("pollsPage");
  if (!page) return;
  page.querySelectorAll("[data-polls-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      page.querySelectorAll("[data-polls-toggle]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      LEFT_MODE = btn.dataset.pollsToggle;
      renderLeftColumn();
    });
  });
}

/* ========== Left Column ========== */
function renderLeftColumn(){
  const ui = POLLS_UI.gb;
  if (!ui) return;
  if (LEFT_MODE === "approval") renderApprovalColumn(ui);
  else renderGBColumn(ui);
}

function renderGBColumn(ui){
  const polls = getDeduplicatedGB();
  const latest = GB_SRC.latest;
  if (!latest){ console.warn("Polls: no GB latest"); return; }
  const dVal = +latest.dem, rVal = +latest.rep;
  if (ui.dPill) ui.dPill.textContent = dVal.toFixed(1);
  if (ui.rPill) ui.rPill.textContent = rVal.toFixed(1);
  if (ui.dBig) ui.dBig.textContent = Math.round(dVal);
  if (ui.rBig) ui.rBig.textContent = Math.round(rVal);
  if (ui.dLbl) ui.dLbl.textContent = "D";
  if (ui.rLbl) ui.rLbl.textContent = "R";
  if (ui.topCard){ ui.topCard.classList.remove("leads-d","leads-r"); ui.topCard.classList.add(dVal>rVal?"leads-d":"leads-r"); }
  // Reset pill to blue
  const dPillEl = ui.dPill?.closest(".metricPill");
  if (dPillEl){ dPillEl.classList.add("blue"); dPillEl.querySelector(".dot").style.background=""; }
  // Reset big number to blue
  const dSide = ui.dBig?.closest(".seatsSide");
  if (dSide) dSide.style.color = "";
  if (ui.chartTitle) ui.chartTitle.textContent = "Generic Ballot";
  if (ui.chartSub) ui.chartSub.textContent = "Scatter plot · moving average";

  console.log("Polls: GB polls count:", polls.length, "ui.chart:", !!ui.chart, "ui.histCanvas:", !!ui.histCanvas);

  try { drawMarginHist(ui.histCanvas, polls.map(p => p.dem - p.rep)); } catch(e){ console.error("GB hist:", e); }

  const series = (GB_SRC.series||[]).map(s=>({date:parseDate(s.date),a:+s.dem,b:+s.rep})).filter(d=>d.date);
  try { renderDualScatter(ui.chart, polls.map(p=>({date:p.date,a:+p.dem,b:+p.rep})), series, "D","R"); } catch(e){ console.error("GB scatter:", e); }

  try { renderPollTable(ui.pollList, polls.sort((a,b)=>b.date-a.date).slice(0,100).map(p=>({
    date:p.date, pollster:p.pollster, a:p.dem, b:p.rep, lA:"D", lB:"R"
  }))); } catch(e){ console.error("GB table:", e); }
}

function renderApprovalColumn(ui){
  if (!APPROVAL_SERIES.length) return;
  const latest = APPROVAL_SERIES[APPROVAL_SERIES.length-1];
  if (ui.dPill) ui.dPill.textContent = latest.a.toFixed(1);
  if (ui.rPill) ui.rPill.textContent = latest.b.toFixed(1);
  if (ui.dBig) ui.dBig.textContent = Math.round(latest.a);
  if (ui.rBig) ui.rBig.textContent = Math.round(latest.b);
  if (ui.dLbl) ui.dLbl.textContent = "App";
  if (ui.rLbl) ui.rLbl.textContent = "Dis";
  if (ui.topCard){ ui.topCard.classList.remove("leads-d","leads-r"); }
  // Green pill for approve
  const dPillEl = ui.dPill?.closest(".metricPill");
  if (dPillEl){ dPillEl.classList.remove("blue"); dPillEl.querySelector(".dot").style.background="#16a34a"; }
  // Green big number
  const dSide = ui.dBig?.closest(".seatsSide");
  if (dSide) dSide.style.color = "#16a34a";
  if (ui.chartTitle) ui.chartTitle.textContent = "Presidential Approval";
  if (ui.chartSub) ui.chartSub.textContent = "Scatter plot · moving average";

  const strict = !!GB_SRC.filterStrict;
  const polls = APPROVAL_RAW.filter(p=>isAllowedPollster(p.pollster,strict));

  drawMarginHist(ui.histCanvas, polls.map(p => p.approve - p.disapprove));
  renderDualScatter(ui.chart, polls.map(p=>({date:p.date,a:p.approve,b:p.disapprove})), APPROVAL_SERIES, "App","Dis","#16a34a","var(--red)");

  renderPollTable(ui.pollList, polls.sort((a,b)=>b.date-a.date).slice(0,100).map(p=>({
    date:p.date, pollster:p.pollster, a:p.approve, b:p.disapprove, lA:"App", lB:"Dis"
  })), "#16a34a", "var(--red)");
}




/* --- Dual Scatter Plot --- */
function renderDualScatter(svgEl, polls, avgSeries, lA, lB, colorAOverride, colorBOverride){
  if (!svgEl) return;
  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(320,Math.floor(rect.width||400));
  const height = Math.max(200,Math.floor(rect.height||240));
  const svg = d3.select(svgEl); svg.selectAll("*").remove();
  svg.attr("viewBox",`0 0 ${width} ${height}`);
  const mg={l:38,r:10,t:10,b:26}, iw=width-mg.l-mg.r, ih=height-mg.t-mg.b;
  if (!polls.length) return;

  const allDates = polls.map(d=>d.date).concat(avgSeries.map(d=>d.date)).filter(Boolean);
  const xExt = d3.extent(allDates);
  const allVals = polls.flatMap(d=>[d.a,d.b]);
  const yMin=Math.max(0,d3.min(allVals)-3), yMax=Math.min(100,d3.max(allVals)+3);
  const x = d3.scaleTime().domain(xExt).range([mg.l,mg.l+iw]);
  const y = d3.scaleLinear().domain([yMin,yMax]).range([mg.t+ih,mg.t]).nice();

  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${mg.t+ih})`).call(d3.axisBottom(x).ticks(Math.min(6,Math.floor(iw/100))).tickFormat(d3.timeFormat("%b")));
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d=>`${d}%`));

  if (y.domain()[0]<=50&&y.domain()[1]>=50)
    svg.append("line").attr("x1",mg.l).attr("x2",mg.l+iw).attr("y1",y(50)).attr("y2",y(50)).attr("class","seatMajLine");

  const cs=getComputedStyle(document.documentElement);
  const blue=colorAOverride||cs.getPropertyValue("--blue").trim()||"#2563eb";
  const red=colorBOverride||cs.getPropertyValue("--red").trim()||"#dc2626";

  svg.selectAll(".dA").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.a)).attr("r",2.5).attr("fill",blue).attr("opacity",0.25);
  svg.selectAll(".dB").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.b)).attr("r",2.5).attr("fill",red).attr("opacity",0.25);

  if (avgSeries.length>1){
    const lnA=d3.line().x(d=>x(d.date)).y(d=>y(d.a)).curve(d3.curveMonotoneX);
    const lnB=d3.line().x(d=>x(d.date)).y(d=>y(d.b)).curve(d3.curveMonotoneX);
    svg.append("path").datum(avgSeries).attr("d",lnA).attr("fill","none").attr("stroke",blue).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
    svg.append("path").datum(avgSeries).attr("d",lnB).attr("fill","none").attr("stroke",red).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
  }

  const dot=svg.append("circle").attr("r",4).attr("fill",blue).style("opacity",0);
  const bisect=d3.bisector(d=>d.date).left;
  const hd = avgSeries.length>1?avgSeries:polls;
  svg.append("rect").attr("x",mg.l).attr("y",mg.t).attr("width",iw).attr("height",ih)
    .style("fill","transparent").style("cursor","crosshair")
    .on("mousemove",(ev)=>{
      if(hd.length<1)return;
      const[mx]=d3.pointer(ev); const xd=x.invert(mx);
      const i=clamp(bisect(hd,xd),1,hd.length-1);
      const p=hd[i-1],q=hd[i]; const d=(xd-p.date)>(q.date-xd)?q:p;
      dot.attr("cx",x(d.date)).attr("cy",y(d.a)).style("opacity",1);
      showSimTip(ev,
        `<div class="stDate">${ds(d.date)}</div>`+
        `<div class="stRow"><span class="stDot" style="background:${blue}"></span><span class="stLbl">${lA}</span><span class="stVal">${d.a.toFixed(1)}%</span></div>`+
        `<div class="stRow"><span class="stDot" style="background:${red}"></span><span class="stLbl">${lB}</span><span class="stVal">${d.b.toFixed(1)}%</span></div>`
      );
    })
    .on("mouseleave",()=>{dot.style("opacity",0);hideSimTip();});
}

/* --- Poll Table --- */
function renderPollTable(el, rows, colA, colB){
  if (!el) return;
  if (!rows.length){ el.innerHTML=`<div style="padding:16px;color:var(--muted);font-size:12px;">No polls</div>`; return; }
  const lA=rows[0].lA, lB=rows[0].lB;
  const cA=colA||"var(--blue)", cB=colB||"var(--red)";
  let h=`<table class="pollTable" style="font-family:'Inter',system-ui,sans-serif"><thead><tr><th>Date</th><th>Pollster</th><th style="color:${cA}">${lA}</th><th style="color:${cB}">${lB}</th><th>Margin</th></tr></thead><tbody>`;
  for (const p of rows){
    const m=p.a-p.b;
    const ms=Math.abs(m)<0.05?"Tied":(m>0?`${lA}+${m.toFixed(1)}`:`${lB}+${Math.abs(m).toFixed(1)}`);
    const mc=m>0?cA:(m<0?cB:"var(--muted)");
    h+=`<tr><td>${ds(p.date)}</td><td class="pollTd">${String(p.pollster||"").slice(0,28)}</td><td style="color:${cA}">${(+p.a).toFixed(1)}</td><td style="color:${cB}">${(+p.b).toFixed(1)}</td><td style="color:${mc};font-weight:700">${ms}</td></tr>`;
  }
  h+=`</tbody></table>`;
  el.innerHTML=h;
}


/* ========== Senate / Governor ========== */
async function initPollsModeColumn(modeKey){
  const ui = POLLS_UI[modeKey];
  if (!ui){ console.warn("Polls: no UI for", modeKey); return; }
  console.log("Polls: init", modeKey, "ui keys:", Object.keys(ui).filter(k=>ui[k]).join(","));
  const tally = computeSeatTally(modeKey, IND_CACHE[modeKey]);
  if (ui.dBig) ui.dBig.textContent = tally.totalD;
  if (ui.rBig) ui.rBig.textContent = tally.totalR;
  if (ui.topCard){ ui.topCard.classList.remove("leads-d","leads-r"); ui.topCard.classList.add(tally.totalD>tally.totalR?"leads-d":"leads-r"); }

  try { renderModeMarginHist(modeKey); } catch(e){ console.error("Polls hist:", modeKey, e); }
  try { await initPollsMap(modeKey); } catch(e){ console.error("Polls map:", modeKey, e); }
  try { recolorPollsMapByPolling(modeKey); } catch(e){ console.error("Polls recolor:", modeKey, e); }
  if (ui.stateChartTitle) ui.stateChartTitle.textContent = "Click a state to see polls";
}

function renderModeMarginHist(modeKey){
  const ui=POLLS_UI[modeKey]; const canvas=ui?.histCanvas; if(!canvas)return;
  const src = STATE_POLL_SRC.byModeState?.[modeKey];
  if (!src) return;

  // Gather all poll margins (D - R) across all states
  const margins = [];
  for (const st of Object.keys(src)){
    for (const p of src[st]){
      if (isFinite(p.D) && isFinite(p.R)) margins.push(p.D - p.R);
    }
  }
  drawMarginHist(canvas, margins);
}

/* --- Maps (colored by POLLS) --- */
async function initPollsMap(modeKey){
  const ui=POLLS_UI[modeKey]; if(!ui?.mapSvg)return;
  const geo=await loadStateGeo();
  const width=960,height=600;
  const svg=d3.select(ui.mapSvg); svg.attr("viewBox",`0 0 ${width} ${height}`); svg.selectAll("*").remove();
  const projection=d3.geoAlbersUsa(); projection.fitExtent([[18,18],[width-18,height-18]],geo);
  const pathGen=d3.geoPath(projection);
  const gRoot=svg.append("g");
  gRoot.selectAll("path").data(geo.features).join("path")
    .attr("class",d=>{const st=fipsToUsps(d.id); return(st&&DATA[modeKey]?.ratios[st])?"state active":"state";})
    .attr("data-st",d=>fipsToUsps(d.id))
    .attr("d",d=>pathGen(d))
    .attr("fill","#e5e7eb")
    .style("cursor",d=>{const st=fipsToUsps(d.id); return(st&&DATA[modeKey]?.ratios[st])?"pointer":"default";})
    .on("mouseenter",(event,d)=>{
      const st=fipsToUsps(d.id); if(!st||!DATA[modeKey]?.ratios[st])return;
      d3.select(event.currentTarget).classed("hovered",true);
      const polls=STATE_POLL_SRC.byModeState?.[modeKey]?.[st]; const pc=polls?polls.length:0;
      let ms="No polls";
      if(polls&&polls.length){const last=polls[polls.length-1];const m=last.D-last.R;
        ms=Math.abs(m)<0.05?"Tied":(m>0?`D+${m.toFixed(1)}`:`R+${Math.abs(m).toFixed(1)}`);}
      showSimTip(event,`<span style="font-weight:900">${USPS_TO_NAME[st]||st}</span> <span style="font-weight:700">${ms}</span><span style="color:var(--muted);font-size:10px;margin-left:4px">${pc} poll${pc!==1?"s":""}</span>`);
    })
    .on("mousemove",(event)=>{const el=document.getElementById("simTip");if(el)showSimTip(event,el.innerHTML);})
    .on("mouseleave",(event)=>{d3.select(event.currentTarget).classed("hovered",false);hideSimTip();})
    .on("click",(event,d)=>{const st=fipsToUsps(d.id);if(st&&DATA[modeKey]?.ratios[st])selectPollsState(modeKey,st);});
  POLLS_MAP[modeKey]={svg,gRoot};
}

function recolorPollsMapByPolling(modeKey){
  const m=POLLS_MAP[modeKey]; if(!m?.gRoot)return;
  m.gRoot.selectAll("path.state").each(function(){
    const st=this.getAttribute("data-st");
    if(!st||!DATA[modeKey]?.ratios[st]){this.style.fill="#e5e7eb";return;}
    const polls=STATE_POLL_SRC.byModeState?.[modeKey]?.[st];
    if(!polls||!polls.length){this.style.fill="#f3f4f6";return;}
    const w=Math.min(STATE_POLL_SRC.window||6,polls.length);
    let sD=0,sR=0;
    for(let i=polls.length-w;i<polls.length;i++){sD+=polls[i].D;sR+=polls[i].R;}
    this.style.fill=interpColor((sR/w)-(sD/w));
  });
}

/* --- State Selection --- */
function selectPollsState(modeKey,usps){
  POLLS_STATE[modeKey]=usps;
  const ui=POLLS_UI[modeKey]; if(!ui)return;
  const m=POLLS_MAP[modeKey];
  if(m?.gRoot) m.gRoot.selectAll("path.state")
    .attr("stroke",function(){return this.getAttribute("data-st")===usps?"var(--ink)":"white";})
    .attr("stroke-width",function(){return this.getAttribute("data-st")===usps?2.5:1;});
  if(ui.stateChartWrap)ui.stateChartWrap.style.display="";
  if(ui.stateChartTitle)ui.stateChartTitle.textContent=`${USPS_TO_NAME[usps]||usps} — ${modeKey==="senate"?"Senate":"Governor"} polls`;
  renderStatePollScatter(modeKey,usps);
}

function renderStatePollScatter(modeKey,usps){
  const ui=POLLS_UI[modeKey]; const svgEl=ui?.stateChart; if(!svgEl)return;
  const polls=(STATE_POLL_SRC.byModeState?.[modeKey]?.[usps]||[]).map(p=>({date:p.date,a:+p.D,b:+p.R})).sort((a,b)=>a.date-b.date);
  const rect=svgEl.getBoundingClientRect();
  const width=Math.max(320,Math.floor(rect.width||400)),height=Math.max(180,Math.floor(rect.height||220));
  const svg=d3.select(svgEl); svg.selectAll("*").remove(); svg.attr("viewBox",`0 0 ${width} ${height}`);
  const mg={l:38,r:10,t:10,b:26},iw=width-mg.l-mg.r,ih=height-mg.t-mg.b;
  if(!polls.length){svg.append("text").attr("x",width/2).attr("y",height/2).attr("text-anchor","middle").attr("fill","var(--muted)").attr("font-size","12px").attr("font-weight","600").text("No polls for this state");return;}
  const allVals=polls.flatMap(d=>[d.a,d.b]);
  const yMin=Math.max(0,d3.min(allVals)-3),yMax=Math.min(100,d3.max(allVals)+3);
  const x=d3.scaleTime().domain(d3.extent(polls,d=>d.date)).range([mg.l,mg.l+iw]);
  const y=d3.scaleLinear().domain([yMin,yMax]).range([mg.t+ih,mg.t]).nice();
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${mg.t+ih})`).call(d3.axisBottom(x).ticks(Math.min(6,Math.floor(iw/90))).tickFormat(d3.timeFormat("%b %d")));
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d=>`${d}%`));
  if(y.domain()[0]<=50&&y.domain()[1]>=50) svg.append("line").attr("x1",mg.l).attr("x2",mg.l+iw).attr("y1",y(50)).attr("y2",y(50)).attr("class","seatMajLine");
  const cs=getComputedStyle(document.documentElement);
  const blue=cs.getPropertyValue("--blue").trim()||"#2563eb",red=cs.getPropertyValue("--red").trim()||"#dc2626";
  svg.selectAll(".dD").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.a)).attr("r",3.5).attr("fill",blue).attr("opacity",0.5);
  svg.selectAll(".dR").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.b)).attr("r",3.5).attr("fill",red).attr("opacity",0.5);
  if(polls.length>=3){
    const win=Math.min(6,polls.length); const avg=[];
    for(let i=0;i<polls.length;i++){const lo=Math.max(0,i-win+1);let sA=0,sB=0;for(let j=lo;j<=i;j++){sA+=polls[j].a;sB+=polls[j].b;}const cnt=i-lo+1;avg.push({date:polls[i].date,a:sA/cnt,b:sB/cnt});}
    const lnA=d3.line().x(d=>x(d.date)).y(d=>y(d.a)).curve(d3.curveMonotoneX);
    const lnB=d3.line().x(d=>x(d.date)).y(d=>y(d.b)).curve(d3.curveMonotoneX);
    svg.append("path").datum(avg).attr("d",lnA).attr("fill","none").attr("stroke",blue).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
    svg.append("path").datum(avg).attr("d",lnB).attr("fill","none").attr("stroke",red).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
  }
  const dot=svg.append("circle").attr("r",4).attr("fill",blue).style("opacity",0);
  const bisect=d3.bisector(d=>d.date).left;
  svg.append("rect").attr("x",mg.l).attr("y",mg.t).attr("width",iw).attr("height",ih).style("fill","transparent").style("cursor","crosshair")
    .on("mousemove",(ev)=>{if(polls.length<1)return;const[mx]=d3.pointer(ev);const xd=x.invert(mx);const i=clamp(bisect(polls,xd),1,polls.length-1);const a=polls[i-1],b=polls[i];const d=(xd-a.date)>(b.date-xd)?b:a;dot.attr("cx",x(d.date)).attr("cy",y(d.a)).style("opacity",1);showSimTip(ev,`<div class="stDate">${ds(d.date)}</div><div class="stRow"><span class="stDot" style="background:${blue}"></span><span class="stLbl">D</span><span class="stVal">${d.a.toFixed(1)}%</span></div><div class="stRow"><span class="stDot" style="background:${red}"></span><span class="stLbl">R</span><span class="stVal">${d.b.toFixed(1)}%</span></div>`);})
    .on("mouseleave",()=>{dot.style("opacity",0);hideSimTip();});
}

/* ========== Resize ========== */
window.addEventListener("resize",()=>{
  if(!pollsInited)return;
  try{renderLeftColumn();}catch(e){}
  for(const mode of["senate","governor"]){
    try{renderModeMarginHist(mode);}catch(e){}
    if(POLLS_STATE[mode])try{renderStatePollScatter(mode,POLLS_STATE[mode]);}catch(e){}
  }
},{passive:true});

window.initPollsPage = initPollsPage;
})();
