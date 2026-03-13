/* ========== Polls Page Module (v11 — full rewrite) ========== */
(function(){
"use strict";

const FONT = "'Inter',system-ui,-apple-system,sans-serif";
let pollsInited = false;
const PUI = {};          // per-mode UI refs
const PMAP = {};         // per-mode map handles
const PSEL = { senate:null, governor:null }; // selected state

/* ---- Approval data ---- */
let APP_RAW = [];        // {date,approve,disapprove,pollster}
let APP_SERIES = [];     // moving avg [{date,a,b}]

function loadApproval(j){
  APP_RAW = (j.approval||[]).map(p=>{
    const date=parseDate(p.end_date||p.start_date||p.created_at);
    let ap=null,dis=null;
    for(const a of(p.answers||[])){
      const c=String(a.choice||"").toLowerCase();
      if(c==="approve"||c==="yes") ap=+a.pct;
      if(c==="disapprove"||c==="no") dis=+a.pct;
    }
    return{date,approve:ap,disapprove:dis,pollster:p.pollster||""};
  }).filter(p=>p.date&&isFinite(p.approve)&&isFinite(p.disapprove));
  APP_RAW.sort((a,b)=>a.date-b.date);
  // dedupe
  APP_RAW = dedupe(APP_RAW,"date","pollster");
  const strict=!!GB_SRC.filterStrict;
  const f=APP_RAW.filter(p=>isAllowedPollster(p.pollster,strict));
  APP_SERIES=movAvg(f.map(p=>({date:p.date,a:p.approve,b:p.disapprove})),24);
}

function dedupe(arr,dk,pk){
  const seen=new Set();
  return arr.filter(p=>{
    const key=ds(p[dk])+"|"+String(p[pk]||"").toLowerCase().trim();
    if(seen.has(key))return false;
    seen.add(key); return true;
  });
}

function movAvg(sorted,N){
  if(!sorted.length)return[];
  const n=sorted.length;
  const pA=new Float64Array(n+1),pB=new Float64Array(n+1);
  for(let i=0;i<n;i++){pA[i+1]=pA[i]+sorted[i].a;pB[i+1]=pB[i]+sorted[i].b;}
  const out=[];let hi=0;
  const t1=new Date();t1.setHours(0,0,0,0);
  const end=t1>sorted[n-1].date?t1:sorted[n-1].date;
  for(let d=new Date(sorted[0].date);d<=end;d.setDate(d.getDate()+1)){
    while(hi<n&&sorted[hi].date<=d)hi++;
    const lo=Math.max(0,hi-N),c=hi-lo;
    if(c>0)out.push({date:new Date(d),a:(pA[hi]-pA[lo])/c,b:(pB[hi]-pB[lo])/c});
  }
  return out;
}

function gbDeduped(){
  const raw=(GB_SRC.raw||[]).filter(p=>p&&p.date&&isFinite(p.dem)&&isFinite(p.rep));
  const strict=!!GB_SRC.filterStrict;
  const f=raw.filter(p=>isAllowedPollster(p.pollster,strict));
  f.sort((a,b)=>a.date-b.date);
  return dedupe(f,"date","pollster");
}

/* ---- Left mode ---- */
let LMODE="gb";

/* ======== INIT ======== */
async function initPollsPage(){
  console.log("initPollsPage v11");
  if(!APP_RAW.length){
    try{const j=await fetch("json/polls.json",{cache:"no-store"}).then(r=>r.json());loadApproval(j);}catch(e){console.warn(e);}
  }
  buildUI("gb"); buildUI("senate"); buildUI("governor");
  if(!pollsInited) wireToggle();
  pollsInited=true;

  await new Promise(r=>setTimeout(r,250));

  try{renderLeft();}catch(e){console.error("left:",e);}
  try{await initMode("senate");}catch(e){console.error("sen:",e);}
  try{await initMode("governor");}catch(e){console.error("gov:",e);}
  try{pickState("senate","TX");}catch(e){}
  try{pickState("governor","AZ");}catch(e){}
}

function buildUI(m){
  const pg=document.getElementById("pollsPage"); if(!pg)return;
  const cards=pg.querySelectorAll(`[data-polls-mode='${m}']`);
  const q=s=>{for(const c of cards){const el=c.matches(s)?c:c.querySelector(s);if(el)return el;}return null;};
  PUI[m]={
    topCard:q(".topCard"),
    dPill:q("[data-polls-d]"), rPill:q("[data-polls-r]"),
    dBig:q("[data-polls-d-big]"), rBig:q("[data-polls-r-big]"),
    dLbl:q("[data-polls-d-lbl]"), rLbl:q("[data-polls-r-lbl]"),
    hist:q("[data-polls-hist]"),
    chart:q("[data-polls-chart]"),
    chartTitle:q("[data-polls-chart-title]"), chartSub:q("[data-polls-chart-sub]"),
    map:q("[data-polls-map]"),
    stChart:q("[data-polls-state-chart]"),
    stTitle:q("[data-polls-state-chart-title]"),
    list:q("[data-polls-list]"),
  };
}

function wireToggle(){
  const pg=document.getElementById("pollsPage"); if(!pg)return;
  pg.querySelectorAll("[data-polls-toggle]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      pg.querySelectorAll("[data-polls-toggle]").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      LMODE=btn.dataset.pollsToggle;
      renderLeft();
    });
  });
}

