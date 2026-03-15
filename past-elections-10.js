/* ==========================================================
   past-elections.js  v3
   Hindcast tab — same model pipeline as forecast.js
   Loads from CSV (ratios/GB/polls) + JSON (precomputed odds)
   ========================================================== */
(function(){
"use strict";
console.log("past-elections.js v3 — model-pipeline hindcast");

const YEARS = [2024,2022,2020,2018,2016,2014,2012,2010,2008,2006,2004,2002,2000];
const PAST_MODES = ["president","senate","governor","house"];

let pastInited = false;
let pastYear = 2024;
let PAST_STATE_GEO = null;

/* ---------- Seat rules per year ---------- */
const SEAT_RULES = {
  2024: {
    president: { total:538, majorityLine:270, baseR:0, baseD:0 },
    senate:    { total:100, majorityLine:50,  baseD:28, baseR:39 },
    governor:  { total:50,  majorityLine:26,  baseD:20, baseR:19 },
    house:     { total:435, majorityLine:218, baseR:0,  baseD:0  }
  }
};

/* ---------- Electoral votes per state (2024 apportionment) ---------- */
const EV = {
  AL:9,AK:3,AZ:11,AR:6,CA:54,CO:10,CT:7,DE:3,DC:3,FL:30,GA:16,HI:4,ID:4,IL:19,
  IN:11,IA:6,KS:6,KY:8,LA:8,ME:4,MD:10,MA:11,MI:15,MN:10,MS:6,MO:10,MT:4,NE:5,
  NV:6,NH:4,NJ:14,NM:5,NY:28,NC:16,ND:3,OH:17,OK:7,OR:8,PA:19,RI:4,SC:9,SD:3,
  TN:11,TX:40,UT:6,VT:3,VA:13,WA:12,WV:4,WI:10,WY:3
};

/* ---------- States that had races in 2024 (filter for senate/governor) ---------- */
const RACES_2024 = {
  president: null, // all states
  senate: new Set(["AZ","CA","CT","DE","FL","HI","IN","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NJ","NM","NY","ND","OH","PA","RI","TN","TX","UT","VT","VA","WA","WV","WI","WY"]),
  governor: new Set(["DE","IN","MO","MT","NC","NH","ND","UT","VT","WA","WV"]),
  house: null // all districts
};

/* ---------- Weights (same as forecast.js) ---------- */
const WEIGHTS = { gb:35, polls:50, ind:15 };
const PROB_ERROR_SD_PTS = 7;

/* ---------- Reuse FIPS / USPS from forecast.js if available ---------- */
const _FIPS = (typeof FIPS_TO_USPS !== "undefined") ? FIPS_TO_USPS : {1:"AL",2:"AK",4:"AZ",5:"AR",6:"CA",8:"CO",9:"CT",10:"DE",11:"DC",12:"FL",13:"GA",15:"HI",16:"ID",17:"IL",18:"IN",19:"IA",20:"KS",21:"KY",22:"LA",23:"ME",24:"MD",25:"MA",26:"MI",27:"MN",28:"MS",29:"MO",30:"MT",31:"NE",32:"NV",33:"NH",34:"NJ",35:"NM",36:"NY",37:"NC",38:"ND",39:"OH",40:"OK",41:"OR",42:"PA",44:"RI",45:"SC",46:"SD",47:"TN",48:"TX",49:"UT",50:"VT",51:"VA",53:"WA",54:"WV",55:"WI",56:"WY"};
const _NAMES = (typeof USPS_TO_NAME !== "undefined") ? USPS_TO_NAME : {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};
function _fips(id){ return _FIPS[parseInt(id,10)] || ""; }

/* ---------- Math (mirrored from forecast.js) ---------- */
const clamp = (x,a,b) => Math.max(a, Math.min(b, x));
function normalizePair(D, R){
  const d = Number(D), r = Number(R);
  const s = d + r;
  if (!isFinite(s) || s <= 0) return {D:50, R:50};
  return {D: 100*d/s, R: 100*r/s};
}
function marginRD(pair){ return pair.R - pair.D; }
function winProbFromMargin(m){
  const z = m / PROB_ERROR_SD_PTS;
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const erf = 1 - ((((a5*t + a4)*t + a3)*t + a2)*t + a1) * t * Math.exp(-x*x);
  const cdf = 0.5 * (1 + sign * erf);
  return { pR: cdf, pD: 1 - cdf };
}
function formatMarginDR(m){
  if (!isFinite(m)) return "—";
  const a = Math.abs(m);
  if (a < 0.05) return "Tied";
  return (m < 0) ? `D+${a.toFixed(1)}` : `R+${a.toFixed(1)}`;
}
function marginColor(m){
  if (!isFinite(m)) return "#e5e7eb";
  const max = 25;
  const a = Math.abs(m);
  // Under 2 pts: tossup yellow
  if (a < 2.0) return "rgb(253,224,71)";
  const t = clamp(a/max, 0, 1);
  if (m < 0){
    const r = Math.round(248*(1-t) + 37*t);
    const g = Math.round(250*(1-t) + 99*t);
    const b = Math.round(252*(1-t) + 235*t);
    return `rgb(${r},${g},${b})`;
  } else {
    const r = Math.round(252*(1-t) + 220*t);
    const g = Math.round(250*(1-t) + 38*t);
    const b = Math.round(250*(1-t) + 38*t);
    return `rgb(${r},${g},${b})`;
  }
}
function median(arr){
  const a = arr.filter(x=>isFinite(x)).slice().sort((x,y)=>x-y);
  const n = a.length;
  if (!n) return NaN;
  const mid = Math.floor(n/2);
  return (n%2===1) ? a[mid] : (a[mid-1]+a[mid])/2;
}
function erf(x){
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  return sign * (1 - ((((a5*t + a4)*t + a3)*t + a2)*t + a1) * t * Math.exp(-ax*ax));
}
function toNum(v){ const n = Number(String(v||"").trim()); return isFinite(n) ? n : NaN; }
function parseDate(s){
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
}
function ds(d){
  if (!d) return "";
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${mo[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/* ---------- Per-year data store (same shape as forecast.js DATA) ---------- */
const PAST_DATA = {};  // PAST_DATA[year][mode] = { gb, ratios, polls }
const PAST_ODDS = {};  // PAST_ODDS[year][mode] = [{date, pDem, expDem}]
const PAST_HIST = {};  // PAST_HIST[year][mode] = latestHist array
const PAST_IND  = {};  // PAST_IND[year][mode] = indicator national

/* ---------- Model computation (identical to forecast.js) ---------- */
function computeGB(gb, ratio){ return normalizePair(gb.D * ratio.D, gb.R * ratio.R); }
function computePoll(poll){
  if (!poll) return null;
  const D = Number(poll.D), R = Number(poll.R);
  if (!isFinite(D) || !isFinite(R) || (D+R)<=0) return null;
  return normalizePair(D, R);
}
function computeIndicatorNat(ratios, polls){
  const implied = [];
  for (const st of Object.keys(ratios)){
    const p = computePoll(polls[st]);
    if (!p) continue;
    const r = ratios[st];
    implied.push({ D: p.D / r.D, R: p.R / r.R });
  }
  if (!implied.length) return null;
  return normalizePair(median(implied.map(x=>x.D)), median(implied.map(x=>x.R)));
}
function computeIndicatorState(indNat, ratio){
  return normalizePair(indNat.D * ratio.D, indNat.R * ratio.R);
}
function weightedCombine(comps){
  let W=0, D=0, R=0;
  for (const c of comps){
    if (!c || !c.pair || !isFinite(c.w) || c.w<=0) continue;
    W += c.w; D += c.w * c.pair.D; R += c.w * c.pair.R;
  }
  if (W<=0) return { pair:{D:50,R:50} };
  return { pair: normalizePair(D/W, R/W) };
}

function getStateModelPast(year, mode, st){
  const d = PAST_DATA[year]?.[mode];
  if (!d) return null;
  const gb = d.gb || {D:50,R:50};
  const ratio = d.ratios[st];
  if (!ratio) return null;

  const gbPair = computeGB(gb, ratio);
  const pollRaw = d.polls[st];
  const pollPair = computePoll(pollRaw);
  const pollSigma = (pollRaw && isFinite(Number(pollRaw.S))) ? Number(pollRaw.S) : 3;

  const indNat = PAST_IND[year]?.[mode] ?? computeIndicatorNat(d.ratios, d.polls);
  const indPair = indNat ? computeIndicatorState(indNat, ratio) : null;

  let wGb = WEIGHTS.gb, wPolls = WEIGHTS.polls, wInd = WEIGHTS.ind;
  // Circuit breaker: this state's poll ÷ ratio = its implied national environment.
  // If that implies >=70% for either party, polls dominate.
  if (pollPair && ratio) {
    const stateImpliedNat = normalizePair(pollPair.D / ratio.D, pollPair.R / ratio.R);
    if (Math.max(stateImpliedNat.D, stateImpliedNat.R) >= 70){
      wPolls = 80; wGb = 15; wInd = 5;
    }
  }

  const comps = [
    { pair: gbPair,   w: wGb },
    { pair: pollPair, w: pollPair ? wPolls : 0 },
    { pair: indPair,  w: indPair ? wInd : 0 },
  ];
  const combined = weightedCombine(comps);
  const mFinal = marginRD(combined.pair);
  const winProb = winProbFromMargin(mFinal);

  return { gbPair, pollPair, indPair, combinedPair: combined.pair, winProb, mFinal };
}

/* ---------- UI refs ---------- */
const PAST_UI = {};

function getPastUI(){
  for (const mode of PAST_MODES){
    const col = document.querySelector(`.modeCol[data-past-mode="${mode}"]`);
    if (!col) continue;
    PAST_UI[mode] = {
      col,
      pillD:     col.querySelector("[data-past-pill-d]"),
      pillR:     col.querySelector("[data-past-pill-r]"),
      seatsD:    col.querySelector("[data-past-seats-d]"),
      seatsR:    col.querySelector("[data-past-seats-r]"),
      simCanvas: col.querySelector("[data-past-sim]"),
      svgEl:     col.querySelector(".mapSvg"),
      comboSvg:  col.querySelector("[data-past-combo]"),
      ylabel:    col.querySelector("[data-past-ylabel]"),
      status:    col.querySelector("[data-past-status]"),
      topCard:   col.querySelector(".topCard"),
      _chartMode: "prob"
    };
  }
}

/* ---------- CSV + JSON loaders ---------- */
const GB_WINDOW = 20;

function rollingAvg(polls, n){
  if (!polls || !polls.length) return null;
  const last = polls.slice(-n);
  const dSum = last.reduce((s,p) => s + p.dem, 0);
  const rSum = last.reduce((s,p) => s + p.rep, 0);
  return normalizePair(dSum / last.length, rSum / last.length);
}

async function loadPastEntries(year){
  const file = `${year}_entries.csv`;


  try {
    const txt = await fetch(file, {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
    const rows = d3.csvParse(txt);
    if (!PAST_DATA[year]) PAST_DATA[year] = {};

    for (const mode of PAST_MODES){
      if (!PAST_DATA[year][mode]) PAST_DATA[year][mode] = { gb:null, ratios:{}, polls:{} };
    }

    for (const row of rows){
      const mode = String(row.mode || "").trim().toLowerCase();
      if (!PAST_DATA[year][mode]) continue;
      const st = String(row.state || "").trim().toUpperCase();
      const ratioD = toNum(row.ratioD), ratioR = toNum(row.ratioR);
      if (st && isFinite(ratioD) && isFinite(ratioR)){
        // Only load contested races for senate/governor
        const filter = RACES_2024[mode];
        if (filter && !filter.has(st)) continue;
        PAST_DATA[year][mode].ratios[st] = {D: ratioD, R: ratioR};
      }








    }
    console.log(`Loaded past entries for ${year}: ${rows.length} rows`);
    return true;
  } catch(e){
    console.warn(`Could not load ${file}:`, e);
    return false;
  }
}

async function loadPastPresidentialPolls(year){
  const file = `${year}_presidential_polls.json`;
  try {
    const j = await fetch(file, {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const polls = (j.polls || []).map(p => ({
      date: p.end_date, dem: +p.dem, rep: +p.rep
    })).filter(p => p.date && isFinite(p.dem) && isFinite(p.rep))
      .sort((a,b) => a.date.localeCompare(b.date));

    if (!PAST_DATA[year]) PAST_DATA[year] = {};
    if (!PAST_DATA[year].president) PAST_DATA[year].president = { gb:null, ratios:{}, polls:{} };
    const gb = rollingAvg(polls, GB_WINDOW);
    if (gb) PAST_DATA[year].president.gb = gb;
    console.log(`Loaded ${polls.length} presidential polls for ${year}, GB: D=${gb?.D?.toFixed(1)} R=${gb?.R?.toFixed(1)}`);
    return polls;
  } catch(e){
    console.warn(`Could not load ${file}:`, e);
    return [];
  }
}

async function loadPastGBPolls(year){
  const file = `${year}_gb_polls.json`;
  try {
    const j = await fetch(file, {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const polls = (j.genericBallot || []).map(p => ({
      date: p.end_date, dem: +p.dem, rep: +p.rep
    })).filter(p => p.date && isFinite(p.dem) && isFinite(p.rep))
      .sort((a,b) => a.date.localeCompare(b.date));

    if (!PAST_DATA[year]) PAST_DATA[year] = {};
    const gb = rollingAvg(polls, GB_WINDOW);
    for (const mode of ["senate","governor","house"]){
      if (!PAST_DATA[year][mode]) PAST_DATA[year][mode] = { gb:null, ratios:{}, polls:{} };
      if (gb) PAST_DATA[year][mode].gb = gb;
    }
    console.log(`Loaded ${polls.length} GB polls for ${year}, GB: D=${gb?.D?.toFixed(1)} R=${gb?.R?.toFixed(1)}`);
    return polls;
  } catch(e){
    console.warn(`Could not load ${file}:`, e);
    return [];
  }
}

async function loadPastStatePolls(year){
  const file = `${year}_state_presidential_polls.csv`;
  try {
    const txt = await fetch(file, {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
    const rows = d3.csvParse(txt);
    if (!PAST_DATA[year]) PAST_DATA[year] = {};

    const byModeState = {};
    for (const row of rows){
      const mode = String(row.mode || "").trim().toLowerCase();
      const st = String(row.state || "").trim().toUpperCase();
      if (!mode || !st) continue;
      if (st === "ME" && mode === "senate") continue; // Maine senate has independent (King), disregard
      const dem = toNum(row.dem), rep = toNum(row.rep);
      if (!isFinite(dem) || !isFinite(rep)) continue;
      const key = `${mode}|${st}`;
      if (!byModeState[key]) byModeState[key] = [];
      byModeState[key].push({ date: row.date, dem, rep, sigma: toNum(row.sigma) || 3 });
    }

    let count = 0;
    for (const [key, polls] of Object.entries(byModeState)){
      const [mode, st] = key.split("|");
      if (!PAST_DATA[year][mode]) continue;
      polls.sort((a,b) => a.date.localeCompare(b.date));
      const last = polls.slice(-6);
      const avgD = last.reduce((s,p) => s + p.dem, 0) / last.length;
      const avgR = last.reduce((s,p) => s + p.rep, 0) / last.length;
      const avgS = last.reduce((s,p) => s + p.sigma, 0) / last.length;
      PAST_DATA[year][mode].polls[st] = { D: avgD, R: avgR, S: avgS };
      count++;
    }
    console.log(`Loaded state polls for ${year}: ${rows.length} rows → ${count} state averages`);
    return true;
  } catch(e){
    console.warn(`Could not load ${file}:`, e);
    return false;
  }
}

async function loadPastOdds(year, mode){


  const file = `json/past/${year}_${mode}_odds.json`;
  try {
    const j = await fetch(file, {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    if (!PAST_ODDS[year]) PAST_ODDS[year] = {};
    if (!PAST_HIST[year]) PAST_HIST[year] = {};
    PAST_ODDS[year][mode] = j.results || [];
    if (j.latestHist) PAST_HIST[year][mode] = j.latestHist;
    return true;
  } catch(e){
    console.warn(`Could not load ${file}:`, e);
    return false;
  }
}

/* ---------- Year selector ---------- */
function initYearSelector(){
  const wrap = document.querySelector("[data-past-year-bar]");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const y of YEARS){
    const btn = document.createElement("button");
    btn.className = "yearBtn" + (y === pastYear ? " active" : "");
    btn.textContent = y;
    if (y !== 2024) btn.classList.add("disabled");
    btn.addEventListener("click", () => {
      if (y !== 2024) return;
      pastYear = y;
      wrap.querySelectorAll(".yearBtn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderPastYear(y);
    });
    wrap.appendChild(btn);
  }
}

/* ---------- Render year ---------- */
async function renderPastYear(year){
  // Load ratios
  await loadPastEntries(year);
  // Load national polls → GB
  await loadPastPresidentialPolls(year);
  await loadPastGBPolls(year);
  // Load state polls
  await loadPastStatePolls(year);

  // Precompute indicator nationals
  if (!PAST_IND[year]) PAST_IND[year] = {};
  for (const m of PAST_MODES){
    const dd = PAST_DATA[year]?.[m];
    if (dd) PAST_IND[year][m] = computeIndicatorNat(dd.ratios, dd.polls);
  }

  // Try precomputed odds
  for (const mode of PAST_MODES) await loadPastOdds(year, mode);

  const rules = SEAT_RULES[year] || {};
  const raceFilters = RACES_2024;

  for (const mode of PAST_MODES){
    const ui = PAST_UI[mode];
    if (!ui) continue;
    const d = PAST_DATA[year]?.[mode];
    const odds = PAST_ODDS[year]?.[mode];
    const hist = PAST_HIST[year]?.[mode];
    const rule = rules[mode] || { total:0, majorityLine:0 };
    const raceFilter = raceFilters[mode];

    // Seat tally: binary call per state, matching forecast.js computeSeatTally
    const allStates = Object.keys(d?.ratios || {});
    const contested = raceFilter ? allStates.filter(st => raceFilter.has(st)) : allStates;
    const baseD = rule.baseD || 0;
    const baseR = rule.baseR || 0;

    let winsD = 0, winsR = 0, toss = 0;
    // For win probability: collect per-state pD and weight
    const pDems = [];
    const weights = [];

    for (const st of contested){
      const model = getStateModelPast(year, mode, st);
      if (!model) continue;
      const m = model.mFinal;
      const w = (mode === "president") ? (EV[st] || 1) : 1;

      // Binary seat call (same as forecast.js)
      if (!isFinite(m)) continue;
      if (Math.abs(m) < 1e-9){ winsD += w; toss += w; }
      else if (m < 0) winsD += w;  // D leads
      else winsR += w;             // R leads

      // Probabilistic for win prob calc
      pDems.push(model.winProb.pD);
      weights.push(w);
    }



    const totalD = baseD + winsD;
    const totalR = baseR + winsR;

    // Overall win probability (weighted normal approximation)
    let expSum = baseD, varSum = 0;
    for (let i = 0; i < pDems.length; i++){
      expSum += pDems[i] * weights[i];
      varSum += pDems[i] * (1 - pDems[i]) * weights[i] * weights[i];











    }
    const maj = rule.majorityLine;
    const sd = Math.sqrt(varSum) || 1;
    const zDem = (expSum - maj) / sd;
    const overallPDem = 0.5 * (1 + erf(zDem / Math.SQRT2));
    const overallPRep = 1 - overallPDem;

    // Pills = win probability (prefer precomputed MC odds for all modes)
    // Senate odds already include VP tiebreaker blending from compute step
    let pillPDem = overallPDem, pillPRep = overallPRep;
    if (odds && odds.length){
      const latest = odds[odds.length - 1];
      const mc = +latest.pDem;
      if (isFinite(mc)){ pillPDem = mc; pillPRep = 1 - mc; }
    }
    if (ui.pillD) ui.pillD.textContent = (pillPDem * 100).toFixed(1);
    if (ui.pillR) ui.pillR.textContent = (pillPRep * 100).toFixed(1);

    // Seats = binary tally
    if (ui.seatsD) ui.seatsD.textContent = totalD;
    if (ui.seatsR) ui.seatsR.textContent = totalR;

    // Lead color
    if (ui.topCard){
      ui.topCard.classList.remove("leads-d","leads-r");
      if (pillPDem > 0.5) ui.topCard.classList.add("leads-d");
      else ui.topCard.classList.add("leads-r");
    }


    renderPastSim(mode, hist, rule);
    renderPastMap(year, mode, d, rule, raceFilter);





    if (odds && odds.length){
      renderPastComboChart(mode, odds, rule);
      if (ui.status) ui.status.textContent = `${odds.length} days · ${year} hindcast`;
      if (ui.status) ui.status.style.display = "block";
    } else {
      if (ui.status) ui.status.textContent = `Awaiting precomputed odds`;
      if (ui.status) ui.status.style.display = "block";
    }
  }
}

/* ---------- Histogram transforms (client-side re-binning) ---------- */
function rebinHist(hist, newBinSize){
  // Re-bin a binSize=1 range hist into larger bins
  const counts = hist.counts;
  const oldMin = hist.min ?? 0;
  const oldBs = hist.binSize || 1;
  const oldTotal = hist.total || counts.reduce((a,b)=>a+b,0);

  // Snap min down to nearest newBinSize boundary
  const newMin = Math.floor(oldMin / newBinSize) * newBinSize;
  const oldMax = oldMin + (counts.length - 1) * oldBs;
  const newMax = Math.floor(oldMax / newBinSize) * newBinSize;
  const nBins = Math.floor((newMax - newMin) / newBinSize) + 1;
  const newCounts = new Array(nBins).fill(0);

  for (let i = 0; i < counts.length; i++){
    const seatVal = oldMin + i * oldBs;
    const idx = Math.floor((seatVal - newMin) / newBinSize);
    if (idx >= 0 && idx < nBins) newCounts[idx] += counts[i];
  }

  return { counts: newCounts, min: newMin, max: newMin + (nBins-1)*newBinSize + (newBinSize-1),
           isProb: false, total: oldTotal, binSize: newBinSize };
}

function expandRangeHist(hist, newMin, newMax){
  // Expand a binSize=1 hist to a wider range, filling zeros for missing bins
  const counts = hist.counts;
  const oldMin = hist.min ?? 0;
  const oldTotal = hist.total || counts.reduce((a,b)=>a+b,0);
  const n = newMax - newMin + 1;
  const newCounts = new Array(n).fill(0);

  for (let i = 0; i < counts.length; i++){
    const seatVal = oldMin + i;
    const idx = seatVal - newMin;
    if (idx >= 0 && idx < n) newCounts[idx] += counts[i];
  }

  return { counts: newCounts, min: newMin, max: newMax, isProb: false, total: oldTotal, binSize: 1 };
}

function prepareHist(mode, histData){
  if (!histData || !histData.counts) return histData;
  if (mode === "president" && (histData.binSize || 1) === 1){
    return rebinHist(histData, 10);
  }
  if (mode === "senate" && (histData.binSize || 1) === 1){
    return expandRangeHist(histData, 40, 55);
  }
  return histData;
}

/* ---------- Simulation histogram (mirrors forecast.js drawSeatSimMini) ---------- */
function renderPastSim(mode, histData, rule){
  const canvas = PAST_UI[mode]?.simCanvas;
  if (!canvas || !histData) return;

  // Client-side re-bin/range adjustment
  const hist = prepareHist(mode, histData);
  const counts = hist?.counts;
  if (!counts || !counts.length) return;

  const cssW = canvas.clientWidth || 0;
  const cssH = canvas.clientHeight || 0;
  if (cssW <= 2 || cssH <= 2) return;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(cssW * dpr);
  const h = Math.floor(cssH * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,w,h);

  const n = counts.length || 1;
  const maxCount = Math.max(...counts) || 1;

  const padTop = Math.floor(2*dpr);
  const padBot = Math.floor(3*dpr);
  const availH = Math.max(1, h - padTop - padBot);
  const barW = w / n;

  const cs = getComputedStyle(document.documentElement);
  const blue = cs.getPropertyValue("--blue").trim() || "#2563eb";
  const red  = cs.getPropertyValue("--red").trim()  || "#dc2626";
  const lineCol = "rgba(31,41,55,0.35)";

  const bs = (hist.binSize && isFinite(hist.binSize)) ? hist.binSize : 1;
  const minBin = hist.min ?? 0;
  const thr = rule.majorityLine;

  ctx.globalAlpha = 0.82;
  const radius = Math.max(1, Math.round(1.5 * dpr));

  for (let i = 0; i < n; i++){
    const frac = counts[i] / maxCount;
    const bh = Math.max(1, Math.round(frac * availH));
    const x = Math.floor(i * barW);
    const y = h - padBot - bh;
    const bw = Math.max(1, Math.ceil(barW - 1*dpr));

    const seatVal = minBin + i * bs;
    ctx.fillStyle = (isFinite(thr) && seatVal >= thr) ? blue : red;

    // Rounded top corners
    const r = Math.min(radius, bw/2, bh);
    ctx.beginPath();
    ctx.moveTo(x, y + bh);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + bw - r, y);
    ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
    ctx.lineTo(x + bw, y + bh);
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalAlpha = 1;

  // Control threshold line
  if (isFinite(thr)){
    const boundary = (thr - minBin) / (bs * n);
    const x = Math.round(clamp(boundary, 0, 1) * w);
    ctx.strokeStyle = lineCol;
    ctx.lineWidth = Math.max(1, Math.round(1*dpr));
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, h - padBot);
    ctx.stroke();
  }

  // Store transformed hist for hover
  const total = hist.total || counts.reduce((a,b)=>a+b,0) || 1;
  canvas._simMeta = { hist, threshold: thr, total };
  ensurePastSimHover(canvas);
}

function ensurePastSimHover(canvas){
  if (!canvas || canvas._pastSimHoverAttached) return;
  canvas._pastSimHoverAttached = true;

  canvas.addEventListener("mousemove", (ev)=>{
    const meta = canvas._simMeta;
    if (!meta || !meta.hist || !meta.hist.counts) return hidePastSimTip();

    const hist = meta.hist;
    const counts = hist.counts;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const n = counts.length || 1;
    let idx = Math.floor((x / rect.width) * n);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;

    const total = meta.total || counts.reduce((a,b)=>a+b,0) || 1;
    const pct = (counts[idx] / total) * 100;

    const bs = (hist.binSize && isFinite(hist.binSize)) ? hist.binSize : 1;
    const startSeat = (hist.min ?? 0) + idx * bs;
    const endSeat = startSeat + (bs - 1);
    const seatLabel = (bs > 1) ? `${startSeat}–${endSeat}` : `${startSeat}`;

    showPastSimTip(ev,
      `<div class="stDate">${seatLabel} D seats</div>` +
      `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stVal">${pct.toFixed(1)}%</span></div>`
    );
  });

  canvas.addEventListener("mouseleave", hidePastSimTip);
}

/* ---------- Map ---------- */
async function loadPastStateGeo(){
  if (PAST_STATE_GEO) return PAST_STATE_GEO;
  if (typeof STATE_GEO !== "undefined" && STATE_GEO){ PAST_STATE_GEO = STATE_GEO; return PAST_STATE_GEO; }
  const topo = await fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json").then(r=>r.json());
  PAST_STATE_GEO = topojson.feature(topo, topo.objects.states);
  return PAST_STATE_GEO;
}

async function renderPastMap(year, mode, d, rule, raceFilter){
  const ui = PAST_UI[mode];
  if (!ui?.svgEl) return;
  const geo = await loadPastStateGeo();
  const width = 960, height = 600;
  const svg = d3.select(ui.svgEl);
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  const projection = d3.geoAlbersUsa();
  projection.fitExtent([[18,18],[width-18,height-18]], geo);
  const pathGen = d3.geoPath(projection);
  svg.selectAll("*").remove();
  const gRoot = svg.append("g");

  function isContested(st){
    if (!raceFilter) return true; // null = all states (president/house)
    return raceFilter.has(st);
  }

  gRoot.selectAll("path")
    .data(geo.features)
    .join("path")
    .attr("class", dd => {
      const st = _fips(dd.id);
      return (st && d?.ratios[st] && isContested(st)) ? "state active" : "state";
    })
    .attr("data-st", dd => _fips(dd.id))
    .attr("d", dd => pathGen(dd))
    .attr("fill", dd => {
      const st = _fips(dd.id);
      if (!st || !d?.ratios[st] || !isContested(st)) return "#e5e7eb";
      const model = getStateModelPast(year, mode, st);
      if (!model) return "#e5e7eb";
      return marginColor(model.mFinal);
    })
    .on("mouseenter", (event, dd) => {
      const st = _fips(dd.id);
      if (!st || !d?.ratios[st] || !isContested(st)) return;
      d3.select(event.currentTarget).classed("hovered", true);
      showPastTip(event, year, mode, st);
    })
    .on("mousemove", (event) => positionPastTip(event))
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).classed("hovered", false);
      hidePastTip();
    });
}

/* ---------- Tooltip (model factors — same as Model tab) ---------- */
function showPastTip(event, year, mode, st){
  const tip = document.getElementById("pastTip");
  if (!tip) return;

  const model = getStateModelPast(year, mode, st);
  if (!model) return;

  const name = _NAMES[st] || st;
  const mFinal = model.mFinal;
  const side = mFinal < 0 ? "D" : "R";
  const sideColor = mFinal < 0 ? "blue" : "red";
  const pD = model.winProb.pD;
  const pR = model.winProb.pR;
  const probPct = (mFinal < 0 ? pD : pR) * 100;

  const gbM = marginRD(model.gbPair);
  const pollM = model.pollPair ? marginRD(model.pollPair) : NaN;
  const indM = model.indPair ? marginRD(model.indPair) : NaN;

  function miniBar(m){
    if (!isFinite(m)) return "";
    const pct = clamp(50 + m * 1.5, 2, 98);
    const col = m < 0 ? "blue" : "red";
    const left = Math.min(50, pct), w = Math.abs(pct - 50);
    return `<div class="miniBar"><div class="miniZero"></div><div class="miniFill ${col}" style="left:${left}%;width:${w}%"></div><div class="miniDot ${col}" style="left:${pct}%"></div></div>`;
  }

  tip.innerHTML =
    `<div class="tipTop"><div class="tipHeader"><div>`+
    `<p class="tipTitle" style="margin:0">${name} (${st})</p>`+
    `<div class="tipSub" style="margin-top:6px">`+
    `<span class="badge"><span class="dot ${sideColor}"></span>${side}+${Math.abs(mFinal).toFixed(1)}</span>`+
    `<span class="badge"><span class="dot ${sideColor}"></span>${side} ${probPct.toFixed(0)}%</span>`+
    `</div></div>`+
    `<div class="tipMeta">D ${model.combinedPair.D.toFixed(1)} · R ${model.combinedPair.R.toFixed(1)}</div>`+
    `</div></div>`+
    `<div class="tipBody">`+
    `<div class="miniRow"><div class="miniLbl">Generic Ballot</div><div class="miniVal">${formatMarginDR(gbM)}</div>${miniBar(gbM)}</div>`+
    (isFinite(pollM) ? `<div class="miniRow"><div class="miniLbl">Polls</div><div class="miniVal">${formatMarginDR(pollM)}</div>${miniBar(pollM)}</div>` : "")+
    (isFinite(indM) ? `<div class="miniRow"><div class="miniLbl">National Trend</div><div class="miniVal">${formatMarginDR(indM)}</div>${miniBar(indM)}</div>` : "")+
    `<div class="miniRow"><div class="miniLbl">Final</div><div class="miniVal">${formatMarginDR(mFinal)}</div>${miniBar(mFinal)}</div>`+
    `</div>`;

  positionPastTip(event);
  tip.style.opacity = "1";
}

function positionPastTip(event){
  const tip = document.getElementById("pastTip");
  if (!tip) return;
  const pad = 14;
  let x = event.clientX + pad, y = event.clientY + pad;
  const tr = tip.getBoundingClientRect();
  if (x + tr.width > window.innerWidth - 8) x = event.clientX - tr.width - pad;
  if (y + tr.height > window.innerHeight - 8) y = event.clientY - tr.height - pad;
  tip.style.transform = `translate(${x}px,${y}px)`;
}

function hidePastTip(){
  const tip = document.getElementById("pastTip");
  if (tip){ tip.style.transform = "translate(-9999px,-9999px)"; tip.style.opacity = "0"; }
}

/* ---------- Combo chart (Win Prob / Seats — identical to forecast.js renderComboChart) ---------- */
function renderPastComboChart(mode, data, rule, chartMode){
  const ui = PAST_UI[mode];
  const svgEl = ui?.comboSvg;
  if (!svgEl) return;

  ui._lastOdds = data;
  const cMode = chartMode || ui._chartMode || "prob";
  ui._chartMode = cMode;

  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(200, Math.floor(rect.width || 360));
  const height = Math.max(100, Math.floor(rect.height || 180));
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const m = {l:34, r:8, t:8, b:20};
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;

  const parsed = (data||[]).map(d => ({
    date: parseDate(d.date),
    pDem: +d.pDem,
    pRep: 1 - (+d.pDem),
    expDem: +d.expDem
  })).filter(d => d.date && isFinite(d.pDem) && isFinite(d.expDem));
  if (!parsed.length) return;

  const x = d3.scaleTime().domain(d3.extent(parsed, d=>d.date)).range([m.l, m.l+iw]);
  const xAxis = d3.axisBottom(x).ticks(Math.min(5, Math.floor(iw/70))).tickFormat(d3.timeFormat("%b"));

  if (cMode === "seats"){
    const total = rule?.total ?? 0;
    const maj = rule?.majorityLine ?? Math.floor(total/2)+1;
    const ext = d3.extent(parsed, d=>d.expDem);
    const pad = 3;
    const yMin = clamp((ext[0]??0)-pad, 0, total||1000);
    const yMax = clamp((ext[1]??(total||0))+pad, 0, total||1000);
    const y = d3.scaleLinear().domain([yMin, yMax]).range([m.t+ih, m.t]).nice();
    const yAxis = d3.axisLeft(y).ticks(5).tickFormat(d=>`${Math.round(d)}`);

    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${m.t+ih})`).call(xAxis);
    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${m.l},0)`).call(yAxis);
    y.ticks(5).forEach(t=>{
      svg.append("line").attr("x1",m.l).attr("x2",m.l+iw).attr("y1",y(t)).attr("y2",y(t))
        .attr("stroke","var(--line)").attr("stroke-width",1).attr("stroke-dasharray","3 3").attr("opacity",0.5);
    });
    if (isFinite(maj) && maj >= y.domain()[0] && maj <= y.domain()[1]){
      svg.append("line").attr("class","seatMajLine").attr("x1",m.l).attr("x2",m.l+iw).attr("y1",y(maj)).attr("y2",y(maj));
      svg.append("text").attr("class","seatMajLabel").attr("x",m.l+iw-2).attr("y",y(maj)-4).attr("text-anchor","end").text(`${maj}`);
    }

    svg.append("path").datum(parsed).attr("class","seatsLine").attr("d",d3.line().x(d=>x(d.date)).y(d=>y(d.expDem)).curve(d3.curveMonotoneX));
    if (total > 0) svg.append("path").datum(parsed).attr("class","seatsLineR").attr("d",d3.line().x(d=>x(d.date)).y(d=>y(total-d.expDem)).curve(d3.curveMonotoneX));

    const dotD = svg.append("circle").attr("class","dotDem").attr("r",4).style("opacity",0);
    const dotR = svg.append("circle").attr("class","dotRep").attr("r",4).style("opacity",0);
    const bisect = d3.bisector(d=>d.date).left;
    svg.append("rect").attr("x",m.l).attr("y",m.t).attr("width",iw).attr("height",ih)
      .style("fill","transparent").style("cursor","crosshair")
      .on("mousemove",(ev)=>{
        const [mx]=d3.pointer(ev);const xd=x.invert(mx);
        const i=clamp(bisect(parsed,xd),1,parsed.length-1);
        const a=parsed[i-1],b=parsed[i];
        const dd=(xd-a.date)>(b.date-xd)?b:a;
        dotD.attr("cx",x(dd.date)).attr("cy",y(dd.expDem)).style("opacity",1);
        if(total>0) dotR.attr("cx",x(dd.date)).attr("cy",y(total-dd.expDem)).style("opacity",1);
        showPastSimTip(ev,
          `<div class="stDate">${ds(dd.date)}</div>`+
          `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">D</span><span class="stVal">${dd.expDem.toFixed(1)}</span></div>`+
          (total>0?`<div class="stRow"><span class="stDot" style="background:var(--red)"></span><span class="stLbl">R</span><span class="stVal">${(total-dd.expDem).toFixed(1)}</span></div>`:"")
        );
      })
      .on("mouseleave",()=>{dotD.style("opacity",0);dotR.style("opacity",0);hidePastSimTip();});

  } else {
    /* Win Prob mode */
    const y = d3.scaleLinear().domain([0,1]).range([m.t+ih, m.t]);
    const yAxis = d3.axisLeft(y).ticks(5).tickFormat(d=>`${Math.round(d*100)}%`);
    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${m.t+ih})`).call(xAxis);
    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${m.l},0)`).call(yAxis);
    y.ticks(5).forEach(t=>{
      svg.append("line").attr("x1",m.l).attr("x2",m.l+iw).attr("y1",y(t)).attr("y2",y(t))
        .attr("stroke","var(--line)").attr("stroke-width",1).attr("stroke-dasharray","3 3").attr("opacity",0.5);
    });
    svg.append("line").attr("class","seatMajLine").attr("x1",m.l).attr("x2",m.l+iw).attr("y1",y(0.5)).attr("y2",y(0.5));

    svg.append("path").datum(parsed).attr("class","lineDem").attr("d",d3.line().x(d=>x(d.date)).y(d=>y(d.pDem)).curve(d3.curveMonotoneX));
    svg.append("path").datum(parsed).attr("class","lineRep").attr("d",d3.line().x(d=>x(d.date)).y(d=>y(d.pRep)).curve(d3.curveMonotoneX));

    const dotD = svg.append("circle").attr("class","dotDem").attr("r",4).style("opacity",0);
    const dotR = svg.append("circle").attr("class","dotRep").attr("r",4).style("opacity",0);
    const bisect = d3.bisector(d=>d.date).left;
    svg.append("rect").attr("x",m.l).attr("y",m.t).attr("width",iw).attr("height",ih)
      .style("fill","transparent").style("cursor","crosshair")
      .on("mousemove",(ev)=>{
        const [mx]=d3.pointer(ev);const xd=x.invert(mx);
        const i=clamp(bisect(parsed,xd),1,parsed.length-1);
        const a=parsed[i-1],b=parsed[i];
        const dd=(xd-a.date)>(b.date-xd)?b:a;
        dotD.attr("cx",x(dd.date)).attr("cy",y(dd.pDem)).style("opacity",1);
        dotR.attr("cx",x(dd.date)).attr("cy",y(dd.pRep)).style("opacity",1);
        showPastSimTip(ev,
          `<div class="stDate">${ds(dd.date)}</div>`+
          `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">D</span><span class="stVal">${(dd.pDem*100).toFixed(1)}%</span></div>`+
          `<div class="stRow"><span class="stDot" style="background:var(--red)"></span><span class="stLbl">R</span><span class="stVal">${(dd.pRep*100).toFixed(1)}%</span></div>`
        );
      })
      .on("mouseleave",()=>{dotD.style("opacity",0);dotR.style("opacity",0);hidePastSimTip();});
  }
}

/* ---------- Sim tip ---------- */
function showPastSimTip(ev, html){
  const tip = document.getElementById("pastSimTip");
  if (!tip) return;
  tip.innerHTML = html;
  const pad = 12;

  // Measure size first
  tip.style.transform = "translate(0,0)";
  tip.style.left = "0px";
  tip.style.top  = "0px";

  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;

  let x = ev.clientX + pad;
  let y = ev.clientY + pad;

  if (x + tw + pad > window.innerWidth) x = ev.clientX - tw - pad;
  if (y + th + pad > window.innerHeight) y = ev.clientY - th - pad;

  tip.style.left = x + "px";
  tip.style.top  = y + "px";
  tip.style.transform = "";
}
function hidePastSimTip(){
  const tip = document.getElementById("pastSimTip");
  if (tip){
    tip.style.transform = "translate(-9999px,-9999px)";
    tip.style.left = "";
    tip.style.top = "";
  }
}

/* ---------- Chart tab switching ---------- */
function initPastChartTabs(){
  for (const mode of PAST_MODES){
    const col = document.querySelector(`.modeCol[data-past-mode="${mode}"]`);
    if (!col) continue;
    const tabs = col.querySelectorAll("[data-past-chart-tab]");
    const ylabel = col.querySelector("[data-past-ylabel]");
    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        const cMode = tab.dataset.pastChartTab;
        if (ylabel) ylabel.textContent = cMode === "seats" ? "Expected seats" : "Win probability";
        const odds = PAST_ODDS[pastYear]?.[mode];
        const rule = SEAT_RULES[pastYear]?.[mode];
        if (odds) renderPastComboChart(mode, odds, rule, cMode);
      });
    });
  }
}

/* ---------- Init ---------- */
window.initPastElectionsPage = function(){
  if (pastInited) return;
  pastInited = true;
  getPastUI();
  initYearSelector();
  initPastChartTabs();
  renderPastYear(2024);
};

/* ---------- Resize ---------- */
window.addEventListener("resize", () => {
  if (!pastInited) return;
  for (const mode of PAST_MODES){
    const odds = PAST_ODDS[pastYear]?.[mode];
    const rule = SEAT_RULES[pastYear]?.[mode];
    if (odds) try{ renderPastComboChart(mode, odds, rule); }catch(e){}
    const hist = PAST_HIST[pastYear]?.[mode];
    if (hist && rule) try{ renderPastSim(mode, hist, rule); }catch(e){}
  }
}, {passive:true});

})();
