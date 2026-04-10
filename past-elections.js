/* ==========================================================
   past-elections.js  v3
   Hindcast tab — same model pipeline as forecast.js
   Loads from CSV (ratios/GB/polls) + JSON (precomputed odds)
   ========================================================== */
(function(){
"use strict";
console.log("past-elections.js v3 — model-pipeline hindcast");

const YEARS = [2025,2024,2022,2020,2018,2016,2014,2012,2010,2008,2006,2004,2002,2000];
const PAST_MODES = ["president","senate","governor","house"];

let pastInited = false;
let pastYear = 2025;
let PAST_STATE_GEO = null;

/* ---------- 2025 label overrides (off-year: 3 races only) ---------- */
const LABEL_OVERRIDES = {
  2025: {
    senate:   { title: "Virginia Governor",  sub: "Spanberger (D) vs Earle-Sears (R)" },
    governor: { title: "New Jersey Governor", sub: "Sherrill (D) vs Ciattarelli (R)" },
    house:    { title: "CA Proposition 50",   sub: "Redistricting — Support vs Oppose" },
    president: null  // hidden
  }
};

/* ---------- Seat rules per year ---------- */
const SEAT_RULES = {
  2025: {
    senate:   { total:1, majorityLine:1, baseD:0, baseR:0 },
    governor: { total:1, majorityLine:1, baseD:0, baseR:0 },
    house:    { total:1, majorityLine:1, baseD:0, baseR:0 },
  },
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
const RACES = {
  2025: {
    president: new Set(),  // none
    senate:   new Set(["VA"]),
    governor: new Set(["NJ"]),
    house:    new Set(["CA"])
  },
  2024: {
  president: null, // all states
  senate: new Set(["AZ","CA","CT","DE","FL","HI","IN","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NJ","NM","NY","ND","OH","PA","RI","TN","TX","UT","VT","VA","WA","WV","WI","WY"]),
  governor: new Set(["DE","IN","MO","MT","NC","NH","ND","UT","VT","WA","WV"]),
  },
};

/* ---------- Pollster weight tiers for 2025 ---------- */
const TIER_A_2025 = new Set(["echelon","echelon insights","beacon","beacon/shaw","beacon-shaw","shaw","marquette","marist","siena"]);
const TIER_B_2025 = new Set(["emerson","emerson college","quinnipiac","quinnipiac university","atlasintel","atlas","cnn/ssrs","cbs","cbs/yougov","cbs news/yougov","fairleigh dickinson","fairleigh dickinson university","rutgers","rutgers-eagleton","zogby","john zogby","john zogby strategies","ppp","public policy polling","a2 insights","a2","beacon research","beacon research/shaw","shaw & company","washington post","washington post/schar","schar"]);
const TIER_C_2025 = new Set(["ipsos"]);
// YouGov at full weight for 2025
const TIER_YOUGOV_2025 = new Set(["yougov","cbs/yougov","cbs news/yougov"]);

function pollWeight2025(pollster){
  if(!pollster) return 0.1;
  const key = String(pollster).toLowerCase().trim();
  if(TIER_YOUGOV_2025.has(key)) return 1;
  if(TIER_A_2025.has(key)) return 1;
  if(TIER_B_2025.has(key)) return 0.75;
  if(TIER_C_2025.has(key)) return 0.25;
  return 0.1;
}

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
  if (!isFinite(m)) return getComputedStyle(document.documentElement).getPropertyValue("--neutral-bg").trim()||"#e5e7eb";
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
const PAST_RAW_POLLS = {}; // PAST_RAW_POLLS[year][mode][st] = [{date,dem,rep,sigma,pollster}]
const PAST_RAW_GB = {};    // PAST_RAW_GB[year] = [{date,dem,rep}]

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

/* ---------- Time series for single-race years ---------- */
function computePastTimeSeries(year, mode, st){
  const rawPolls = PAST_RAW_POLLS[year]?.[mode]?.[st];
  const rawGb = PAST_RAW_GB[year];
  const ratio = PAST_DATA[year]?.[mode]?.ratios?.[st];
  if (!rawPolls?.length || !ratio) return [];

  // Get unique poll dates
  const dates = [...new Set(rawPolls.map(p => p.date))].sort();
  const results = [];

  for (const dateStr of dates){
    // Polls up to this date — weighted rolling last 8
    const pollsToDate = rawPolls.filter(p => p.date <= dateStr);
    const window = pollsToDate.slice(-8);
    let wSum=0, wD=0, wR=0;
    for (const p of window){
      const w = (year === 2025) ? pollWeight2025(p.pollster) : 1;
      wSum += w; wD += w*p.dem; wR += w*p.rep;
    }
    if (wSum <= 0) continue;
    const pollPair = normalizePair(wD/wSum, wR/wSum);

    // GB at this date — find latest GB on or before this date
    let gb = null;
    if (rawGb?.length){
      for (let i = rawGb.length - 1; i >= 0; i--){
        if (rawGb[i].date <= dateStr){ gb = normalizePair(rawGb[i].dem, rawGb[i].rep); break; }
      }
      if (!gb) gb = normalizePair(rawGb[0].dem, rawGb[0].rep);
    }
    if (!gb) gb = PAST_DATA[year]?.[mode]?.gb || {D:50,R:50};

    const gbPair = computeGB(gb, ratio);

    // Indicator
    const indPair = computeIndicatorState(
      normalizePair(pollPair.D / ratio.D, pollPair.R / ratio.R), ratio
    );

    // Combine
    const combined = weightedCombine([
      { pair: gbPair, w: WEIGHTS.gb },
      { pair: pollPair, w: WEIGHTS.polls },
      { pair: indPair, w: WEIGHTS.ind },
    ]);
    const mFinal = marginRD(combined.pair);
    const wp = winProbFromMargin(mFinal);

    results.push({
      date: dateStr,
      pDem: wp.pD,
      expDem: combined.pair.D
    });
  }
  return results;
}

/* ---------- UI refs ---------- */
const PAST_UI = {};

function getPastUI(){
  for (const mode of PAST_MODES){
    let col = document.querySelector(`.modeCol[data-past-mode="${mode}"]`);
    // Fallback: house column may lack the attribute — find the 4th modeCol in pastElectionsPage
    if (!col && mode === "house"){
      const page = document.getElementById("pastElectionsPage");
      if (page){
        const allCols = page.querySelectorAll(".modeCol");
        for (const c of allCols){
          if (!c.dataset.pastMode){ col = c; c.dataset.pastMode = "house"; break; }
        }
      }
    }
    if (!col) continue;
    PAST_UI[mode] = {
      col,
      pillD:     col.querySelector("[data-past-pill-d]") || col.querySelector(".metricPill.blue .val"),
      pillR:     col.querySelector("[data-past-pill-r]") || col.querySelector(".metricPill.red .val"),
      seatsD:    col.querySelector("[data-past-seats-d]") || col.querySelector(".seatsSide.d .num"),
      seatsR:    col.querySelector("[data-past-seats-r]") || col.querySelector(".seatsSide.r .num"),
      simCanvas: col.querySelector("[data-past-sim]") || col.querySelector(".simCanvas"),
      svgEl:     col.querySelector(".mapSvg"),
      comboSvg:  col.querySelector("[data-past-combo]") || col.querySelector(".comboSvg"),
      ylabel:    col.querySelector("[data-past-ylabel]") || col.querySelector(".chartYLabel"),
      status:    col.querySelector("[data-past-status]") || col.querySelector(".oddsStatus"),
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
        const filter = (RACES[year]||{})[mode];
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
  // For 2025 off-year: use the 2026 forecast's GB polls (already loaded by forecast.js)
  if (year === 2025 && typeof GB_SRC !== "undefined" && GB_SRC?.raw?.length){
    const electionDay = new Date(2025, 10, 4); // Nov 4, 2025
    const polls = GB_SRC.raw
      .filter(p => p.date && p.date <= electionDay)
      .map(p => {
        const d = p.date;
        const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
        return { date: ds, dem: p.dem, rep: p.rep };
      })
      .sort((a,b) => a.date.localeCompare(b.date));

    if (polls.length){
      if (!PAST_DATA[year]) PAST_DATA[year] = {};
      PAST_RAW_GB[year] = polls;
      const gb = rollingAvg(polls, GB_WINDOW);
      for (const mode of ["senate","governor","house"]){
        if (!PAST_DATA[year][mode]) PAST_DATA[year][mode] = { gb:null, ratios:{}, polls:{} };
        if (gb) PAST_DATA[year][mode].gb = gb;
      }
      console.log(`Loaded ${polls.length} GB polls for ${year} from forecast GB_SRC, GB: D=${gb?.D?.toFixed(1)} R=${gb?.R?.toFixed(1)}`);
      return polls;
    }
  }

  // Fallback: load from file
  const file = `${year}_gb_polls.json`;
  try {
    const j = await fetch(file, {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const polls = (j.genericBallot || []).map(p => ({
      date: p.end_date, dem: +p.dem, rep: +p.rep
    })).filter(p => p.date && isFinite(p.dem) && isFinite(p.rep))
      .sort((a,b) => a.date.localeCompare(b.date));

    if (!PAST_DATA[year]) PAST_DATA[year] = {};
    PAST_RAW_GB[year] = polls.slice();
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
      if (st === "ME" && mode === "senate") continue;
      const dem = toNum(row.dem), rep = toNum(row.rep);
      if (!isFinite(dem) || !isFinite(rep)) continue;
      const key = `${mode}|${st}`;
      if (!byModeState[key]) byModeState[key] = [];
      byModeState[key].push({ date: row.date, dem, rep, sigma: toNum(row.sigma) || 3, pollster: row.pollster || "" });
    }

    let count = 0;
    for (const [key, polls] of Object.entries(byModeState)){
      const [mode, st] = key.split("|");
      if (!PAST_DATA[year][mode]) continue;
      polls.sort((a,b) => a.date.localeCompare(b.date));

      // Store raw polls for time series
      if (!PAST_RAW_POLLS[year]) PAST_RAW_POLLS[year] = {};
      if (!PAST_RAW_POLLS[year][mode]) PAST_RAW_POLLS[year][mode] = {};
      PAST_RAW_POLLS[year][mode][st] = polls.slice();

      const last = polls.slice(-12);

      if (year === 2025){
        // Weighted average using pollster tiers
        let wSum=0, wD=0, wR=0, wS=0;
        for (const p of last){
          const w = pollWeight2025(p.pollster);
          wSum += w; wD += w*p.dem; wR += w*p.rep; wS += w*p.sigma;
        }
        if (wSum > 0){
          PAST_DATA[year][mode].polls[st] = { D: wD/wSum, R: wR/wSum, S: wS/wSum };
        }
      } else {
        const slice = last.slice(-6);
        const avgD = slice.reduce((s,p) => s + p.dem, 0) / slice.length;
        const avgR = slice.reduce((s,p) => s + p.rep, 0) / slice.length;
        const avgS = slice.reduce((s,p) => s + p.sigma, 0) / slice.length;
        PAST_DATA[year][mode].polls[st] = { D: avgD, R: avgR, S: avgS };
      }
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
    if (y !== 2024 && y !== 2025) btn.classList.add("disabled");
    btn.addEventListener("click", () => {
      if (y !== 2024 && y !== 2025) return;
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
  const raceFilters = RACES[year] || {};

  // Adjust grid for years with fewer columns
  const pageEl = document.getElementById("pastElectionsPage");
  if (pageEl){
    const nCols = LABEL_OVERRIDES[year] ? 3 : 4;
    pageEl.style.gridTemplateColumns = `repeat(${nCols}, minmax(0, 1fr))`;
  }

  for (const mode of PAST_MODES){
    const ui = PAST_UI[mode];
    if (!ui) continue;

    // --- Label overrides & column visibility for off-years ---
    const overrides = LABEL_OVERRIDES[year];
    const presCol = document.querySelector('.modeCol[data-past-mode="president"]');
    if (overrides){
      if (overrides[mode] === null){
        // Hide this column
        ui.col.style.display = "none";
        continue;
      }
      ui.col.style.display = "";
      const titleEl = ui.col.querySelector(".panelTitle");
      const subEl = ui.col.querySelector(".panelSub");
      const oddsTitle = ui.col.querySelector(".oddsTitle");
      if (titleEl && overrides[mode]) titleEl.textContent = overrides[mode].title;
      if (subEl && overrides[mode]) subEl.textContent = overrides[mode].sub;
      if (oddsTitle && overrides[mode]) oddsTitle.textContent = overrides[mode].title;
      // For single-race years, keep seatsCard visible but hide histogram
      const seatsCard = ui.col.querySelector(".seatsCard");
      const simMini = ui.col.querySelector(".simMini");
      if (simMini) simMini.style.display = "none";
      if (seatsCard) seatsCard.style.display = "";
    } else {
      // Restore defaults for multi-state years
      ui.col.style.display = "";
      const defaults = { president:"President", senate:"Senate", governor:"Governor", house:"House" };
      const defaultSubs = { president:"59th Presidential Election", senate:"Class I & III - 2024", governor:"Gubernatorial - 2024", house:"119th Congress - 2024" };
      const titleEl = ui.col.querySelector(".panelTitle");
      const subEl = ui.col.querySelector(".panelSub");
      const oddsTitle = ui.col.querySelector(".oddsTitle");
      if (titleEl) titleEl.textContent = defaults[mode] || mode;
      if (subEl) subEl.textContent = defaultSubs[mode] || "";
      if (oddsTitle) oddsTitle.textContent = defaults[mode] || mode;
      const seatsCard = ui.col.querySelector(".seatsCard");
      const mapCard = ui.col.querySelector(".mapCard");
      const simMini = ui.col.querySelector(".simMini");
      if (seatsCard) seatsCard.style.display = "";
      if (mapCard) mapCard.style.display = "";
      if (simMini) simMini.style.display = "";
    }

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
    let pillPDem = overallPDem, pillPRep = overallPRep;

    // For single-race years, use direct model win probability (normal approx breaks for 1 seat)
    if (LABEL_OVERRIDES[year] && contested.length === 1){
      const st0 = contested[0];
      const model0 = st0 ? getStateModelPast(year, mode, st0) : null;
      if (model0){
        pillPDem = model0.winProb.pD;
        pillPRep = model0.winProb.pR;
      }
    } else if (odds && odds.length){
      const latest = odds[odds.length - 1];
      const mc = +latest.pDem;
      if (isFinite(mc)){ pillPDem = mc; pillPRep = 1 - mc; }
    }
    if (ui.pillD) ui.pillD.textContent = (pillPDem * 100).toFixed(1);
    if (ui.pillR) ui.pillR.textContent = (pillPRep * 100).toFixed(1);

    // Seats display
    const isSingleRace = !!(LABEL_OVERRIDES[year]);
    if (isSingleRace){
      // Show projected two-party vote share
      const st0 = contested[0];
      const model0 = st0 ? getStateModelPast(year, mode, st0) : null;
      if (model0){
        if (ui.seatsD) ui.seatsD.textContent = model0.combinedPair.D.toFixed(1);
        if (ui.seatsR) ui.seatsR.textContent = model0.combinedPair.R.toFixed(1);
      }
    } else {
      // Binary seat tally
      if (ui.seatsD) ui.seatsD.textContent = totalD;
      if (ui.seatsR) ui.seatsR.textContent = totalR;
    }

    // Lead color
    if (ui.topCard){
      ui.topCard.classList.remove("leads-d","leads-r");
      if (pillPDem > 0.5) ui.topCard.classList.add("leads-d");
      else ui.topCard.classList.add("leads-r");
    }


    // Render maps
    if (isSingleRace){
      const st0 = contested[0];
      if (st0) renderPastCountyMap(year, mode, st0, d);
    } else {
      renderPastSim(mode, hist, rule);
      renderPastMap(year, mode, d, rule, raceFilter);
    }





    if (!isSingleRace && odds && odds.length){
      renderPastComboChart(mode, odds, rule);
      if (ui.status) ui.status.textContent = `${odds.length} days · ${year} hindcast`;
      if (ui.status) ui.status.style.display = "block";
    } else if (isSingleRace){
      // Compute time series from raw polls and render chart
      const st0 = contested[0];
      if (st0){
        const ts = computePastTimeSeries(year, mode, st0);
        if (ts.length){
          // Store so chart tab switching works
          if (!PAST_ODDS[year]) PAST_ODDS[year] = {};
          PAST_ODDS[year][mode] = ts;
          renderPastComboChart(mode, ts, rule);
          if (ui.status) ui.status.textContent = `Model: ${formatMarginDR(getStateModelPast(year, mode, st0)?.mFinal)}`;
        } else {
          if (ui.comboSvg) d3.select(ui.comboSvg).selectAll("*").remove();
          if (ui.status) ui.status.textContent = `Model: ${formatMarginDR(getStateModelPast(year, mode, st0)?.mFinal)}`;
        }
        if (ui.status) ui.status.style.display = "block";
      }
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
      if (!st || !d?.ratios[st] || !isContested(st)) return getComputedStyle(document.documentElement).getPropertyValue("--neutral-bg").trim()||"#e5e7eb";
      const model = getStateModelPast(year, mode, st);
      if (!model) return getComputedStyle(document.documentElement).getPropertyValue("--neutral-bg").trim()||"#e5e7eb";
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

/* ---------- County map for single-race years ---------- */
const _USPS_FIPS = {
  AL:"01",AK:"02",AZ:"04",AR:"05",CA:"06",CO:"08",CT:"09",DE:"10",DC:"11",FL:"12",
  GA:"13",HI:"15",ID:"16",IL:"17",IN:"18",IA:"19",KS:"20",KY:"21",LA:"22",ME:"23",
  MD:"24",MA:"25",MI:"26",MN:"27",MS:"28",MO:"29",MT:"30",NE:"31",NV:"32",NH:"33",
  NJ:"34",NM:"35",NY:"36",NC:"37",ND:"38",OH:"39",OK:"40",OR:"41",PA:"42",RI:"44",
  SC:"45",SD:"46",TN:"47",TX:"48",UT:"49",VT:"50",VA:"51",WA:"53",WV:"54",WI:"55",WY:"56"
};

let PAST_COUNTY_GEO = null;
let PAST_COUNTY_RATIOS = null;

async function loadPastCountyGeo(){
  if (PAST_COUNTY_GEO) return PAST_COUNTY_GEO;
  if (typeof ALL_COUNTY_GEO !== "undefined" && ALL_COUNTY_GEO){ PAST_COUNTY_GEO = ALL_COUNTY_GEO; return PAST_COUNTY_GEO; }
  const resp = await fetch("https://cdn.jsdelivr.net/gh/plotly/datasets/geojson-counties-fips.json");
  if (!resp.ok) throw new Error(`County GeoJSON HTTP ${resp.status}`);
  PAST_COUNTY_GEO = await resp.json();
  return PAST_COUNTY_GEO;
}

async function loadPastCountyRatios(){
  if (PAST_COUNTY_RATIOS) return PAST_COUNTY_RATIOS;
  if (typeof COUNTY_RATIOS !== "undefined" && COUNTY_RATIOS){ PAST_COUNTY_RATIOS = COUNTY_RATIOS; return PAST_COUNTY_RATIOS; }
  try {
    const resp = await fetch("json/county_ratios.json", {cache:"no-store"});
    if (!resp.ok) throw new Error(resp.status);
    PAST_COUNTY_RATIOS = await resp.json();
  } catch(e){
    console.warn("county_ratios.json not available for past-elections:", e);
    PAST_COUNTY_RATIOS = {};
  }
  return PAST_COUNTY_RATIOS;
}

function getCountiesForStatePast(allGeo, usps){
  const prefix = _USPS_FIPS[usps];
  if (!prefix) return [];
  return allGeo.features.filter(f => {
    if (f.id && String(f.id).padStart(5,"0").slice(0,2) === prefix) return true;
    const p = f.properties || {};
    if (p.STATE === prefix || p.STATEFP === prefix) return true;
    const gid = String(p.GEO_ID || p.GEOID || "").replace(/^0500000US/, "");
    if (gid && gid.padStart(5,"0").slice(0,2) === prefix) return true;
    return false;
  });
}

async function renderPastCountyMap(year, mode, st, d){
  const ui = PAST_UI[mode];
  if (!ui?.svgEl) return;

  const [allGeo, countyRatios] = await Promise.all([loadPastCountyGeo(), loadPastCountyRatios()]);
  const counties = getCountiesForStatePast(allGeo, st);
  if (!counties.length){ console.warn(`No counties found for ${st}`); return; }

  const model = getStateModelPast(year, mode, st);
  const stateMargin = model ? model.mFinal : NaN;

  const width = 960, height = 600;
  const svg = d3.select(ui.svgEl);
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.selectAll("*").remove();

  const countyCollection = { type:"FeatureCollection", features: counties };
  const projection = d3.geoAlbersUsa();
  const pad = 40;
  projection.fitExtent([[pad, pad], [width - pad, height - pad]], countyCollection);
  const pathGen = d3.geoPath(projection);

  const gRoot = svg.append("g");

  const getName = (feat) => {
    const p = feat.properties || {};
    return (p.NAME || p.name || p.COUNTY || "").toUpperCase();
  };

  gRoot.selectAll("path")
    .data(counties)
    .join("path")
    .attr("d", pathGen)
    .attr("fill", feat => {
      // Try county-level coloring via county_ratios (presidential ratios as proxy)
      const name = getName(feat);
      const cd = countyRatios?.[st]?.counties?.[name];
      if (cd && model){
        const rawD = model.combinedPair.D * cd.dRatio;
        const rawR = model.combinedPair.R * cd.rRatio;
        const s = rawD + rawR;
        if (s > 0) return marginColor(100 * rawR / s - 100 * rawD / s);
      }
      return isFinite(stateMargin) ? marginColor(stateMargin) : "#e5e7eb";
    })
    .attr("stroke", "rgba(255,255,255,0.7)")
    .attr("stroke-width", 0.5)
    .attr("vector-effect", "non-scaling-stroke")
    .on("mouseenter", (event, feat) => {
      d3.select(event.currentTarget).attr("stroke","var(--ink)").attr("stroke-width",1.5);
      const name = getName(feat);
      const cd = countyRatios?.[st]?.counties?.[name];
      const tip = document.getElementById("pastTip");
      if (!tip) return;

      let marginStr = formatMarginDR(stateMargin) + " (statewide)";
      let dPct = "", rPct = "";
      if (cd && model){
        const rawD = model.combinedPair.D * cd.dRatio;
        const rawR = model.combinedPair.R * cd.rRatio;
        const s = rawD + rawR;
        if (s > 0){
          const cm = 100*rawR/s - 100*rawD/s;
          marginStr = formatMarginDR(cm);
          dPct = (100*rawD/s).toFixed(1);
          rPct = (100*rawR/s).toFixed(1);
        }
      }
      const side = marginStr.startsWith("D") ? "blue" : marginStr.startsWith("R") ? "red" : "";
      tip.innerHTML =
        `<div class="tipTop"><div class="tipHeader"><div>`+
        `<p class="tipTitle" style="margin:0">${name}</p>`+
        `<div class="tipSub" style="margin-top:6px">`+
        `<span class="badge"><span class="dot ${side}"></span>${marginStr}</span>`+
        `</div></div>`+
        (dPct ? `<div class="tipMeta">D ${dPct} · R ${rPct}</div>` : "")+
        `</div></div>`;
      positionPastTip(event);
      tip.style.opacity = "1";
    })
    .on("mousemove", (event) => positionPastTip(event))
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).attr("stroke","rgba(255,255,255,0.7)").attr("stroke-width",0.5);
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
  renderPastYear(2025);
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