/* ======== LEFT COLUMN ======== */
function renderLeft(){
  const ui=PUI.gb; if(!ui)return;
  LMODE==="approval"?renderApproval(ui):renderGB(ui);
}

function renderGB(ui){
  const polls=gbDeduped();
  const lat=GB_SRC.latest; if(!lat)return;
  const dV=+lat.dem,rV=+lat.rep;
  setNum(ui,dV,rV,"D","R");
  colorTop(ui,dV>rV);
  resetPillColor(ui);
  if(ui.chartTitle)ui.chartTitle.textContent="Generic Ballot";
  if(ui.chartSub)ui.chartSub.textContent="Scatter · moving average";

  drawMarginHist(ui.hist, polls.map(p=>p.dem-p.rep));
  const ser=(GB_SRC.series||[]).map(s=>({date:parseDate(s.date),a:+s.dem,b:+s.rep})).filter(d=>d.date);
  dualScatter(ui.chart, polls.map(p=>({date:p.date,a:+p.dem,b:+p.rep})), ser, "D","R");
  pollTable(ui.list, polls.sort((a,b)=>b.date-a.date).slice(0,100).map(p=>({date:p.date,ps:p.pollster,a:p.dem,b:p.rep})),"D","R","var(--blue)","var(--red)");
}

function renderApproval(ui){
  if(!APP_SERIES.length)return;
  const lat=APP_SERIES[APP_SERIES.length-1];
  setNum(ui,lat.a,lat.b,"App","Dis");
  if(ui.topCard)ui.topCard.classList.remove("leads-d","leads-r");
  greenPill(ui);
  if(ui.chartTitle)ui.chartTitle.textContent="Presidential Approval";
  if(ui.chartSub)ui.chartSub.textContent="Scatter · moving average";

  const strict=!!GB_SRC.filterStrict;
  const polls=APP_RAW.filter(p=>isAllowedPollster(p.pollster,strict));
  drawMarginHist(ui.hist, polls.map(p=>p.approve-p.disapprove));
  dualScatter(ui.chart, polls.map(p=>({date:p.date,a:p.approve,b:p.disapprove})), APP_SERIES, "App","Dis","#16a34a","var(--red)");
  pollTable(ui.list, polls.sort((a,b)=>b.date-a.date).slice(0,100).map(p=>({date:p.date,ps:p.pollster,a:p.approve,b:p.disapprove})),"App","Dis","#16a34a","#dc2626");
}

function setNum(ui,a,b,lA,lB){
  if(ui.dPill)ui.dPill.textContent=(+a).toFixed(1);
  if(ui.rPill)ui.rPill.textContent=(+b).toFixed(1);
  if(ui.dBig)ui.dBig.textContent=Math.round(a);
  if(ui.rBig)ui.rBig.textContent=Math.round(b);
  if(ui.dLbl)ui.dLbl.textContent=lA;
  if(ui.rLbl)ui.rLbl.textContent=lB;
}
function colorTop(ui,dLead){
  if(!ui.topCard)return;
  ui.topCard.classList.remove("leads-d","leads-r");
  ui.topCard.classList.add(dLead?"leads-d":"leads-r");
}
function resetPillColor(ui){
  const el=ui.dPill?.closest(".metricPill");
  if(el){el.classList.add("blue");el.querySelector(".dot").style.background="";}
  const s=ui.dBig?.closest(".seatsSide"); if(s)s.style.color="";
}
function greenPill(ui){
  const el=ui.dPill?.closest(".metricPill");
  if(el){el.classList.remove("blue");el.querySelector(".dot").style.background="#16a34a";}
  const s=ui.dBig?.closest(".seatsSide"); if(s)s.style.color="#16a34a";
}

/* ======== MARGIN HISTOGRAM ======== */
function drawMarginHist(canvas,margins){
  if(!canvas)return;
  const W=canvas.clientWidth||300, H=canvas.clientHeight||36;
  const dpr=devicePixelRatio||1;
  canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr);
  const ctx=canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  if(!margins.length)return;
  const lo=-20,hi=20,n=hi-lo+1;
  const c=new Array(n).fill(0);
  for(const m of margins){const i=Math.round(m)-lo; if(i>=0&&i<n)c[i]++;}
  const mx=Math.max(...c)||1, bw=W/n;
  const cs=getComputedStyle(document.documentElement);
  const bl=cs.getPropertyValue("--blue").trim()||"#2563eb";
  const rd=cs.getPropertyValue("--red").trim()||"#dc2626";
  // Center line at 0
  const cx=((0-lo)/n)*W;
  ctx.strokeStyle="rgba(0,0,0,0.2)"; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,H); ctx.stroke();
  // Bars
  for(let i=0;i<n;i++){
    const v=lo+i, h=(c[i]/mx)*(H-4);
    ctx.fillStyle=v>0?bl:(v<0?rd:"#fde047");
    ctx.globalAlpha=0.8;
    ctx.fillRect(i*bw+.5,H-h,bw-1,h);
  }
  ctx.globalAlpha=1;
}

/* ======== DUAL SCATTER ======== */
function dualScatter(el,polls,avg,lA,lB,cA,cB){
  if(!el)return;
  const r=el.getBoundingClientRect();
  const W=Math.max(320,Math.floor(r.width||400)), H=Math.max(200,Math.floor(r.height||240));
  const svg=d3.select(el); svg.selectAll("*").remove(); svg.attr("viewBox",`0 0 ${W} ${H}`);
  const mg={l:38,r:10,t:10,b:26}, iw=W-mg.l-mg.r, ih=H-mg.t-mg.b;
  if(!polls.length)return;
  const cs=getComputedStyle(document.documentElement);
  const blue=cA||cs.getPropertyValue("--blue").trim()||"#2563eb";
  const red=cB||cs.getPropertyValue("--red").trim()||"#dc2626";
  const ad=polls.map(d=>d.date).concat(avg.map(d=>d.date)).filter(Boolean);
  const xE=d3.extent(ad), av=polls.flatMap(d=>[d.a,d.b]);
  const yMn=Math.max(0,d3.min(av)-3), yMx=Math.min(100,d3.max(av)+3);
  const x=d3.scaleTime().domain(xE).range([mg.l,mg.l+iw]);
  const y=d3.scaleLinear().domain([yMn,yMx]).range([mg.t+ih,mg.t]).nice();
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${mg.t+ih})`).call(d3.axisBottom(x).ticks(Math.min(6,iw/100|0)).tickFormat(d3.timeFormat("%b")));
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d=>`${d}%`));
  if(y.domain()[0]<=50&&y.domain()[1]>=50)
    svg.append("line").attr("x1",mg.l).attr("x2",mg.l+iw).attr("y1",y(50)).attr("y2",y(50)).attr("class","seatMajLine");
  svg.selectAll(".dA").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.a)).attr("r",2.5).attr("fill",blue).attr("opacity",.25);
  svg.selectAll(".dB").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.b)).attr("r",2.5).attr("fill",red).attr("opacity",.25);
  if(avg.length>1){
    const la=d3.line().x(d=>x(d.date)).y(d=>y(d.a)).curve(d3.curveMonotoneX);
    const lb=d3.line().x(d=>x(d.date)).y(d=>y(d.b)).curve(d3.curveMonotoneX);
    svg.append("path").datum(avg).attr("d",la).attr("fill","none").attr("stroke",blue).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
    svg.append("path").datum(avg).attr("d",lb).attr("fill","none").attr("stroke",red).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
  }
  // hover
  const dot=svg.append("circle").attr("r",4).attr("fill",blue).style("opacity",0);
  const bis=d3.bisector(d=>d.date).left;
  const hd=avg.length>1?avg:polls;
  svg.append("rect").attr("x",mg.l).attr("y",mg.t).attr("width",iw).attr("height",ih).style("fill","transparent").style("cursor","crosshair")
    .on("mousemove",ev=>{if(!hd.length)return;const[mx]=d3.pointer(ev);const xd=x.invert(mx);const i=clamp(bis(hd,xd),1,hd.length-1);const p=hd[i-1],q=hd[i];const d=(xd-p.date)>(q.date-xd)?q:p;dot.attr("cx",x(d.date)).attr("cy",y(d.a)).style("opacity",1);showSimTip(ev,`<div class="stDate">${ds(d.date)}</div><div class="stRow"><span class="stDot" style="background:${blue}"></span><span class="stLbl">${lA}</span><span class="stVal">${d.a.toFixed(1)}%</span></div><div class="stRow"><span class="stDot" style="background:${red}"></span><span class="stLbl">${lB}</span><span class="stVal">${d.b.toFixed(1)}%</span></div>`);})
    .on("mouseleave",()=>{dot.style("opacity",0);hideSimTip();});
}

/* ======== POLL TABLE ======== */
function pollTable(el,rows,lA,lB,cA,cB){
  if(!el)return;
  if(!rows.length){el.innerHTML=`<div style="padding:16px;color:#6b7280;font:12px ${FONT}">No polls</div>`;return;}
  const ca=cA||"#2563eb",cb=cB||"#dc2626";
  let h=`<table style="width:100%;border-collapse:collapse;font:600 11px/1.4 ${FONT};font-variant-numeric:tabular-nums">`;
  h+=`<thead><tr style="background:#f9fafb;font:800 10px/1.4 ${FONT};text-transform:uppercase;letter-spacing:.04em;color:#6b7280">`;
  h+=`<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#f9fafb;z-index:2">Date</th>`;
  h+=`<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#f9fafb;z-index:2">Pollster</th>`;
  h+=`<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#f9fafb;z-index:2;color:${ca}">${lA}</th>`;
  h+=`<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#f9fafb;z-index:2;color:${cb}">${lB}</th>`;
  h+=`<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#f9fafb;z-index:2">Margin</th>`;
  h+=`</tr></thead><tbody>`;
  for(const p of rows){
    const m=p.a-p.b;
    const ms=Math.abs(m)<.05?"Tied":(m>0?`${lA}+${m.toFixed(1)}`:`${lB}+${Math.abs(m).toFixed(1)}`);
    const mc=m>0?ca:(m<0?cb:"#6b7280");
    h+=`<tr style="border-bottom:1px solid rgba(229,231,235,.5)">`;
    h+=`<td style="padding:5px 8px;font:600 11px ${FONT};white-space:nowrap">${ds(p.date)}</td>`;
    h+=`<td style="padding:5px 8px;font:500 11px ${FONT};max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#374151">${String(p.ps||"").slice(0,28)}</td>`;
    h+=`<td style="padding:5px 8px;font:600 11px ${FONT};color:${ca}">${(+p.a).toFixed(1)}</td>`;
    h+=`<td style="padding:5px 8px;font:600 11px ${FONT};color:${cb}">${(+p.b).toFixed(1)}</td>`;
    h+=`<td style="padding:5px 8px;font:700 11px ${FONT};color:${mc}">${ms}</td>`;
    h+=`</tr>`;
  }
  h+=`</tbody></table>`;
  el.innerHTML=h;
}

/* ======== SENATE / GOV COLUMNS ======== */
async function initMode(mk){
  const ui=PUI[mk]; if(!ui)return;
  // Default: show model seat tally
  const t=computeSeatTally(mk,IND_CACHE[mk]);
  setNum(ui,t.totalD,t.totalR,"D","R");
  colorTop(ui,t.totalD>t.totalR);

  // Margin histogram from all state polls
  const src=STATE_POLL_SRC.byModeState?.[mk];
  if(src){
    const margins=[];
    for(const st of Object.keys(src)) for(const p of src[st]) if(isFinite(p.D)&&isFinite(p.R)) margins.push(p.D-p.R);
    drawMarginHist(ui.hist,margins);
  }

  await initMap(mk);
  recolorMap(mk);
  if(ui.stTitle)ui.stTitle.textContent="Click a state to see polls";
}

/* ---- Maps (colored by POLLS) ---- */
async function initMap(mk){
  const ui=PUI[mk]; if(!ui?.map)return;
  const geo=await loadStateGeo();
  const W=960,H=600;
  const svg=d3.select(ui.map); svg.attr("viewBox",`0 0 ${W} ${H}`); svg.selectAll("*").remove();
  const proj=d3.geoAlbersUsa(); proj.fitExtent([[18,18],[W-18,H-18]],geo);
  const path=d3.geoPath(proj);
  const g=svg.append("g");
  g.selectAll("path").data(geo.features).join("path")
    .attr("class",d=>{const st=fipsToUsps(d.id);return(st&&DATA[mk]?.ratios[st])?"state active":"state";})
    .attr("data-st",d=>fipsToUsps(d.id)).attr("d",d=>path(d)).attr("fill","#e5e7eb")
    .style("cursor",d=>{const st=fipsToUsps(d.id);return(st&&DATA[mk]?.ratios[st])?"pointer":"default";})
    .on("mouseenter",(ev,d)=>{
      const st=fipsToUsps(d.id);if(!st||!DATA[mk]?.ratios[st])return;
      d3.select(ev.currentTarget).classed("hovered",true);
      const pp=STATE_POLL_SRC.byModeState?.[mk]?.[st],pc=pp?pp.length:0;
      let ms="No polls";
      if(pp&&pp.length){const l=pp[pp.length-1];const m=l.D-l.R;ms=Math.abs(m)<.05?"Tied":(m>0?`D+${m.toFixed(1)}`:`R+${Math.abs(m).toFixed(1)}`);}
      showSimTip(ev,`<b>${USPS_TO_NAME[st]||st}</b> <b>${ms}</b> <span style="color:#6b7280;font-size:10px;margin-left:4px">${pc} poll${pc!==1?"s":""}</span>`);
    })
    .on("mousemove",ev=>{const el=document.getElementById("simTip");if(el)showSimTip(ev,el.innerHTML);})
    .on("mouseleave",ev=>{d3.select(ev.currentTarget).classed("hovered",false);hideSimTip();})
    .on("click",(ev,d)=>{const st=fipsToUsps(d.id);if(st&&DATA[mk]?.ratios[st])pickState(mk,st);});
  PMAP[mk]={svg,g};
}

function recolorMap(mk){
  const m=PMAP[mk]; if(!m?.g)return;
  m.g.selectAll("path.state").each(function(){
    const st=this.getAttribute("data-st");
    if(!st||!DATA[mk]?.ratios[st]){this.style.fill="#e5e7eb";return;}
    const pp=STATE_POLL_SRC.byModeState?.[mk]?.[st];
    if(!pp||!pp.length){this.style.fill="#f3f4f6";return;}
    const w=Math.min(STATE_POLL_SRC.window||6,pp.length);
    let sD=0,sR=0;for(let i=pp.length-w;i<pp.length;i++){sD+=pp[i].D;sR+=pp[i].R;}
    this.style.fill=interpColor((sR/w)-(sD/w));
  });
}

/* ---- State Selection ---- */
function pickState(mk,usps){
  PSEL[mk]=usps;
  const ui=PUI[mk]; if(!ui)return;
  // Highlight
  const m=PMAP[mk];
  if(m?.g) m.g.selectAll("path.state")
    .attr("stroke",function(){return this.getAttribute("data-st")===usps?"var(--ink)":"white";})
    .attr("stroke-width",function(){return this.getAttribute("data-st")===usps?2.5:1;});

  // Update big numbers to show this state's poll average
  const pp=STATE_POLL_SRC.byModeState?.[mk]?.[usps];
  if(pp&&pp.length){
    const w=Math.min(STATE_POLL_SRC.window||6,pp.length);
    let sD=0,sR=0;for(let i=pp.length-w;i<pp.length;i++){sD+=pp[i].D;sR+=pp[i].R;}
    const avgD=sD/w, avgR=sR/w;
    setNum(ui,avgD.toFixed(0),avgR.toFixed(0),"D","R");
    colorTop(ui,avgD>avgR);
  }

  const name=USPS_TO_NAME[usps]||usps;
  if(ui.stTitle)ui.stTitle.textContent=`${name} — ${mk==="senate"?"Senate":"Governor"} polls`;
  stateScatter(mk,usps);
}

function stateScatter(mk,usps){
  const ui=PUI[mk]; const el=ui?.stChart; if(!el)return;
  const polls=(STATE_POLL_SRC.byModeState?.[mk]?.[usps]||[]).map(p=>({date:p.date,a:+p.D,b:+p.R})).sort((a,b)=>a.date-b.date);
  const r=el.getBoundingClientRect();
  const W=Math.max(320,Math.floor(r.width||400)),H=Math.max(180,Math.floor(r.height||220));
  const svg=d3.select(el); svg.selectAll("*").remove(); svg.attr("viewBox",`0 0 ${W} ${H}`);
  const mg={l:38,r:10,t:10,b:26},iw=W-mg.l-mg.r,ih=H-mg.t-mg.b;
  if(!polls.length){svg.append("text").attr("x",W/2).attr("y",H/2).attr("text-anchor","middle").attr("fill","#6b7280").attr("font-size","12px").attr("font-weight","600").text("No polls for this state");return;}
  const av=polls.flatMap(d=>[d.a,d.b]);
  const yMn=Math.max(0,d3.min(av)-3),yMx=Math.min(100,d3.max(av)+3);
  const x=d3.scaleTime().domain(d3.extent(polls,d=>d.date)).range([mg.l,mg.l+iw]);
  const y=d3.scaleLinear().domain([yMn,yMx]).range([mg.t+ih,mg.t]).nice();
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${mg.t+ih})`).call(d3.axisBottom(x).ticks(Math.min(6,iw/90|0)).tickFormat(d3.timeFormat("%b %d")));
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d=>`${d}%`));
  if(y.domain()[0]<=50&&y.domain()[1]>=50) svg.append("line").attr("x1",mg.l).attr("x2",mg.l+iw).attr("y1",y(50)).attr("y2",y(50)).attr("class","seatMajLine");
  const cs=getComputedStyle(document.documentElement);
  const blue=cs.getPropertyValue("--blue").trim()||"#2563eb",red=cs.getPropertyValue("--red").trim()||"#dc2626";
  svg.selectAll(".dD").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.a)).attr("r",3.5).attr("fill",blue).attr("opacity",.5);
  svg.selectAll(".dR").data(polls).join("circle").attr("cx",d=>x(d.date)).attr("cy",d=>y(d.b)).attr("r",3.5).attr("fill",red).attr("opacity",.5);
  if(polls.length>=3){
    const wn=Math.min(6,polls.length),ag=[];
    for(let i=0;i<polls.length;i++){const lo=Math.max(0,i-wn+1);let sA=0,sB=0;for(let j=lo;j<=i;j++){sA+=polls[j].a;sB+=polls[j].b;}const c=i-lo+1;ag.push({date:polls[i].date,a:sA/c,b:sB/c});}
    const la=d3.line().x(d=>x(d.date)).y(d=>y(d.a)).curve(d3.curveMonotoneX);
    const lb=d3.line().x(d=>x(d.date)).y(d=>y(d.b)).curve(d3.curveMonotoneX);
    svg.append("path").datum(ag).attr("d",la).attr("fill","none").attr("stroke",blue).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
    svg.append("path").datum(ag).attr("d",lb).attr("fill","none").attr("stroke",red).attr("stroke-width",2.5).attr("stroke-linejoin","round").attr("stroke-linecap","round");
  }
  const dot=svg.append("circle").attr("r",4).attr("fill",blue).style("opacity",0);
  const bis=d3.bisector(d=>d.date).left;
  svg.append("rect").attr("x",mg.l).attr("y",mg.t).attr("width",iw).attr("height",ih).style("fill","transparent").style("cursor","crosshair")
    .on("mousemove",ev=>{if(!polls.length)return;const[mx]=d3.pointer(ev);const xd=x.invert(mx);const i=clamp(bis(polls,xd),1,polls.length-1);const a=polls[i-1],b=polls[i];const d=(xd-a.date)>(b.date-xd)?b:a;dot.attr("cx",x(d.date)).attr("cy",y(d.a)).style("opacity",1);showSimTip(ev,`<div class="stDate">${ds(d.date)}</div><div class="stRow"><span class="stDot" style="background:${blue}"></span><span class="stLbl">D</span><span class="stVal">${d.a.toFixed(1)}%</span></div><div class="stRow"><span class="stDot" style="background:${red}"></span><span class="stLbl">R</span><span class="stVal">${d.b.toFixed(1)}%</span></div>`);})
    .on("mouseleave",()=>{dot.style("opacity",0);hideSimTip();});
}

/* ======== RESIZE ======== */
window.addEventListener("resize",()=>{
  if(!pollsInited)return;
  try{renderLeft();}catch(e){}
  for(const mk of["senate","governor"]){
    if(PSEL[mk])try{stateScatter(mk,PSEL[mk]);}catch(e){}
  }
},{passive:true});

window.initPollsPage=initPollsPage;
})();
