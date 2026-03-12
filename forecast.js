/* ---------- Config ---------- */
console.log("forecast.js v16 — circuit breaker + wider county panel");
const PROB_ERROR_SD_PTS = 7; // hidden, used for win probabilities (state + senate majority)
const TOOLTIP_COMPACT = true;
const WEIGHTS = { gb:35, polls:50, ind:15 };
const VIS = { show:12.5, likely:7.5, lean:2.5 }; // UI buckets + map filter

function bucketKeyFromMargin(m){
  if (!isFinite(m)) return null;
  const a = Math.abs(m);
  const side = (m < 0) ? "D" : "R";

  // Safe: |margin| >= 12.5 — excluded from the table (still shown on the map)
  if (a >= VIS.show) return null;

  // Tossup: |margin| <= 2.5
  if (a <= VIS.lean) return "Tossup";

  // Lean: 2.5 < |margin| <= 7.5
  if (a <= VIS.likely) return `Lean ${side}`;

  // Likely: 7.5 < |margin| < 12.5
  return `Likely ${side}`;
}
function formatMarginDR(m){
  if (!isFinite(m)) return "—";
  const mm = clamp(m, -25, 25); // display clamp
  const a = Math.abs(mm);
  if (a < 0.05) return "Tied";
  return (mm < 0) ? `D+${a.toFixed(1)}` : `R+${a.toFixed(1)}`;
}
function pseudoEvtFromEl(el){
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
}


const SEAT_RULES = {
  senate:   { total:100, majorityLine:51,  baseR:31, baseD:34 },
  governor: { total:50,  majorityLine:26,  baseR:8,  baseD:6  },
  house:    { total:435, majorityLine:218, baseR:0,  baseD:0  },
};
const SENATE_CONTROL_RULE = { demAtLeast: 51, repAtLeast: 50 };

/* ---------- FIPS lookup for US-atlas ---------- */
const FIPS_TO_USPS = {
  1:"AL",2:"AK",4:"AZ",5:"AR",6:"CA",8:"CO",9:"CT",10:"DE",11:"DC",12:"FL",13:"GA",15:"HI",16:"ID",17:"IL",18:"IN",19:"IA",20:"KS",21:"KY",22:"LA",23:"ME",24:"MD",25:"MA",26:"MI",27:"MN",28:"MS",29:"MO",30:"MT",31:"NE",32:"NV",33:"NH",34:"NJ",35:"NM",36:"NY",37:"NC",38:"ND",39:"OH",40:"OK",41:"OR",42:"PA",44:"RI",45:"SC",46:"SD",47:"TN",48:"TX",49:"UT",50:"VT",51:"VA",53:"WA",54:"WV",55:"WI",56:"WY"
};
const USPS_TO_NAME = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",
  FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",
  MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",
  NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",
  SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"
};
function fipsToUsps(id){ const n = parseInt(id, 10); return FIPS_TO_USPS[n] || ""; }
/* ---------- House district helpers ---------- */
const NAME_TO_USPS = Object.fromEntries(
  Object.entries(USPS_TO_NAME).map(([usps, name]) => [String(name).trim().toLowerCase(), usps])
);

function houseDistrictCode(usps, cd){
  if (!usps) return "";
  if (cd === 0) return `${usps}-AL`;
  return `${usps}-${String(cd).padStart(2,"0")}`;
}
function houseDistrictName(stateName, cd){
  if (!stateName) return "House district";
  return (cd === 0) ? `${stateName} At-Large` : `${stateName} District ${cd}`;
}


/* ---------- Math helpers ---------- */
const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));
function normalizePair(D, R){
  const d = Number(D), r = Number(R);
  const s = d + r;
  if (!isFinite(s) || s <= 0) return {D:50, R:50};
  return {D: 100*d/s, R: 100*r/s};
}
function marginRD(pair){ return pair.R - pair.D; } // negative = Dem lead
function fmtLead(m){
  if (!isFinite(m)) return "—";
  if (Math.abs(m) < 1e-9) return "D+0.0";
  const pts = Math.abs(m).toFixed(1);
  return (m < 0) ? `D+${pts}` : `R+${pts}`;
}
function erf(x){
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t = 1/(1+p*x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normalCDF(x){ return 0.5*(1 + erf(x/Math.SQRT2)); }
function winProbFromMargin(m){
  const z = m / PROB_ERROR_SD_PTS;
  const pR = clamp(normalCDF(z), 0, 1);
  return { pD: 1 - pR, pR };
}

/* ---------- Fast win-prob lookup (avoids millions of erf/exp calls in House MC) ---------- */
const WINP_MIN = -40, WINP_MAX = 40, WINP_STEP = 0.1;
const WINP_N = Math.round((WINP_MAX - WINP_MIN) / WINP_STEP) + 1;
const WINP_PD_TABLE = new Float32Array(WINP_N);
for (let i=0;i<WINP_N;i++){
  const m = WINP_MIN + i*WINP_STEP;
  WINP_PD_TABLE[i] = winProbFromMargin(m).pD;
}
function winProbD_fast(m){
  if (!isFinite(m)) return 0.5;
  const mm = clamp(m, WINP_MIN, WINP_MAX);
  const idx = Math.round((mm - WINP_MIN) / WINP_STEP);
  return WINP_PD_TABLE[idx] ?? 0.5;
}

/* ---------- Color ---------- */
function interpColor(m){
  if (!isFinite(m)) return "#e5e7eb";

  const max = 25;
  const a = Math.abs(m);

  // Under 2 pts: highlight as "ultra-close" (yellow)
  if (a < 2.0) return "rgb(253,224,71)"; // ~#fde047

  const t = clamp(a/max, 0, 1);

  if (m < 0){
    // Blue ramp
    const r = Math.round(248*(1-t) + 37*t);
    const g = Math.round(250*(1-t) + 99*t);
    const b = Math.round(252*(1-t) + 235*t);
    return `rgb(${r},${g},${b})`;
  } else {
    // Red ramp
    const r = Math.round(252*(1-t) + 220*t);
    const g = Math.round(250*(1-t) + 38*t);
    const b = Math.round(250*(1-t) + 38*t);
    return `rgb(${r},${g},${b})`;
  }
}



/* ---------- Data model loaded from CSV ---------- */
const DATA = {
  senate:   { gb:null, ratios:{}, polls:{} },
  governor: { gb:null, ratios:{}, polls:{} },
  house:    { gb:null, ratios:{}, polls:{}, meta:{} }, // meta: {code,name,state,cd}
};
function toNum(v){
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}


async function loadCSV(){
  const errBox = document.getElementById("loadError");
  try{
    const csvText = await fetch("csv/entries_all.csv", {cache:"no-store"}).then(r=>{
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });

    const rows = d3.csvParse(csvText);
    if (!rows || rows.length === 0) throw new Error("CSV empty");

    for (const row of rows){
      const mode = String(row.mode || "").trim().toLowerCase();
      if (!DATA[mode]) continue;

      const st = String(row.state || "").trim().toUpperCase();
      const ratioD = toNum(row.ratioD);
      const ratioR = toNum(row.ratioR);

      if (st && isFinite(ratioD) && isFinite(ratioR)){
        DATA[mode].ratios[st] = {D: ratioD, R: ratioR};
      }

      const gbD = toNum(row.gbD);
      const gbR = toNum(row.gbR);
      if (!DATA[mode].gb && isFinite(gbD) && isFinite(gbR)){
        DATA[mode].gb = normalizePair(gbD, gbR);
      }

      const pollD = toNum(row.pollD);
      const pollR = toNum(row.pollR);
      const pollS = toNum(row.pollSigma);
      if (isFinite(pollD) && isFinite(pollR)){
        DATA[mode].polls[st] = {
          D: pollD,
          R: pollR,
          S: isFinite(pollS) ? pollS : 3
        };
      }
    }

    // Fill missing GBs if only one mode had it
    if (!DATA.senate.gb && DATA.governor.gb) DATA.senate.gb = DATA.governor.gb;
    if (!DATA.governor.gb && DATA.senate.gb) DATA.governor.gb = DATA.senate.gb;

    if (errBox) errBox.hidden = true;
    return true;
  }catch(err){
    if (errBox){
      errBox.hidden = false;
      errBox.innerHTML = `
        Could not load <span class="mono">entries_all.csv</span>.<br/>
        Error: <span class="mono">${String(err.message || err)}</span><br/>
        If you opened this as <span class="mono">file://</span>, serve it locally (e.g. <span class="mono">python3 -m http.server 8000</span>).
      `;
    }
    return false;
  }
}



async function loadHouseRatios(){
  const errBox = document.getElementById("loadError");
  try{
    const csvText = await fetch("csv/house_district_ratios_filled.csv", {cache:"no-store"}).then(r=>{
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });

    const rows = d3.csvParse(csvText);
    if (!rows || rows.length === 0) throw new Error("House ratios CSV empty");

    for (const row of rows){
      const rawId = String(row.path_id ?? "").trim();
      if (!rawId) continue;
      const did = rawId.padStart(4,"0");
      const dRatio = toNum(row.d_ratio);
      const rRatio = toNum(row.r_ratio);

      if (isFinite(dRatio) && isFinite(rRatio)){
        DATA.house.ratios[did] = { D: dRatio, R: rRatio };
      }

      const stateName = String(row.state_name ?? "").trim();
      const cd = parseInt(String(row.congressional_district_number ?? "").trim(), 10);
      const usps = NAME_TO_USPS[String(stateName).toLowerCase()] || "";
      const code = houseDistrictCode(usps, isFinite(cd) ? cd : 0) || did;
      const name = houseDistrictName(stateName || (USPS_TO_NAME[usps] || usps), isFinite(cd) ? cd : 0);

      DATA.house.meta[did] = { code, name, state: stateName, cd: (isFinite(cd) ? cd : 0), usps };
    }

    // House generic ballot comes from the Senate CSV
    if (!DATA.house.gb){
      DATA.house.gb = DATA.senate.gb || DATA.governor.gb || {D:50,R:50};
    }

    if (errBox) errBox.hidden = true;
    return true;
  }catch(err){
    if (errBox){
      errBox.hidden = false;
      errBox.innerHTML = `
        Could not load <span class="mono">csv/house_district_ratios_filled.csv</span>.<br/>
        Error: <span class="mono">${String(err.message || err)}</span><br/>
        If you opened this as <span class="mono">file://</span>, serve it locally (e.g. <span class="mono">python3 -m http.server 8000</span>).
      `;
    }
    return false;
  }
}


/* ---------- Generic ballot from polls.json (generic ballot window (last-N polls)) ---------- */
function norm(s){ return String(s||"").trim().toLowerCase().replace(/\s+/g," "); }
function parseDate(s){
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3]);
}


/* ---------- State polling by date (manual input) ---------- */
const STATE_POLL_SRC = {
  file: "csv/state_polls_by_date.csv",
  window: 6,
  byModeState: { senate:{}, governor:{}, house:{} }
};

async function loadStatePollsByDateCSV(){
  // Supports two schemas:
  // A) simple: mode,state,date,dem,rep[,sigma]
  // B) poll-rows: office,state,end_date,candA_party,candA_pct,candB_party,candB_pct[,sigma] (like RTWH export)
  STATE_POLL_SRC.byModeState = { senate:{}, governor:{}, house:{} };

  function normMode(x){
    const v = String(x||"").trim().toLowerCase();
    if (!v) return "";
    if (v === "sen" || v === "senate" || v.includes("senate")) return "senate";
    if (v === "gov" || v === "governor" || v.includes("governor")) return "governor";
    if (v === "house" || v === "us house" || v.includes("house")) return "house";
    // race codes like AK-SEN, TX-GOV
    const u = v.toUpperCase();
    if (u.includes("SEN")) return "senate";
    if (u.includes("GOV")) return "governor";
    if (u.includes("HOUSE")) return "house";
    return "";
  }

  function pickDRfromCandidates(r){
    const aP = String(r.candA_party || r.partyA || r.candAParty || "").trim().toUpperCase();
    const bP = String(r.candB_party || r.partyB || r.candBParty || "").trim().toUpperCase();
    const aPct = Number(r.candA_pct ?? r.candAPct ?? r.candA ?? r.a_pct ?? r.aPct);
    const bPct = Number(r.candB_pct ?? r.candBPct ?? r.candB ?? r.b_pct ?? r.bPct);

    if (!isFinite(aPct) || !isFinite(bPct)) return {D:NaN, R:NaN};

    let D = NaN, R = NaN;
    if (aP === "D") D = aPct;
    if (bP === "D") D = bPct;
    if (aP === "R") R = aPct;
    if (bP === "R") R = bPct;

    return {D, R};
  }

  try{
    const resp = await fetch(STATE_POLL_SRC.file, {cache:"no-store"});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    const rows = d3.csvParse(txt);

    for (const r of rows){
      // mode / office / race
      const mode = normMode(r.mode || r.office || r.Office || r.race || r.type || r.contest || "");
      const key  = String(r.state || r.State || r.key || r.race_key || r.raceKey || "").trim().toUpperCase();
      const dt   = parseDate(r.date || r.end_date || r.endDate || r.day || r.asof || "");

      if (!mode || !STATE_POLL_SRC.byModeState[mode] || !key || !dt) continue;

      // D/R direct columns (schema A)
      let D = Number(r.dem ?? r.D ?? r.pollD ?? r.dem_pct ?? r.demPct ?? r.d ?? r.d_pct ?? r.dPct);
      let R = Number(r.rep ?? r.R ?? r.pollR ?? r.rep_pct ?? r.repPct ?? r.r ?? r.r_pct ?? r.rPct);

      // If missing, infer from candidate party columns (schema B)
      if (!isFinite(D) || !isFinite(R)){
        const inferred = pickDRfromCandidates(r);
        D = inferred.D; R = inferred.R;
      }

      if (!isFinite(D) || !isFinite(R) || (D+R) <= 0) continue;

      const S = Number(r.sigma ?? r.S ?? r.sd ?? r.pollSigma ?? r.moe ?? r.moe_pct);
      const arr = (STATE_POLL_SRC.byModeState[mode][key] ||= []);
      arr.push({date: dt, D, R, S: isFinite(S) ? S : 3});
    }

    for (const mode of Object.keys(STATE_POLL_SRC.byModeState)){
      const mm = STATE_POLL_SRC.byModeState[mode];
      for (const k of Object.keys(mm)){
        mm[k].sort((a,b)=>a.date - b.date);
      }
    }
    return true;
  } catch (e){
    console.warn("State polls by-date CSV not loaded:", e);
    return false;
  }
}


function upperBoundByDate(arr, dt){
  let lo = 0, hi = arr.length;
  while (lo < hi){
    const mid = (lo + hi) >> 1;
    if (arr[mid].date <= dt) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Replace legacy per-state polls from entries_all.csv with rolling (last-N) averages from state_polls_by_date.csv
// for the current "latest" date in the generic-ballot series.
function applyLatestStatePollsToData(){
  // Overlay DATA[mode].polls with rolling (last-N) averages from state_polls_by_date.csv
  // as of the latest generic-ballot date. Never blank out existing polls on failure.
  const latestStr = GB_SRC?.latest?.date || null;
  const latestDt = parseDate(latestStr);
  if (!latestDt) return false;

  const window = Math.max(1, STATE_POLL_SRC.window|0);
  let any = false;

  for (const mode of ["senate","governor"]){
    const src = STATE_POLL_SRC.byModeState?.[mode];
    if (!src || !DATA[mode]) continue;

    for (const st of Object.keys(DATA[mode].ratios || {})){
      const polls = src[st];
      if (!polls || polls.length === 0) continue;

      // upperBound: first idx with date > latestDt
      let hi = 0;
      while (hi < polls.length && polls[hi].date <= latestDt) hi++;
      const lo = Math.max(0, hi - window);
      const cnt = hi - lo;
      if (cnt <= 0) continue;

      let sumD = 0, sumR = 0;
      for (let i=lo;i<hi;i++){ sumD += polls[i].D; sumR += polls[i].R; }
      DATA[mode].polls[st] = { D: sumD/cnt, R: sumR/cnt, S: 3 };
      any = true;
    }
  }

  return any;
}

function buildPollMatrixForDays(modeKey, keys, dateStrs, windowN){
  const src = STATE_POLL_SRC.byModeState?.[modeKey];
  if (!src) return null;

  const nStates = keys.length;
  const nDays = dateStrs.length;

  const pollDDay = new Float32Array(nStates * nDays);
  const pollRDay = new Float32Array(nStates * nDays);
  pollDDay.fill(NaN);
  pollRDay.fill(NaN);

  const window = Math.max(1, windowN|0);
  const dayDates = dateStrs.map(parseDate);

  for (let i=0;i<nStates;i++){
    const k = keys[i];
    const polls = src[k] || null;
    if (!polls || polls.length===0) continue;

    const m = polls.length;
    const psD = new Float64Array(m+1);
    const psR = new Float64Array(m+1);
    for (let j=0;j<m;j++){
      psD[j+1] = psD[j] + polls[j].D;
      psR[j+1] = psR[j] + polls[j].R;
    }

    let hi = 0;
    for (let day=0; day<nDays; day++){
      const dt = dayDates[day];
      if (!dt) continue;
      while (hi < m && polls[hi].date <= dt) hi++;
      const lo = Math.max(0, hi - window);
      const cnt = hi - lo;
      if (cnt <= 0) continue;

      pollDDay[day*nStates + i] = (psD[hi]-psD[lo]) / cnt;
      pollRDay[day*nStates + i] = (psR[hi]-psR[lo]) / cnt;
    }
  }

  return { pollDDay, pollRDay, nStates, nDays };
}

function computeIndicatorNationalFromPollMatrix(modeKey, arr, pm, dayIndex){
  if (!pm) return null;
  const {pollDDay, pollRDay, nStates, nDays} = pm;
  const day = clamp(dayIndex|0, 0, nDays-1);

  const implied = [];
  for (let i=0;i<nStates;i++){
    const D = pollDDay[day*nStates + i];
    const R = pollRDay[day*nStates + i];
    if (!isFinite(D) || !isFinite(R) || (D+R)<=0) continue;
    const p = normalizePair(D, R);
    const rd = arr.ratioD[i] || 1;
    const rr = arr.ratioR[i] || 1;
    implied.push({ D: p.D / rd, R: p.R / rr });
  }
  if (implied.length === 0) return null;

  const Ds = implied.map(x=>x.D);
  const Rs = implied.map(x=>x.R);
  return { D: median(Ds), R: median(Rs) };
}

function ds(d){
  if (!(d instanceof Date)) d = new Date(d);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function getAns(p, keys){
  if (!p || !Array.isArray(p.answers)) return null;
  const want = (keys||[]).map(norm);
  for (const a of p.answers){
    const c = norm(a.choice || "");
    if (want.includes(c)) return +a.pct;
  }
  // Some polls store full names; fall back to substring match
  for (const a of p.answers){
    const c = norm(a.choice || "");
    for (const k of want){
      if (c===k) return +a.pct;
      if (c.includes(k)) return +a.pct;
    }
  }
  return null;
}
function calcLastNPollsSeries(gbPolls, N){
  const polls = (gbPolls||[]).filter(p=>p && p.date instanceof Date && isFinite(p.dem) && isFinite(p.rep))
    .slice().sort((a,b)=>a.date-b.date);
  if (!polls.length) return [];
  const n = polls.length;

  const dates = new Array(n);
  const psD = new Float64Array(n+1);
  const psR = new Float64Array(n+1);

  for (let i=0;i<n;i++){
    dates[i] = polls[i].date;
    const d = +polls[i].dem;
    const r = +polls[i].rep;
    psD[i+1] = psD[i] + d;
    psR[i+1] = psR[i] + r;
  }

  const t0 = new Date(dates[0]);
  const lastPollDay = new Date(dates[n-1]);
  const today = new Date(); today.setHours(0,0,0,0);
  const t1 = (today > lastPollDay) ? new Date(today) : lastPollDay;
  const out = [];
  let hi = 0;

  for (let day = new Date(t0); day <= t1; day.setDate(day.getDate()+1)){
    while (hi < n && dates[hi] <= day) hi++;
    const lo = Math.max(0, hi - N);
    const cnt = hi - lo;
    if (cnt <= 0) continue;
    const meanD = (psD[hi] - psD[lo]) / cnt;
    const meanR = (psR[hi] - psR[lo]) / cnt;
    out.push({ date: ds(day), dem: meanD, rep: meanR, count: cnt });
  }
  return out;
}

/* ---------- Generic ballot pollster allowlist (Strict Allowlist) ---------- */
const AP=[{label:"YouGov",pattern:/yougov/},{label:"Verasight",pattern:/verasight/},{label:"Ipsos",pattern:/ipsos/},{label:"ARG",pattern:/americanresearchgroup|arg\b/},{label:"TIPP",pattern:/tipp/},{label:"Emerson",pattern:/emerson/},{label:"Gallup",pattern:/gallup/},{label:"Marist",pattern:/marist/},{label:"Quinnipiac",pattern:/quinnipiac/},{label:"AP-NORC",pattern:/apnorc|ap\-norc|norc/},{label:"Marquette",pattern:/marquette/},{label:"CNN/SSRS",pattern:/cnnssrs|cnn\/ssrs|ssrs/},{label:"AtlasIntel",pattern:/atlasintel|atlas/},{label:"Beacon/Shaw",pattern:/beaconresearch|shaw/},{label:"Hart/POS",pattern:/hartresearch|publicopinionstrategies/},{label:"Pew",pattern:/pewresearch|pew/},{label:"SurveyMonkey",pattern:/surveymonkey/},{label:"Leger",pattern:/leger/},{label:"UMass",pattern:/massachusetts|umass|departmentofpoliticalscience/},{label:"NYT/Siena",pattern:/siena|newyorktimes/},{label:"Fox News",pattern:/foxnews/},{label:"WSJ",pattern:/wallstreetjournal|wsj/}];

function normPollster(s){
  return String(s||"").toLowerCase().replace(/&/g,"and").replace(/[^a-z0-9]+/g,"");
}
function isAllowedPollster(pollster, strict){
  if (!strict) return true;
  const n = normPollster(pollster);
  if (!n) return false;
  return AP.some(x=>x.pattern.test(n));
}

function updateGbControlsMeta(){
  const w = document.getElementById("gbWindow");
  if (w) w.textContent = String(GB_SRC.windowPolls);

  const lastEl = document.getElementById("gbLastDate");
  if (lastEl){
    const end = GB_SRC.latest?.date || "—";
    const lastPoll = GB_SRC.lastPollDate || "—";
    const cnt = GB_SRC.latest?.count;
    const cntTxt = isFinite(cnt) ? ` (count=${cnt})` : "";
    lastEl.textContent = `End: ${end} (last poll: ${lastPoll})${cntTxt}`;
  }
}

function buildGbSeriesFromRaw(){
  const raw = Array.isArray(GB_SRC.raw) ? GB_SRC.raw : [];
  const strict = !!GB_SRC.filterStrict;
  const gbPolls = raw.filter(p=>p && p.date instanceof Date && isFinite(p.dem) && isFinite(p.rep) && isAllowedPollster(p.pollster, strict))
    .slice().sort((a,b)=>a.date-b.date);

  GB_SRC.lastPollDate = gbPolls.length ? ds(gbPolls[gbPolls.length-1].date) : null;

  const series = calcLastNPollsSeries(gbPolls, GB_SRC.windowPolls);
  series.sort((a,b)=>a.date.localeCompare(b.date));
  GB_SRC.series = series;
  GB_SRC.latest = series.length ? series[series.length-1] : null;

  if (GB_SRC.latest){
    const pair = normalizePair(GB_SRC.latest.dem, GB_SRC.latest.rep);
    DATA.house.gb = pair;
    if (DATA.senate) DATA.senate.gb = pair;
    if (DATA.governor) DATA.governor.gb = pair;
  }

  updateGbControlsMeta();
  return series;
}



const GB_SRC = { windowPolls: 24, series: null, latest: null, updatedAt: null, filterStrict: true, raw: null, lastPollDate: null };

async function loadGenericBallotFromPollsJSON(){
  try{
    const j = await fetch("json/polls.json", {cache:"no-store"}).then(r=>{
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

    GB_SRC.updatedAt = j.updatedAt || null;

    const gbRaw = Array.isArray(j.genericBallot) ? j.genericBallot : [];
    const gbPollsRaw = gbRaw.map(p=>{
      const date = parseDate(p.end_date || p.start_date || p.created_at);
      const dem = getAns(p, ["dem","democrat","democrats","democratic"]);
      const rep = getAns(p, ["rep","republican","republicans","gop"]);
      const pollster = p.pollster || p.pollster_name || p.pollsterName || p.sponsor || p.firm || p.source || "";
      return { date, dem, rep, pollster };
    }).filter(p=>p.date && isFinite(p.dem) && isFinite(p.rep));

    GB_SRC.raw = gbPollsRaw;

    // Build series using last N polls (N=GB_SRC.windowPolls), filtered by Strict Allowlist if enabled,
    // and extend to today (flat after last poll).
    return buildGbSeriesFromRaw();
  }catch(err){
    console.warn("polls.json generic ballot load failed:", err);
    return null;
  }
}


function refreshAllAfterGbChange(){
  // clear caches tied to GB series
  try{ TIP_SPARK_CACHE.clear(); }catch(e){}

  buildGbSeriesFromRaw();

  // refresh maps + tables
  for (const mode of MODES){
    try{ recolorMapForMode(mode); }catch(e){}
    try{ renderBucketTableForMode(mode); }catch(e){}
    try{ updateSeatMeterFor(mode); }catch(e){}
  }

  // Re-render precomputed odds charts (data doesn't change, but GB-driven visuals do)
  for (const mode of MODES){
    if (PRECOMPUTED_ODDS[mode]){
      try{ renderComboChart(mode, PRECOMPUTED_ODDS[mode]); }catch(e){}
    }
  }
}

function setupGbControlsUI(){
  const cb = document.getElementById("gbStrict");
  if (!cb) return;
  cb.checked = !!GB_SRC.filterStrict;
  cb.addEventListener("change", ()=>{
    GB_SRC.filterStrict = !!cb.checked;
    refreshAllAfterGbChange();
  });
  updateGbControlsMeta();
}


/* ---------- Model computation ---------- */
function computeGenericBallotState(gb, ratio){
  return normalizePair(gb.D * ratio.D, gb.R * ratio.R);
}
function computePollState(poll){
  if (!poll) return null;
  const D = Number(poll.D), R = Number(poll.R);
  if (!isFinite(D) || !isFinite(R) || (D+R)<=0) return null;
  return normalizePair(D, R);
}
function median(arr){
  const a = arr.filter(x=>isFinite(x)).slice().sort((x,y)=>x-y);
  const n = a.length;
  if (n===0) return NaN;
  const mid = Math.floor(n/2);
  return (n%2===1) ? a[mid] : (a[mid-1]+a[mid])/2;
}
function computeIndicatorNationalFromPolls(modeKey){
  const ratios = DATA[modeKey].ratios;
  const polls = DATA[modeKey].polls;

  const implied = [];
  for (const st of Object.keys(ratios)){
    const p = computePollState(polls[st]);
    if (!p) continue;
    const r = ratios[st];
    implied.push({ D: p.D / r.D, R: p.R / r.R });
  }
  if (implied.length === 0) return null;

  const Ds = implied.map(x=>x.D);
  const Rs = implied.map(x=>x.R);
  const medD = median(Ds);
  const medR = median(Rs);
  return normalizePair(medD, medR);
}
function computeIndicatorState(indNat, ratio){
  return normalizePair(indNat.D * ratio.D, indNat.R * ratio.R);
}
function weightedCombine(components){
  let W=0, D=0, R=0, sig2=0;
  for (const c of components){
    if (!c || !c.pair || !isFinite(c.w) || c.w<=0) continue;
    W += c.w;
    D += c.w * c.pair.D;
    R += c.w * c.pair.R;
    sig2 += c.w * (c.sigma*c.sigma);
  }
  if (W<=0) return {pair:{D:50,R:50}, sigma:6};
  return { pair: normalizePair(D/W, R/W), sigma: Math.sqrt(sig2/W) };
}

function getStateModel(modeKey, st, cachedIndNat){
  const gb = DATA[modeKey].gb || {D:50,R:50};
  const ratios = DATA[modeKey].ratios;
  const ratio = ratios[st];
  if (!ratio) return null;

  const gbPair = computeGenericBallotState(gb, ratio);

  const pollRaw = DATA[modeKey].polls[st];
  const pollPair = computePollState(pollRaw);
  const pollSigma = pollRaw && isFinite(Number(pollRaw.S)) ? Number(pollRaw.S) : 3;

  const indNat = cachedIndNat; // computed once per mode
  const indPair = (indNat) ? computeIndicatorState(indNat, ratio) : null;

  // Circuit breaker: if the national indicator implies >=70% for either party
  // in this state, polls dominate (they're more informative in deep states)
  let wGb = WEIGHTS.gb, wPolls = WEIGHTS.polls, wInd = WEIGHTS.ind;
  if (indPair){
    const indMax = Math.max(indPair.D, indPair.R);
    if (indMax >= 70){
      wPolls = 80;
      wGb    = 15;
      wInd   = 5;
    }
  }

  const comps = [
    { pair: gbPair,   w: wGb,                          sigma: 5 },
    { pair: pollPair, w: pollPair ? wPolls : 0,         sigma: pollSigma },
    { pair: indPair,  w: indPair ? wInd : 0,            sigma: 5 },
  ];
  const combined = weightedCombine(comps);

  const mFinal = marginRD(combined.pair);
  const winProb = winProbFromMargin(mFinal);

  return { gbPair, pollPair, indPair, combinedPair: combined.pair, combinedSigma: combined.sigma, winProb };
}


// Hispanic baseline baked into the district ratios (2024 exit poll)
const HISPANIC_BASELINE = normalizePair(52, 46); // {D: 53.06, R: 46.94}

function getHouseModel(did){
  const gb = DATA.house.gb || DATA.senate.gb || DATA.governor.gb || {D:50,R:50};
  const ratio = DATA.house.ratios[did];
  if (!ratio) return null;

  let adjD = ratio.D, adjR = ratio.R;

  // Hispanic swing adjustment: ratios assumed HISPANIC_BASELINE.
  // If current Hispanic polling differs, shift the ratio for Hispanic-heavy districts.
  const meta = DATA.house.meta[did];
  const code = meta?.code;
  const h_cd = (code && HISPANIC_SHARE[code]) ? HISPANIC_SHARE[code] : 0;

  if (h_cd > 0 && HISPANIC_GB){
    // Swing = how much Hispanic vote moved from baseline
    const swingD = (HISPANIC_GB.D - HISPANIC_BASELINE.D) / HISPANIC_BASELINE.D;
    const swingR = (HISPANIC_GB.R - HISPANIC_BASELINE.R) / HISPANIC_BASELINE.R;
    // Scale ratio by Hispanic share × swing (dampened)
    adjD = ratio.D * (1 + h_cd * 0.75 * swingD);
    adjR = ratio.R * (1 + h_cd * 0.75 * swingR);
  }

  const gbPair = computeGenericBallotState(gb, ratio); // original ratio for "Generic ballot" row
  const cdD = adjD * gb.D;
  const cdR = adjR * gb.R;
  const s = cdD + cdR;
  const combinedPair = (s > 0) ? {D: 100*cdD/s, R: 100*cdR/s} : {D:50, R:50};
  const combinedSigma = 5;

  const mFinal = marginRD(combinedPair);
  const winProb = winProbFromMargin(mFinal);

  return { gbPair, combinedPair, combinedSigma, winProb, h_cd };
}

/* ---------- Hispanic CD polling adjustment ---------- */
const HISPANIC_SHARE = {};  // code → h_cd (0–1)
let HISPANIC_GB = null;     // {D, R} normalized to 100
const HISPANIC_POLL_WINDOW = 12; // rolling last-N polls

async function loadHispanicCDShare(){
  try{
    const resp = await fetch("csv/cd_hispanic_share.csv", {cache:"no-store"});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    const headers = lines[0]?.split(",").map(h=>h.trim());
    let count = 0;
    for (let i=1; i<lines.length; i++){
      const cols = lines[i].split(",");
      if (cols.length < 2) continue;
      const cd = cols[0]?.trim();
      const hcd = parseFloat(cols[1]);
      if (cd && isFinite(hcd)){
        HISPANIC_SHARE[cd] = hcd;
        count++;
      }
    }
    console.log(`Hispanic CD share: ${count} districts loaded`);
  }catch(e){
    console.warn("cd_hispanic_share.csv not loaded:", e);
  }
}

async function loadHispanicPolls(){
  try{
    const resp = await fetch("csv/trusted_hispanic_polls.csv", {cache:"no-store"});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    const polls = [];
    for (let i=1; i<lines.length; i++){
      const cols = lines[i].split(",");
      if (cols.length < 4) continue;
      const date = parseDate(cols[0]?.trim());
      const d = parseFloat(cols[2]);
      const r = parseFloat(cols[3]);
      if (date && isFinite(d) && isFinite(r)){
        polls.push({date, D: d, R: r});
      }
    }
    polls.sort((a,b)=>a.date-b.date);
    if (!polls.length){ console.warn("No valid Hispanic polls"); return; }

    // Rolling last-N average (normalized to 100)
    const n = Math.min(HISPANIC_POLL_WINDOW, polls.length);
    let sumD=0, sumR=0;
    for (let i=polls.length-n; i<polls.length; i++){
      sumD += polls[i].D;
      sumR += polls[i].R;
    }
    const avgD = sumD/n, avgR = sumR/n;
    HISPANIC_GB = normalizePair(avgD, avgR);
    console.log(`Hispanic GB (last ${n} polls): D ${HISPANIC_GB.D.toFixed(1)} R ${HISPANIC_GB.R.toFixed(1)}`);
  }catch(e){
    console.warn("trusted_hispanic_polls.csv not loaded:", e);
  }
}

/* ---------- Majority probability (exact Poisson-binomial) ---------- */
function chamberMajorityProbExact(modeKey, cachedIndNat){
  const rules = SEAT_RULES[modeKey];
  const ratios = DATA[modeKey].ratios;

  const upSeats = rules.total - rules.baseD - rules.baseR;
  const keys = Object.keys(ratios);
  const modeled = keys.length;
  const missing = Math.max(0, upSeats - modeled);

  const pDem = [];
  for (const key of keys){
    const m = (modeKey === "house")
      ? getHouseModel(key)
      : getStateModel(modeKey, key, cachedIndNat);
    pDem.push(m ? m.winProb.pD : 0.5);
  }
  for (let i=0;i<missing;i++) pDem.push(0.5);

  let dist = new Array(pDem.length+1).fill(0);
  dist[0] = 1;
  for (let i=0;i<pDem.length;i++){
    const p = clamp(pDem[i], 0, 1);
    const nxt = new Array(pDem.length+1).fill(0);
    for (let k=0;k<=i;k++){
      nxt[k]   += dist[k] * (1-p);
      nxt[k+1] += dist[k] * p;
    }
    dist = nxt;
  }

  const needWinsForDemMajority = Math.max(0, rules.majorityLine - rules.baseD);
  let pDemMaj = 0;
  for (let k=needWinsForDemMajority; k<dist.length; k++) pDemMaj += dist[k];

  const pRepMaj = clamp(1 - pDemMaj, 0, 1);
  return { pDemMaj, pRepMaj, upSeats, modeled, missing };
}
function senateMajorityProbExact(cachedIndNat){ return chamberMajorityProbExact("senate", cachedIndNat); }
function houseMajorityProbExact(){ return chamberMajorityProbExact("house", null); }


/* ---------- UI: sliders ---------- */
function chevronSVG(){
  return `
    <svg class="chev" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 10l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8 14l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}


function sliderHTML(title, m, sigma){
  const min=-25, max=25;
  const mm = clamp(m, min, max);
  const left = clamp(mm - sigma, min, max);
  const right= clamp(mm + sigma, min, max);
  const toPct = v => ((v-min)/(max-min))*100;

  const markerLeft = toPct(mm);
  const bandLeft = toPct(left);
  const bandWidth = Math.max(0, toPct(right) - toPct(left));

  const crosses0 = (left < 0 && right > 0);
  let bandBg = "";
  if (crosses0){
    const pivot = ((0-left)/(right-left))*100;
    bandBg = `linear-gradient(to right, var(--blue-soft) 0%, var(--blue-soft) ${pivot}%, var(--red-soft) ${pivot}%, var(--red-soft) 100%)`;
  } else if (right <= 0) bandBg = `var(--blue-soft)`;
  else bandBg = `var(--red-soft)`;

  const markerBg = (mm < 0) ? "var(--blue)" : (mm > 0 ? "var(--red)" : "var(--zero)");

  const ticks = [-25,-15,-5,0,5,15,25].map(t=>{
    const p = toPct(t);
    const cls = (t===0) ? "tickLabel tickZero" : (t<0 ? "tickLabel tickBlue" : "tickLabel tickRed");
    const glCls = (t===0) ? "gridline zeroLine" : "gridline";
    return `
      <div class="${glCls}" style="left:${p}%"></div>
      <div class="${cls}" style="left:${p}%">${t}</div>
    `;
  }).join("");

  return `
    <div class="sliderBlock">
      <div class="sliderLabelRow">
        <div class="sliderLabel">${title} ${chevronSVG()}</div>
        <div class="sliderValue">${fmtLead(mm)}</div>
      </div>
      <div class="axis">
        ${ticks}
        <div class="band" style="left:${bandLeft}%; width:${bandWidth}%; background:${bandBg};"></div>
        <div class="marker" style="left:${markerLeft}%; background:${markerBg};"></div>
      </div>
    </div>
  `;
}

function sliderEmptyHTML(title, note="No data"){
  const min=-25, max=25;
  const toPct = v => ((v-min)/(max-min))*100;
  const ticks = [-25,-15,-5,0,5,15,25].map(t=>{
    const p = toPct(t);
    const cls = (t===0) ? "tickLabel tickZero" : (t<0 ? "tickLabel tickBlue" : "tickLabel tickRed");
    const glCls = (t===0) ? "gridline zeroLine" : "gridline";
    return `
      <div class="${glCls}" style="left:${p}%"></div>
      <div class="${cls}" style="left:${p}%">${t}</div>
    `;
  }).join("");
  return `
    <div class="sliderBlock">
      <div class="sliderLabelRow">
        <div class="sliderLabel">${title} ${chevronSVG()}</div>
        <div class="sliderValue">${note}</div>
      </div>
      <div class="axis">${ticks}</div>
    </div>
  `;
}


function miniMeterHTML(label, m, note=null){
  const min = -25, max = 25;
  const safeLabel = label;

  if (!isFinite(m)){
    const val = (note !== null) ? note : "—";
    return `
      <div class="miniRow">
        <div class="miniLbl">${safeLabel}</div>
        <div class="miniVal">${val}</div>
        <div class="miniBar"><div class="miniZero"></div></div>
      </div>
    `;
  }

  const overflow = Math.abs(m) > max;

  // Visual scale stays at +/-25 for readability,
  // but the numeric readout should show the true value.
  const mm = clamp(m, min, max);
  const p = ((mm - min) / (max - min)) * 100;

  const cls = (m < 0) ? "blue" : (m > 0 ? "red" : "neutral");

  // Normal: fill from 0-line. Overflow: fill the whole bar (so it doesn't look like "exactly 25").
  const left = overflow ? 0 : Math.min(50, p);
  const width = overflow ? 100 : Math.abs(p - 50);

  return `
    <div class="miniRow">
      <div class="miniLbl">${safeLabel}</div>
      <div class="miniVal">${fmtLead(m)}</div>
      <div class="miniBar">
        <div class="miniZero"></div>
        <div class="miniFill ${cls}" style="left:${left}%; width:${width}%;"></div>
        <div class="miniDot ${cls}" style="left:${p}%"></div>
      </div>
    </div>
  `;
}


function buildDetailHTML(modeKey, key, cachedIndNat){
  const rows = [];

  if (modeKey === "house"){
    const model = getHouseModel(key);
    if (!model) return { header:null, body:`<div class="tiny">No model for this district.</div>` };

    const mFinal = marginRD(model.combinedPair);
    const gbM = marginRD(model.gbPair);

    const pD = Math.round(model.winProb.pD*100);
    const pR = Math.round(model.winProb.pR*100);

    rows.push(miniMeterHTML("Generic ballot", gbM));

    // Hispanic voter support row — only show if district has Hispanic data
    if (model.h_cd > 0 && HISPANIC_GB){
      const hispPct = (model.h_cd * 100).toFixed(0);
      const hispMargin = HISPANIC_GB.R - HISPANIC_GB.D;
      rows.push(miniMeterHTML(`Hispanic (${hispPct}%)`, hispMargin));
    }

    rows.push(miniMeterHTML("Polls", NaN, "—"));
    rows.push(miniMeterHTML("National trend", NaN, "—"));
    rows.push(miniMeterHTML("Final", mFinal));

    return {
      header: {
        resultText: `${fmtLead(mFinal)}`,
        probText: `D ${pD}% · R ${pR}%`,
        metaText: `D ${model.combinedPair.D.toFixed(1)} · R ${model.combinedPair.R.toFixed(1)}`,
        mFinal
      },
      body: rows.join("")
    };
  }

  const model = getStateModel(modeKey, key, cachedIndNat);
  if (!model) return { header:null, body:`<div class="tiny">No model for this state.</div>` };

  const mFinal = marginRD(model.combinedPair);
  const gbM = marginRD(model.gbPair);
  const pollM = model.pollPair ? marginRD(model.pollPair) : NaN;
  const indM  = model.indPair  ? marginRD(model.indPair)  : NaN;

  rows.push(miniMeterHTML("Generic ballot", gbM));
  rows.push(model.pollPair ? miniMeterHTML("Polls", pollM) : miniMeterHTML("Polls", NaN, "—"));
  rows.push((cachedIndNat && model.indPair) ? miniMeterHTML("National trend", indM) : miniMeterHTML("National trend", NaN, "—"));
  rows.push(miniMeterHTML("Final", mFinal));

  const pD = Math.round(model.winProb.pD*100);
  const pR = Math.round(model.winProb.pR*100);

  return {
    header: {
      resultText: `${fmtLead(mFinal)}`,
      probText: `D ${pD}% · R ${pR}%`,
      metaText: `D ${model.combinedPair.D.toFixed(1)} · R ${model.combinedPair.R.toFixed(1)}`,
      mFinal
    },
    body: rows.join("")
  };
}


/* ---------- Tooltip ---------- */
const tip = document.getElementById("tip");
const tipState = document.getElementById("tipState");
const tipWinner = document.getElementById("tipWinner");
const tipProb = document.getElementById("tipProb");
const tipMeta = document.getElementById("tipMeta");
const tipSliders = document.getElementById("tipSliders");
const tipResultBadge = document.getElementById("tipResultBadge");
const tipProbBadge = document.getElementById("tipProbBadge");

const TIP_SPARK_MAX_POINTS = 360;
const TIP_SPARK_CACHE = new Map();

function tipSparkHTML(){
  return `
    <div class="tipSparkWrap" aria-label="Win probability over time">
      <div class="tipSparkTitle">
        <span>Win probability</span>
        <span class="sparkPill" id="tipSparkVal">—</span>
      </div>
      <canvas id="tipSpark" aria-hidden="false"></canvas>
    </div>
  `;
}

function subsetGbSeriesByDays(days){
  const series = GB_SRC.series || [];
  if (!series.length) return [];
  if (!isFinite(days) || days <= 0) return series.slice();

  const last = parseDate(series[series.length-1].date);
  const cutoff = new Date(last);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return series.filter(p => parseDate(p.date) >= cutoff);
}

function getTipSparkDays(modeKey){
  const rng = "all"; // precomputed odds always use full range
  if (rng === "all") return NaN; // all history
  const d = parseInt(rng, 10);
  return (isFinite(d) && d > 0) ? d : NaN;
}

function drawProbSpark(canvas, values){
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(140, Math.round(rect.width || 240));
  const cssH = Math.max(40, Math.round(rect.height || 60));
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  if (!values || values.length < 2){
    // baseline only
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(0, cssH*0.5);
    ctx.lineTo(cssW, cssH*0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  const rootStyle = getComputedStyle(document.documentElement);
  const blue = rootStyle.getPropertyValue("--blue").trim() || "#2563eb";
  const red  = rootStyle.getPropertyValue("--red").trim()  || "#dc2626";
  const grid = "rgba(0,0,0,0.08)";

  // grid: 25/50/75%
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([2,2]);
  ctx.beginPath();
  for (const frac of [0.25, 0.5, 0.75]){
    const y = cssH * (1 - frac);
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  const n = values.length;

  // R line (1 - pD)
  ctx.strokeStyle = red;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i=0;i<n;i++){
    const p = 1 - Math.max(0, Math.min(1, values[i]));
    const x = (i/(n-1)) * (cssW-1);
    const y = (1 - p) * (cssH-1);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();

  // D line
  ctx.strokeStyle = blue;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i=0;i<n;i++){
    const p = Math.max(0, Math.min(1, values[i]));
    const x = (i/(n-1)) * (cssW-1);
    const y = (1 - p) * (cssH-1);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}

function computeWinProbSeries(modeKey, key, cachedIndNat, gbSub){
  const out = [];
  const series = gbSub || [];
  if (!series.length) return out;

  if (modeKey === "house"){
    const ratio = DATA.house.ratios[key];
    if (!ratio) return out;

    // Apply Hispanic swing adjustment (same as getHouseModel)
    let adjD = ratio.D, adjR = ratio.R;
    const meta = DATA.house.meta[key];
    const code = meta?.code;
    const h_cd = (code && HISPANIC_SHARE[code]) ? HISPANIC_SHARE[code] : 0;
    if (h_cd > 0 && HISPANIC_GB){
      const swingD = (HISPANIC_GB.D - HISPANIC_BASELINE.D) / HISPANIC_BASELINE.D;
      const swingR = (HISPANIC_GB.R - HISPANIC_BASELINE.R) / HISPANIC_BASELINE.R;
      adjD = ratio.D * (1 + h_cd * 0.75 * swingD);
      adjR = ratio.R * (1 + h_cd * 0.75 * swingR);
    }

    for (const pt of series){
      const gbNat = normalizePair(+pt.dem, +pt.rep);
      const cdD = adjD * gbNat.D;
      const cdR = adjR * gbNat.R;
      const s = cdD + cdR;
      const pair = (s > 0) ? {D: 100*cdD/s, R: 100*cdR/s} : {D:50, R:50};
      const pD = winProbFromMargin(marginRD(pair)).pD;
      out.push(pD);
    }
    return out;
  }

  const ratios = DATA[modeKey].ratios;
  const ratio = ratios[key];
  if (!ratio) return out;

  const pollRaw = DATA[modeKey].polls[key];
  const pollPair = computePollState(pollRaw);
  const pollSigma = pollRaw && isFinite(Number(pollRaw.S)) ? Number(pollRaw.S) : 3;

  const indNat = cachedIndNat;
  const indPair = (indNat) ? computeIndicatorState(indNat, ratio) : null;

  // Circuit breaker (mirrors getStateModel)
  let wGb = WEIGHTS.gb, wPolls = WEIGHTS.polls, wInd = WEIGHTS.ind;
  if (indPair){
    const indMax = Math.max(indPair.D, indPair.R);
    if (indMax >= 70){
      wPolls = 80;
      wGb    = 15;
      wInd   = 5;
    }
  }

  for (const pt of series){
    const gbNat = normalizePair(+pt.dem, +pt.rep);
    const gbPair = computeGenericBallotState(gbNat, ratio);

    const comps = [
      { pair: gbPair,   w: wGb,                          sigma: 5 },
      { pair: pollPair, w: pollPair ? wPolls : 0,         sigma: pollSigma },
      { pair: indPair,  w: indPair ? wInd : 0,            sigma: 5 },
    ];
    const combined = weightedCombine(comps);
    const pD = winProbFromMargin(marginRD(combined.pair)).pD;
    out.push(pD);
  }
  return out;
}

function renderTipSpark(modeKey, key, cachedIndNat){
  const canvas = document.getElementById("tipSpark");
  const label = document.getElementById("tipSparkVal");
  if (!canvas) return;

  const days = getTipSparkDays(modeKey);
  const gbSub = subsetGbSeriesByDays(days);
  const cacheKey = `${modeKey}|${key}|${days}|${GB_SRC.windowPolls}|${gbSub.length}`;

  let vals = TIP_SPARK_CACHE.get(cacheKey);
  if (!vals){
    vals = computeWinProbSeries(modeKey, key, cachedIndNat, gbSub);
    TIP_SPARK_CACHE.set(cacheKey, vals);
  }

  if (label && vals && vals.length){
    const last = vals[vals.length-1];
    label.textContent = `${Math.round(last*100)}%`;
  } else if (label){
    label.textContent = "—";
  }

  let drawVals = vals;
  if (drawVals && drawVals.length > TIP_SPARK_MAX_POINTS){
    const step = Math.ceil(drawVals.length / TIP_SPARK_MAX_POINTS);
    const tmp = [];
    for (let i=0;i<drawVals.length;i+=step) tmp.push(drawVals[i]);
    // ensure last point included
    if (tmp[tmp.length-1] !== drawVals[drawVals.length-1]) tmp.push(drawVals[drawVals.length-1]);
    drawVals = tmp;
  }

  drawProbSpark(canvas, drawVals);
}




function showTooltip(evt, modeKey, key, cachedIndNat){
  const detail = buildDetailHTML(modeKey, key, cachedIndNat);
  if (!detail.header) return;

  const { resultText, probText, metaText, mFinal } = detail.header;

  if (modeKey === "house"){
    const meta = DATA.house.meta[key] || {};
    const code = meta.code || key;
    tipState.textContent = code;
    tipMeta.textContent = (meta.name ? `${meta.name} · ${metaText}` : metaText);
  } else {
    const name = USPS_TO_NAME[key] || key;
    tipState.textContent = `${name} (${key})`;
    tipMeta.textContent = metaText;
  }

  const resDot = tipResultBadge.querySelector(".dot");
  resDot.classList.toggle("blue", mFinal <= 0);
  resDot.classList.toggle("red",  mFinal > 0);

  tipWinner.textContent = resultText;
  tipProb.textContent = probText;

  const probDot = tipProbBadge.querySelector(".dot");
  const pd = parseInt(probText.match(/D\s(\d+)%/)?.[1] || "50", 10);
  const pr = parseInt(probText.match(/R\s(\d+)%/)?.[1] || "50", 10);
  if (pd > pr){ probDot.classList.add("blue"); probDot.classList.remove("red"); }
  else if (pr > pd){ probDot.classList.add("red"); probDot.classList.remove("blue"); }
  else { probDot.classList.remove("blue"); probDot.classList.remove("red"); }

  tip.classList.toggle("compact", TOOLTIP_COMPACT);
  tipSliders.innerHTML = detail.body + ((GB_SRC.series && GB_SRC.series.length) ? tipSparkHTML() : "");

  tip.style.transform = "translate(0,0)";
  positionTooltip(evt);

  if (GB_SRC.series && GB_SRC.series.length){
    requestAnimationFrame(()=>renderTipSpark(modeKey, key, cachedIndNat));
  }
}

function positionTooltip(evt){
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;

  // Find the map card boundary if hovering within one
  const mapCard = evt.target?.closest?.(".mapCard");
  const bottomLimit = mapCard ? mapCard.getBoundingClientRect().bottom : window.innerHeight;

  let x = evt.clientX + pad;
  let y = evt.clientY + pad;

  if (x + w + pad > window.innerWidth) x = evt.clientX - w - pad;
  if (y + h > bottomLimit) y = evt.clientY - h - pad;
  if (y < 0) y = pad;

  tip.style.left = x + "px";
  tip.style.top  = y + "px";
}
function positionTooltipLeft(evt){
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;

  // Prefer left side of cursor
  let x = evt.clientX - w - pad;
  let y = evt.clientY + pad;

  // If off-screen left, flip to right
  if (x < pad) x = evt.clientX + pad;
  if (y + h + pad > window.innerHeight) y = evt.clientY - h - pad;

  tip.style.left = x + "px";
  tip.style.top  = y + "px";
}
function hideTooltip(){ tip.style.transform = "translate(-9999px,-9999px)"; }

/* ---------- Mini histogram hover ---------- */
const simTip = document.getElementById("simTip");
function showSimTip(evt, html){
  if (!simTip) return;
  simTip.innerHTML = html;
  const pad = 12;

  // Ensure size is measured
  simTip.style.transform = "translate(0,0)";
  simTip.style.left = "0px";
  simTip.style.top  = "0px";

  const w = simTip.offsetWidth;
  const h = simTip.offsetHeight;

  let x = evt.clientX + pad;
  let y = evt.clientY + pad;

  if (x + w + pad > window.innerWidth) x = evt.clientX - w - pad;
  if (y + h + pad > window.innerHeight) y = evt.clientY - h - pad;

  simTip.style.left = x + "px";
  simTip.style.top  = y + "px";
}
function hideSimTip(){
  if (!simTip) return;
  simTip.style.transform = "translate(-9999px,-9999px)";
}

function binSeatRange(hist, idx){
  const span = (hist.max - hist.min) || 1;
  const loF = hist.min + (idx / hist.bins) * span;
  const hiF = hist.min + ((idx + 1) / hist.bins) * span;

  let lo = Math.floor(loF + 1e-9);
  let hi = Math.floor(hiF - 1e-9);
  if (hi < lo) hi = lo;

  return { lo, hi };
}

function ensureSimHover(canvas){
  if (!canvas || canvas._simHoverAttached) return;
  canvas._simHoverAttached = true;

  canvas.addEventListener("mousemove", (ev)=>{
    const meta = canvas._simMeta;
    if (!meta || !meta.hist || !meta.hist.counts) return hideSimTip();

    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;

    const counts = meta.hist.counts;
    const n = counts.length || 1;
    let idx = Math.floor((x / rect.width) * n);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;

    const total = meta.total || counts.reduce((a,b)=>a+b,0) || 1;
    const pct = (counts[idx] / total) * 100;

    const bs = (meta.hist.binSize && isFinite(meta.hist.binSize)) ? meta.hist.binSize : 1;
    const startSeat = (meta.hist.min ?? 0) + idx*bs;
    const endSeat = startSeat + (bs - 1);

    const seatLabel = (bs > 1) ? `${startSeat}–${endSeat}` : `${startSeat}`;

    showSimTip(ev,
      `<div class="stDate">${seatLabel} D seats</div>` +
      `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stVal">${pct.toFixed(1)}%</span></div>`
    );
  });

  canvas.addEventListener("mouseleave", hideSimTip);
}


/* ---------- Multi-panel (Senate / Governor / House) ---------- */

const MODES = ["senate","governor","house"];
const IND_CACHE = { senate:null, governor:null, house:null };

const UI = {};   // per-mode element handles
const MAP = {};  // per-mode map handles


function initUI(mode){
  const root = document.querySelector(`.modeCol[data-mode='${mode}']`);
  if (!root) return null;

  UI[mode] = {
    root,
    topCard: root.querySelector(".topCard"),
    // top pills
    pillD: root.querySelector("[data-pill-d]"),
    pillR: root.querySelector("[data-pill-r]"),

    // seats summary
    seatsD: root.querySelector("[data-seats-d]"),
    seatsR: root.querySelector("[data-seats-r]"),
    simCanvas: root.querySelector("[data-sim-canvas]"),
    flips:  root.querySelector("[data-manual-flips]"),

    // map
    mapHelp: root.querySelector("[data-map-help]"),
    svgEl: root.querySelector("svg.mapSvg"),

    // (legacy / optional)
    bucketBody: root.querySelector("tbody.bucketBody"),

    // odds over time (auto)
    comboSvg: root.querySelector("[data-combo-svg]"),
    oddsStatus: root.querySelector("[data-odds-status]"),
  };

  return UI[mode];
}

/* ---------- Seat meter (per mode) ---------- */
function renderSeatTicks(ui, total, majorityLine){
  if (!ui?.seatTicks || !ui?.seatMajorityLine) return;

  let ticks = [];
  if (total >= 400){
    ticks = [0,100,200,300,400,total];
  } else if (total >= 100){
    ticks = [0,25,50,75,100];
    if (total !== 100) ticks[ticks.length-1] = total;
  } else if (total === 50){
    ticks = [0,10,20,30,40,50];
  } else {
    const step = Math.max(1, Math.round(total/5));
    ticks = [0, step, step*2, step*3, total];
  }

  ticks = Array.from(new Set(ticks)).sort((a,b)=>a-b);

  ui.seatTicks.innerHTML = ticks.map(t=>{
    const p = (t/total)*100;
    return `
      <div class="seatTickLine" style="left:${p}%"></div>
      <div class="seatTickLabel" style="left:${p}%">${t}</div>
    `;
  }).join("");

  ui.seatMajorityLine.style.left = `${(majorityLine/total)*100}%`;
}

function computeSeatTally(modeKey, cachedIndNat){
  const rules = SEAT_RULES[modeKey];
  const ratios = DATA[modeKey].ratios;

  let up = 0, winsD = 0, winsR = 0, toss = 0;

  for (const key of Object.keys(ratios)){
    const model = (modeKey === "house")
      ? getHouseModel(key)
      : getStateModel(modeKey, key, cachedIndNat);
    if (!model) continue;

    up += 1;

    const m = marginRD(model.combinedPair);
    if (!isFinite(m)) continue;

    if (Math.abs(m) < 1e-9){ winsD += 1; toss += 1; } 
    else if (m < 0) winsD += 1;
    else winsR += 1;
  }

  const totalD = rules.baseD + winsD;
  const totalR = rules.baseR + winsR;
  let other = rules.total - totalD - totalR;
  if (other < 0 && other > -0.001) other = 0;

  return { ...rules, up, winsD, winsR, toss, totalD, totalR, other };
}


function poissonBinomialDist(ps){
  const n = ps.length;
  const dist = new Array(n+1).fill(0);
  dist[0] = 1;

  for (const pRaw of ps){
    const p = clamp(pRaw, 0, 1);
    for (let k = n; k >= 1; k--){
      dist[k] = dist[k] * (1 - p) + dist[k-1] * p;
    }
    dist[0] = dist[0] * (1 - p);
  }
  return dist;
}


function histogramFromSamples(samples){
  // Discrete distribution: one bar per integer seat total (no bin ranges).
  let min = Infinity, max = -Infinity;
  for (let i=0;i<samples.length;i++){
    const v = samples[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min) || !isFinite(max)){
    min = 0; max = 0;
  }
  // Ensure integer bounds
  min = Math.floor(min);
  max = Math.floor(max);
  if (max < min) max = min;

  const n = (max - min + 1) || 1;
  const counts = new Array(n).fill(0);

  for (let i=0;i<samples.length;i++){
    const v = Math.floor(samples[i]);
    const idx = v - min;
    if (idx >= 0 && idx < n) counts[idx] += 1;
  }
  return { counts, min, max, isProb:false };
}


function histogramFromSamplesRange(samples, showMin, showMax){
  // Discrete distribution but only for a display window. Percentages remain relative to ALL sims.
  showMin = Math.floor(showMin);
  showMax = Math.floor(showMax);
  if (showMax < showMin) showMax = showMin;

  const counts = new Array(showMax - showMin + 1).fill(0);
  const total = samples.length || 1;

  for (let i=0;i<samples.length;i++){
    const v = Math.floor(samples[i]);
    if (v < showMin || v > showMax) continue;
    counts[v - showMin] += 1;
  }
  return { counts, min: showMin, max: showMax, isProb:false, total, binSize:1 };
}

function histogramFromProbDistRange(dist, base, showMin, showMax){
  // Poisson-binomial distribution, but only for a display window. Percentages remain absolute (sum may < 1).
  showMin = Math.floor(showMin);
  showMax = Math.floor(showMax);
  if (showMax < showMin) showMax = showMin;

  const baseI = Math.floor(base);
  const counts = new Array(showMax - showMin + 1).fill(0);
  for (let seats=showMin; seats<=showMax; seats++){
    const k = seats - baseI;
    if (k >= 0 && k < dist.length) counts[seats - showMin] = dist[k];
  }
  return { counts, min: showMin, max: showMax, isProb:true, total:1, binSize:1 };
}

function histogramFromSamplesBinned(samples, binSize, binOffset){
  // Binned distribution. Each bar represents a seat RANGE of width binSize.
  binSize = Math.max(1, Math.floor(binSize || 1));
  binOffset = Math.floor(binOffset || 0);

  let min = Infinity, max = -Infinity;
  for (let i=0;i<samples.length;i++){
    const v = Math.floor(samples[i]);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min) || !isFinite(max)){
    min = 0; max = 0;
  }

  const toBinStart = (v)=> Math.floor((v - binOffset) / binSize) * binSize + binOffset;

  const minB = toBinStart(min);
  const maxB = toBinStart(max);
  const n = Math.max(1, Math.floor((maxB - minB) / binSize) + 1);
  const counts = new Array(n).fill(0);
  const total = samples.length || 1;

  for (let i=0;i<samples.length;i++){
    const v = Math.floor(samples[i]);
    const b = toBinStart(v);
    const idx = Math.floor((b - minB) / binSize);
    if (idx >= 0 && idx < n) counts[idx] += 1;
  }

  return { counts, min: minB, max: (minB + (n-1)*binSize + (binSize-1)), isProb:false, total, binSize, binOffset };
}

function histogramFromProbDist(dist, base){
  // Discrete distribution from Poisson-binomial: one bar per integer seat total.
  const min = Math.floor(base);
  const max = Math.floor(base + dist.length - 1);
  const counts = dist.slice(); // probabilities
  return { counts, min, max, isProb:true };
}


function drawSeatSimMini(canvas, hist, controlThreshold){
  if (!canvas || !hist || !hist.counts) return;

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

  const counts = hist.counts;
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
  const neutral = "rgba(156,163,175,0.9)";

  ctx.globalAlpha = 0.82;

  const radius = Math.max(1, Math.round(1.5 * dpr));

  for (let i=0;i<n;i++){
    const frac = counts[i] / maxCount;
    const bh = Math.max(1, Math.round(frac * availH));
    const x = Math.floor(i * barW);
    const y = h - padBot - bh;
    const bw = Math.max(1, Math.ceil(barW - 1*dpr));

    const bs = (hist.binSize && isFinite(hist.binSize)) ? hist.binSize : 1;
    const seatVal = (hist.min ?? 0) + i*bs;

    if (!isFinite(controlThreshold)){
      ctx.fillStyle = neutral;
    } else {
      ctx.fillStyle = (seatVal >= controlThreshold) ? blue : red;
    }

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

  // Control threshold line at the boundary before the threshold seat value
  if (isFinite(controlThreshold)){
    const min = hist.min ?? 0;
    const bs = (hist.binSize && isFinite(hist.binSize)) ? hist.binSize : 1;
    const boundary = (controlThreshold - min) / (bs * n); // left edge of threshold bar
    const x = Math.round(clamp(boundary, 0, 1) * w);

    ctx.strokeStyle = lineCol;
    ctx.lineWidth = Math.max(1, Math.round(1*dpr));
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, h - padBot);
    ctx.stroke();
  }
}



function updateSeatMeterFor(modeKey){
  const ui = UI[modeKey];
  const rules = SEAT_RULES[modeKey];
  if (!ui || !rules) return;

  const tally = computeSeatTally(modeKey, IND_CACHE[modeKey]);

  // Seats (integer display)
  const d = Math.round(tally.totalD);
  const r = Math.round(tally.totalR);

  if (ui.seatsD) ui.seatsD.textContent = String(d);
  if (ui.seatsR) ui.seatsR.textContent = String(r);

  // Chamber control probabilities (from precomputed JSON — no client-side MC)
  const precomp = PRECOMPUTED_ODDS[modeKey];
  if (precomp && precomp.length){
    const latest = precomp[precomp.length - 1];
    const pD = clamp(+latest.pDem, 0, 1);
    const pR = clamp(1 - pD, 0, 1);
    if (ui.pillD) ui.pillD.textContent = (pD * 100).toFixed(1);
    if (ui.pillR) ui.pillR.textContent = (pR * 100).toFixed(1);
    if (ui.topCard){
      ui.topCard.classList.toggle("leads-d", pD > pR);
      ui.topCard.classList.toggle("leads-r", pR > pD);
    }
  }

  // Histogram from precomputed JSON (generated by compute_odds.js)
  if (ui.simCanvas){
    const thr = (modeKey === "senate") ? SENATE_CONTROL_RULE.demAtLeast : (modeKey === "governor") ? 25 : rules.majorityLine;
    const hist = PRECOMPUTED_HIST[modeKey] || null;
    ui._lastHist = hist;
    ui._lastMaj = thr;

    if (hist){
      drawSeatSimMini(ui.simCanvas, hist, thr);
      const total = hist.isProb ? 1 : ((hist.counts || []).reduce((a,b)=>a+b,0) || 1);
      ui.simCanvas._simMeta = { hist, threshold: thr, total };
      ensureSimHover(ui.simCanvas);
    } else {
      ui.simCanvas._simMeta = null;
      const ctx = ui.simCanvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, ui.simCanvas.width, ui.simCanvas.height);
    }
  }
}



/* ---------- Map (per mode) ---------- */
let STATE_GEO = null;
let HOUSE_SVG_TEXT = null;

async function loadStateGeo(){
  if (STATE_GEO) return STATE_GEO;
  const topo = await fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json").then(r=>r.json());
  const geo = topojson.feature(topo, topo.objects.states);
  STATE_GEO = geo;
  return STATE_GEO;
}

async function initMapForMode(modeKey){
  const ui = UI[modeKey];
  if (!ui?.svgEl) return;

  if (modeKey === "house") return initHouseMapForMode(ui);
  return initStateMapForMode(modeKey, ui);
}

async function initStateMapForMode(modeKey, ui){
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
      const active = st && DATA[modeKey].ratios[st];
      return active ? "state active" : "state";
    })
    .attr("data-st", d => fipsToUsps(d.id))
    .attr("d", d => pathGen(d))
    .attr("fill", "#e5e7eb")
    .on("mouseenter", (event, d)=>{
      const st = fipsToUsps(d.id);
      if (!st) return;
      if (!DATA[modeKey].ratios[st]) return;
      d3.select(event.currentTarget).classed("hovered", true);
      showTooltip(event, modeKey, st, IND_CACHE[modeKey]);
    })
    .on("mousemove", (event, d)=>{
      const st = fipsToUsps(d.id);
      if (!st) return;
      if (!DATA[modeKey].ratios[st]) return;
      positionTooltip(event);
    })
    .on("mouseleave", (event)=>{
      d3.select(event.currentTarget).classed("hovered", false);
      hideTooltip();
    });

  MAP[modeKey] = { kind:"states", svg, gRoot, projection, pathGen, width, height };

  // Click any active state → zoom to county view
  gRoot.selectAll(".state.active")
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      event.stopPropagation();
      const st = fipsToUsps(d.id);
      if (st) zoomToStateCounties(modeKey, st, d.id);
    });

  // Double-click or click background resets to US
  svg.on("dblclick", () => zoomBackToUS(modeKey));
  svg.on("click", (event) => {
    if (event.target.tagName === "svg") zoomBackToUS(modeKey);
  });
}

/* ---------- State → County Zoom ---------- */
let ALL_COUNTY_GEO = null;
let COUNTY_RATIOS = null; // loaded from json/county_ratios.json

async function loadCountyRatios(){
  if (COUNTY_RATIOS) return COUNTY_RATIOS;
  try{
    const resp = await fetch("json/county_ratios.json", {cache:"no-store"});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    COUNTY_RATIOS = await resp.json();
    console.log("County ratios loaded:", Object.keys(COUNTY_RATIOS).filter(k=>k!=="_TEMPLATE").join(", "));
  }catch(e){
    console.warn("county_ratios.json not loaded:", e);
    COUNTY_RATIOS = {};
  }
  return COUNTY_RATIOS;
}

async function loadAllCountyGeo(){
  if (ALL_COUNTY_GEO) return ALL_COUNTY_GEO;
  const resp = await fetch("https://cdn.jsdelivr.net/gh/plotly/datasets/geojson-counties-fips.json");
  if (!resp.ok) throw new Error(`County GeoJSON HTTP ${resp.status}`);
  ALL_COUNTY_GEO = await resp.json();
  // Log structure for debugging
  const f0 = ALL_COUNTY_GEO.features?.[0];
  console.log(`County GeoJSON: ${ALL_COUNTY_GEO.features?.length} features, type=${ALL_COUNTY_GEO.type}, sample id=${f0?.id}, sample props=${JSON.stringify(f0?.properties)}`);
  return ALL_COUNTY_GEO;
}

// FIPS state prefix (2-digit) from full county FIPS
function fipsStatePrefix(fips){ return String(fips).padStart(5,"0").slice(0,2); }

// State FIPS prefix from USPS code
const USPS_TO_FIPS_PREFIX = {
  AL:"01",AK:"02",AZ:"04",AR:"05",CA:"06",CO:"08",CT:"09",DE:"10",DC:"11",FL:"12",
  GA:"13",HI:"15",ID:"16",IL:"17",IN:"18",IA:"19",KS:"20",KY:"21",LA:"22",ME:"23",
  MD:"24",MA:"25",MI:"26",MN:"27",MS:"28",MO:"29",MT:"30",NE:"31",NV:"32",NH:"33",
  NJ:"34",NM:"35",NY:"36",NC:"37",ND:"38",OH:"39",OK:"40",OR:"41",PA:"42",RI:"44",
  SC:"45",SD:"46",TN:"47",TX:"48",UT:"49",VT:"50",VA:"51",WA:"53",WV:"54",WI:"55",WY:"56"
};

function getCountiesForState(allGeo, usps){
  const prefix = USPS_TO_FIPS_PREFIX[usps];
  if (!prefix) return [];
  return allGeo.features.filter(f => {
    // Try f.id
    if (f.id && String(f.id).padStart(5,"0").slice(0,2) === prefix) return true;
    // Try properties
    const p = f.properties || {};
    if (p.STATE === prefix) return true;
    if (p.STATEFP === prefix) return true;
    // Try GEO_ID format "0500000US48201"
    const gid = String(p.GEO_ID || p.GEOID || "").replace(/^0500000US/, "");
    if (gid && gid.padStart(5,"0").slice(0,2) === prefix) return true;
    return false;
  });
}

async function zoomToStateCounties(modeKey, usps, stateFips){
  const m = MAP[modeKey];
  if (!m) return;

  // If already zoomed, reset first
  if (m._countyZoomed) zoomBackToUS(modeKey, true);

  const allGeo = await loadAllCountyGeo();
  const counties = getCountiesForState(allGeo, usps);
  if (!counties.length) return;

  m.gRoot.selectAll(".countyG").remove();

  // Compute state margin for fallback coloring
  const stateModel = getStateModel(modeKey, usps, IND_CACHE[modeKey]);
  const stateMargin = stateModel ? marginRD(stateModel.combinedPair) : NaN;

  // Zoom to state bounds — offset to right side to leave room for tooltip on left
  const countyCollection = { type:"FeatureCollection", features: counties };
  const [[x0,y0],[x1,y1]] = d3.geoPath(m.projection).bounds(countyCollection);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 1 || bh < 1) return;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const pad = 1.15;
  const k = Math.min(m.width * 0.45 / (bw * pad), m.height / (bh * pad));
  const tx = m.width * 0.78 - cx * k;
  const ty = m.height / 2 - cy * k;

  m.gRoot.transition().duration(600)
    .attr("transform", `translate(${tx},${ty}) scale(${k})`);

  // Fade other states
  m.gRoot.selectAll(".state").transition().duration(400)
    .style("opacity", function(){ return this.getAttribute("data-st") === usps ? 0 : 0.12; });

  // Draw county layer — match by properties.NAME (reliable) not FIPS (inconsistent across sources)
  const countyG = m.gRoot.append("g").attr("class","countyG");

  const getCountyNameFromFeature = (d) => {
    const p = d.properties || {};
    return (p.NAME || p.name || p.COUNTY || "").toUpperCase();
  };

  countyG.selectAll("path")
    .data(counties)
    .join("path")
    .attr("d", d3.geoPath(m.projection))
    .attr("fill", d => {
      const name = getCountyNameFromFeature(d);
      const cd = COUNTY_RATIOS?.[usps]?.counties?.[name];
      if (cd) {
        const stModel = getStateModel(modeKey, usps, IND_CACHE[modeKey]);
        const stD = stModel ? stModel.combinedPair.D : (DATA[modeKey]?.gb?.D || 50);
        const stR = stModel ? stModel.combinedPair.R : (DATA[modeKey]?.gb?.R || 50);
        const rawD = stD * cd.dRatio, rawR = stR * cd.rRatio;
        const s = rawD + rawR;
        if (s > 0) return interpColor(100 * rawR / s - 100 * rawD / s);
      }
      return isFinite(stateMargin) ? interpColor(stateMargin) : "#e5e7eb";
    })
    .attr("stroke", "white")
    .attr("stroke-width", 0.3)
    .attr("vector-effect", "non-scaling-stroke")
    .style("cursor", "default")
    .on("mouseenter", (event, d) => {
      d3.select(event.currentTarget).attr("stroke","var(--ink)").attr("stroke-width",1);
      showCountyTooltip(event, modeKey, usps, getCountyNameFromFeature(d));
    })
    .on("mousemove", (event) => positionTooltipLeft(event))
    .on("mouseleave", (event) => {
      d3.select(event.currentTarget).attr("stroke","white").attr("stroke-width",0.3);
      hideTooltip();
    });

  m._countyZoomed = usps;
  updateMapControlBar(modeKey, usps);

  // Show pinned state info panel on left
  showStateInfoPanel(modeKey, usps);
}

function zoomBackToUS(modeKey, instant){
  const m = MAP[modeKey];
  if (!m || !m._countyZoomed) return;

  const dur = instant ? 0 : 600;
  m.gRoot.transition().duration(dur).attr("transform", "");
  m.gRoot.selectAll(".state").transition().duration(instant ? 0 : 400).style("opacity", 1);
  m.gRoot.selectAll(".countyG").transition().duration(instant ? 0 : 300).style("opacity", 0).remove();
  m._countyZoomed = false;
  updateMapControlBar(modeKey, null);
  hideStateInfoPanel(modeKey);
}

/* ---------- Map Control Bar ---------- */
function updateMapControlBar(modeKey, zoomedUsps){
  const root = document.querySelector(`.modeCol[data-mode='${modeKey}']`);
  if (!root) return;
  const backBtn = root.querySelector("[data-map-back]");
  const label = root.querySelector("[data-map-label]");
  if (zoomedUsps){
    const stateName = USPS_TO_NAME[zoomedUsps] || zoomedUsps;
    if (backBtn) backBtn.style.display = "";
    if (label) label.textContent = `${stateName} — county view`;
  } else {
    if (backBtn) backBtn.style.display = "none";
    if (label) label.textContent = "Click a state to zoom in";
  }
}

function setupMapControlBars(){
  for (const mode of ["senate","governor"]){
    const root = document.querySelector(`.modeCol[data-mode='${mode}']`);
    if (!root) continue;
    const backBtn = root.querySelector("[data-map-back]");
    if (backBtn){
      backBtn.addEventListener("click", () => zoomBackToUS(mode));
    }
  }
}

function showStateInfoPanel(modeKey, usps){
  const root = document.querySelector(`.modeCol[data-mode='${modeKey}']`);
  if (!root) return;
  const panel = root.querySelector("[data-state-panel]");
  if (!panel) return;

  const detail = buildDetailHTML(modeKey, usps, IND_CACHE[modeKey]);
  if (!detail.header){ panel.classList.remove("visible"); return; }

  const { resultText, probText, metaText, mFinal } = detail.header;
  const name = USPS_TO_NAME[usps] || usps;

  const dotColor = mFinal <= 0 ? "blue" : "red";
  const pd = parseInt(probText.match(/D\s(\d+)%/)?.[1] || "50", 10);
  const pr = parseInt(probText.match(/R\s(\d+)%/)?.[1] || "50", 10);
  const probDotColor = pd > pr ? "blue" : "red";

  panel.innerHTML = `
    <div class="tipTop">
      <div class="tipHeader">
        <h3 class="tipTitle">${usps}</h3>
        <div class="tipMeta">${metaText}</div>
      </div>
      <div class="tipSub">
        <span class="badge"><span class="dot ${dotColor}"></span>${resultText}</span>
        <span class="badge"><span class="dot ${probDotColor}"></span>${probText}</span>
      </div>
    </div>
    <div class="tipBody">
      ${detail.body}
      <div class="tipSparkWrap">
        <div class="tipSparkTitle">
          <span>Win prob</span>
          <span class="sparkPill" data-panel-spark-val>—</span>
        </div>
        <canvas data-panel-spark></canvas>
      </div>
    </div>
  `;

  panel.classList.add("visible");

  // Render spark chart (scope to this panel, not by global ID)
  requestAnimationFrame(() => {
    const canvas = panel.querySelector("[data-panel-spark]");
    const label = panel.querySelector("[data-panel-spark-val]");
    if (!canvas) return;

    const gbSub = (GB_SRC.series || []).slice();
    const vals = computeWinProbSeries(modeKey, usps, IND_CACHE[modeKey], gbSub);

    if (vals && vals.length && label){
      label.textContent = `${(vals[vals.length-1]*100).toFixed(0)}%`;
    }
    drawProbSpark(canvas, vals);
  });
}

function hideStateInfoPanel(modeKey){
  const root = document.querySelector(`.modeCol[data-mode='${modeKey}']`);
  if (!root) return;
  const panel = root.querySelector("[data-state-panel]");
  if (panel) panel.classList.remove("visible");
}

function showCountyTooltip(event, modeKey, usps, countyName){
  if (!countyName) return;

  const cd = COUNTY_RATIOS?.[usps]?.counties?.[countyName];

  if (!cd){
    // No county-level data — show name + state-level margin
    const stModel = getStateModel(modeKey, usps, IND_CACHE[modeKey]);
    const stMargin = stModel ? marginRD(stModel.combinedPair) : NaN;
    tipState.textContent = `${countyName} Co.`;
    tipMeta.textContent = `${usps} · state-level only`;
    tipWinner.textContent = isFinite(stMargin) ? fmtLead(stMargin) : "—";
    tipProb.textContent = "";
    const resDot = tipResultBadge.querySelector(".dot");
    resDot.classList.toggle("blue", stMargin <= 0);
    resDot.classList.toggle("red", stMargin > 0);
    tipSliders.innerHTML = "";
    tip.classList.toggle("compact", TOOLTIP_COMPACT);
    tip.style.transform = "translate(0,0)";
    positionTooltipLeft(event);
    return;
  }

  // Compute county estimate from state model × ratios
  const stModel = getStateModel(modeKey, usps, IND_CACHE[modeKey]);
  const stD = stModel ? stModel.combinedPair.D : (DATA[modeKey]?.gb?.D || 50);
  const stR = stModel ? stModel.combinedPair.R : (DATA[modeKey]?.gb?.R || 50);
  const rawD = stD * cd.dRatio, rawR = stR * cd.rRatio;
  const s = rawD + rawR;
  const estD = s > 0 ? 100 * rawD / s : 50;
  const estR = s > 0 ? 100 * rawR / s : 50;
  const margin = estR - estD;
  const wp = winProbFromMargin(margin);

  tipState.textContent = `${countyName} Co.`;
  tipMeta.textContent = `${usps} · ${modeKey === "senate" ? "Senate" : "Gov"} '26`;

  tipWinner.textContent = fmtLead(margin);
  const resDot = tipResultBadge.querySelector(".dot");
  resDot.classList.toggle("blue", margin <= 0);
  resDot.classList.toggle("red", margin > 0);

  const pD = Math.round(wp.pD * 100);
  const pR = Math.round(wp.pR * 100);
  tipProb.textContent = `D ${pD}% · R ${pR}%`;
  const probDot = tipProbBadge.querySelector(".dot");
  probDot.classList.toggle("blue", pD > pR);
  probDot.classList.toggle("red", pR > pD);

  // Build body with estimate + historical
  let bodyHTML = `
    <div class="miniRow">
      <span class="miniLbl">Estimate</span>
      <span class="miniVal" style="color:var(--blue)">${estD.toFixed(1)}%</span>
      <span class="miniVal" style="color:var(--red)">${estR.toFixed(1)}%</span>
    </div>
  `;

  if (cd.hist){
    const h = cd.hist;
    const rows = [];
    if (h.pres24) rows.push(["'24 Pres", h.pres24[0], h.pres24[1]]);
    if (h.gov22)  rows.push(["'22 Gov",  h.gov22[0],  h.gov22[1]]);
    if (h.pres20) rows.push(["'20 Pres", h.pres20[0], h.pres20[1]]);
    if (h.sen18)  rows.push(["'18 Sen",  h.sen18[0],  h.sen18[1]]);
    if (rows.length){
      bodyHTML += `
        <div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px;">
          <div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Historical</div>
          <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:2px 8px;font-size:11px;font-variant-numeric:tabular-nums;">
            ${rows.map(([label,d,r])=>`<span style="color:var(--muted);font-weight:700;">${label}</span><span style="color:var(--blue);font-weight:700;">${Number(d).toFixed(1)}</span><span style="color:var(--red);font-weight:700;">${Number(r).toFixed(1)}</span>`).join("")}
          </div>
        </div>
      `;
    }
  }

  tipSliders.innerHTML = bodyHTML;
  tip.classList.toggle("compact", TOOLTIP_COMPACT);
  tip.style.transform = "translate(0,0)";
  positionTooltipLeft(event);
}

async function initHouseMapForMode(ui){
  const width = 960, height = 600;
  const svg = d3.select(ui.svgEl);

  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  // Zoom group wraps everything — d3.zoom transforms this
  const gZoom = svg.append("g").attr("class","houseZoomG");
  const gRoot = gZoom.append("g");

  if (!HOUSE_SVG_TEXT){
    HOUSE_SVG_TEXT = await fetch("svg/house.svg", {cache:"no-store"}).then(r=>{
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
  }

  const doc = new DOMParser().parseFromString(HOUSE_SVG_TEXT, "image/svg+xml");
  const shapes = doc.getElementById("district-shapes");
  if (!shapes) throw new Error("svg/house.svg missing #district-shapes");

  const imported = document.importNode(shapes, true);
  gRoot.node().appendChild(imported);

  // Fit imported House SVG group to our viewBox (centers / fixes right-shift)
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

  // Tag district geometry for selection/styling
  gRoot.selectAll("#district-shapes *").each(function(){
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

    // Tag with state USPS for zoom grouping
    const meta = DATA.house.meta[did];
    if (meta?.usps) this.setAttribute("data-state", meta.usps);

    try{ this.style.fill = ""; }catch(e){}
  });

  // Hover tooltips
  gRoot.selectAll(".district.active")
    .on("mouseenter", (event)=>{
      let did = event.currentTarget.getAttribute("data-did") || event.currentTarget.id || "";
      if (did && !DATA.house.ratios[did]){
        const digits = String(did).replace(/\D/g, "");
        if (digits) did = digits.padStart(4,"0").slice(-4);
      }
      if (!did) return;
      if (!DATA.house.ratios[did]) return;

      d3.select(event.currentTarget).classed("hovered", true);
      showTooltip(event, "house", did, null);
    })
    .on("mousemove", (event)=>{
      let did = event.currentTarget.getAttribute("data-did") || event.currentTarget.id || "";
      if (did && !DATA.house.ratios[did]){
        const digits = String(did).replace(/\D/g, "");
        if (digits) did = digits.padStart(4,"0").slice(-4);
      }
      if (!did) return;
      if (!DATA.house.ratios[did]) return;
      positionTooltip(event);
    })
    .on("mouseleave", (event)=>{
      d3.select(event.currentTarget).classed("hovered", false);
      hideTooltip();
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
    setActiveZoomBtn("us");
  });

  MAP.house = { kind:"house", svg, gRoot, gZoom, zoom, width, height };

  // ── Setup zoom controls ──
  requestAnimationFrame(() => setupHouseZoomControls());
}

/* ---------- House map zoom presets ---------- */
// Metro areas defined by their core congressional district prefixes
const METRO_DISTRICTS = {
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

function setActiveZoomBtn(id){
  const root = document.querySelector('.modeCol[data-mode="house"]');
  if (!root) return;
  root.querySelectorAll(".zoomBtn").forEach(b => b.classList.toggle("active", b.dataset.zoom === id));
}

function zoomHouseTo(targetId){
  const m = MAP.house;
  if (!m?.zoom || !m?.svg) return;

  if (targetId === "us"){
    m.svg.transition().duration(500).call(m.zoom.transform, d3.zoomIdentity);
    setActiveZoomBtn("us");
    return;
  }

  // Collect district elements to zoom to
  let districts = d3.selectAll([]); // empty

  // Metro preset — match by district code
  const metroCodes = METRO_DISTRICTS[targetId];
  if (metroCodes){
    // Build lookup: district code → did
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
  setActiveZoomBtn(metroCodes ? targetId : "");
}

function setupHouseZoomControls(){
  const root = document.querySelector('.modeCol[data-mode="house"]');
  if (!root) return;

  // Populate state dropdown
  const select = root.querySelector("[data-zoom-select]");
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
      if (select.value) zoomHouseTo(select.value);
      select.value = "";
    });
  }

  // Preset buttons
  root.querySelectorAll(".zoomBtn[data-zoom]").forEach(btn=>{
    btn.addEventListener("click", ()=> zoomHouseTo(btn.dataset.zoom));
  });

  // "More…" metro dropdown
  const metroMore = root.querySelector("[data-zoom-metro-more]");
  if (metroMore){
    metroMore.addEventListener("change", ()=>{
      if (metroMore.value) zoomHouseTo(metroMore.value);
      metroMore.value = "";
    });
  }

  // Click district to zoom to its state
  const m = MAP.house;
  if (m?.gRoot){
    m.gRoot.selectAll(".district.active").on("click", (event)=>{
      const st = event.currentTarget.getAttribute("data-state");
      if (st) zoomHouseTo(st);
    });
  }
}

function recolorMapForMode(modeKey){
  const m = MAP[modeKey];
  if (!m?.gRoot) return;

  if (m.kind === "house"){
    m.gRoot.selectAll(".district").each(function(){
      const did = this.getAttribute("data-did");
      const ratio = DATA.house.ratios[did];

      if (!ratio){
        this.removeAttribute("display");
        this.style.fill = "#e5e7eb";
        this.classList.remove("filtered");
        return;
      }

      const model = getHouseModel(did);
      if (!model){
        this.removeAttribute("display");
        this.style.fill = "#e5e7eb";
        this.classList.add("filtered");
        return;
      }

      const mm = marginRD(model.combinedPair);
      this.removeAttribute("display");
      this.classList.remove("filtered");
      this.style.fill = interpColor(mm);
    });
    return;
  }

  m.gRoot.selectAll("path.state").each(function(){
    const st = this.getAttribute("data-st");
    const ratio = DATA[modeKey].ratios[st];

    if (!ratio){
      this.removeAttribute("display");
      this.style.fill = "#e5e7eb";
      this.setAttribute("fill", "#e5e7eb");
      this.classList.remove("active","filtered");
      return;
    }

    this.classList.add("active");

    const model = getStateModel(modeKey, st, IND_CACHE[modeKey]);
    if (!model){
      this.removeAttribute("display");
      this.style.fill = "#e5e7eb";
      this.setAttribute("fill", "#e5e7eb");
      this.classList.add("filtered");
      return;
    }

    const mm = marginRD(model.combinedPair);
    this.removeAttribute("display");
    this.classList.remove("filtered");
    this.style.fill = interpColor(mm);
  });
}

/* ---------- Bucket table (per mode) ---------- */
const BUCKET_ORDER = ["Likely D","Lean D","Tossup","Lean R","Likely R"];

function renderBucketTableForMode(modeKey){
  const ui = UI[modeKey];
  const gRoot = MAP[modeKey]?.gRoot;
  if (!ui?.bucketBody) return;

  const ratios = DATA[modeKey].ratios || {};
  const buckets = {};
  for (const k of BUCKET_ORDER) buckets[k] = [];

  for (const key of Object.keys(ratios)){
    const model = (modeKey === "house")
      ? getHouseModel(key)
      : getStateModel(modeKey, key, IND_CACHE[modeKey]);
    if (!model) continue;

    const mm = marginRD(model.combinedPair);
    const bKey = bucketKeyFromMargin(mm);
    if (!bKey) continue;

    const absM = Math.abs(mm);

    let label = key;
    let name = key;

    if (modeKey === "house"){
      const meta = DATA.house.meta[key] || {};
      label = meta.code || key;
      name = meta.name || label;
    } else {
      label = key;
      name = USPS_TO_NAME[key] || key;
    }

    let cls = "t";
    if (bKey === "Likely D" || bKey === "Lean D") cls = "d";
    if (bKey === "Lean R"   || bKey === "Likely R") cls = "r";

    buckets[bKey].push({ key, label, name, m: mm, absM, cls });
  }

  for (const k of BUCKET_ORDER){
    buckets[k].sort((a,b)=>a.absM - b.absM);
  }

  const maxLen = Math.max(...BUCKET_ORDER.map(k => buckets[k].length), 0);

  if (maxLen === 0){
    ui.bucketBody.innerHTML = `<tr><td colspan="5"><div class="raceEmpty" style="height:72px;justify-content:center;">No competitive races</div></td></tr>`;
    return;
  }

  ui.bucketBody.innerHTML = "";
  for (let i=0; i<maxLen; i++){
    const tr = document.createElement("tr");

    for (const k of BUCKET_ORDER){
      const td = document.createElement("td");
      const item = buckets[k][i];

      if (!item){
        const ph = document.createElement("div");
        ph.className = "raceEmpty";
        ph.innerHTML = "—";
        td.appendChild(ph);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `raceItem ${item.cls}`;
        btn.setAttribute("data-key", item.key);
        btn.title = item.name;

        const top = document.createElement("div");
        top.className = "raceTop";
        top.textContent = item.label;

        const mid = document.createElement("div");
        mid.className = "raceName";
        mid.textContent = item.name;

        const bot = document.createElement("div");
        bot.className = "raceBottom";
        bot.textContent = fmtLead(item.m);

        btn.appendChild(top);
        btn.appendChild(mid);
        btn.appendChild(bot);

        const allSel = (modeKey === "house") ? ".district" : "path.state";
        const oneSel = (modeKey === "house")
          ? `.district[data-did='${item.key}']`
          : `path.state[data-st='${item.key}']`;

        btn.addEventListener("mouseenter", ()=>{
          const evt = pseudoEvtFromEl(btn);
          showTooltip(evt, modeKey, item.key, IND_CACHE[modeKey]);
          gRoot?.selectAll(allSel).classed("focus", false);
          gRoot?.selectAll(oneSel).classed("focus", true);
        });
        btn.addEventListener("mouseleave", ()=>{
          hideTooltip();
          gRoot?.selectAll(allSel).classed("focus", false);
        });
        btn.addEventListener("click", ()=>{
          const evt = pseudoEvtFromEl(btn);
          showTooltip(evt, modeKey, item.key, IND_CACHE[modeKey]);
        });

        td.appendChild(btn);
      }

      tr.appendChild(td);
    }

    ui.bucketBody.appendChild(tr);
  }
}


/* ---------- House odds over time (daily 10k sims from GB series) ---------- */
/* ---------- Precomputed odds (loaded from JSON, generated by compute_odds.js) ---------- */
const PRECOMPUTED_ODDS = { senate: null, governor: null, house: null };
const PRECOMPUTED_HIST = { senate: null, governor: null, house: null };

function houseRatioArraysSorted(){
  const keys = Object.keys(DATA.house.ratios || {}).slice().sort();
  const d = new Float32Array(keys.length);
  const r = new Float32Array(keys.length);
  for (let i=0;i<keys.length;i++){
    const rr = DATA.house.ratios[keys[i]];
    d[i] = (rr && isFinite(rr.D)) ? rr.D : 1;
    r[i] = (rr && isFinite(rr.R)) ? rr.R : 1;
  }
  return { keys, d, r };
}

function stateArraysSorted(modeKey){
  const keys = Object.keys(DATA[modeKey]?.ratios || {}).slice().sort();
  const n = keys.length;
  const ratioD = new Float32Array(n);
  const ratioR = new Float32Array(n);
  const pollD  = new Float32Array(n);
  const pollR  = new Float32Array(n);
  const pollS  = new Float32Array(n);
  for (let i=0;i<n;i++){
    const k = keys[i];
    const rr = DATA[modeKey].ratios[k];
    ratioD[i] = (rr && isFinite(rr.D)) ? rr.D : 1;
    ratioR[i] = (rr && isFinite(rr.R)) ? rr.R : 1;

    const pp = DATA[modeKey]?.polls ? DATA[modeKey].polls[k] : null;
    pollD[i] = (pp && isFinite(pp.D)) ? pp.D : NaN;
    pollR[i] = (pp && isFinite(pp.R)) ? pp.R : NaN;
    pollS[i] = (pp && isFinite(pp.S)) ? pp.S : 3;
  }
  return { keys, ratioD, ratioR, pollD, pollR, pollS };
}

function setOddsStatus(modeKey, msg){
  const ui = UI[modeKey];
  if (ui?.oddsStatus) ui.oddsStatus.textContent = msg || "";
}
function setHouseOddsStatus(msg){ setOddsStatus("house", msg); }

async function loadPrecomputedOdds(modeKey){
  const file = `json/${modeKey}_odds.json`;
  try{
    const resp = await fetch(file, {cache:"no-store"});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    const results = j.results || [];
    PRECOMPUTED_ODDS[modeKey] = results;
    if (j.latestHist) PRECOMPUTED_HIST[modeKey] = j.latestHist;
    renderComboChart(modeKey, results);
    setOddsStatus(modeKey, `${results.length} days • precomputed ${j.config?.sims?.toLocaleString() || "10k"} sims/day`);
  }catch(e){
    console.warn(`Could not load ${file}:`, e);
    setOddsStatus(modeKey, `No precomputed odds (${file} not found)`);
  }
}


function renderComboChart(modeKey, data, chartMode){
  const ui = UI[modeKey];
  const svgEl = ui?.comboSvg;
  if (!svgEl) return;

  ui._lastOdds = data;
  const mode = chartMode || ui._chartMode || "prob";
  ui._chartMode = mode;

  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(200, Math.floor(rect.width || 360));
  const height = Math.max(100, Math.floor(rect.height || 180));

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const m = {l:34, r:8, t:8, b:20};
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;

  const parsed = (data||[]).map(d=>({
    date: parseDate(d.date),
    pDem: +d.pDem,
    pRep: 1 - (+d.pDem),
    expDem: +d.expDem
  })).filter(d=>d.date && isFinite(d.pDem) && isFinite(d.expDem));

  if (!parsed.length){
    setOddsStatus(modeKey, "No data.");
    return;
  }

  const x = d3.scaleTime()
    .domain(d3.extent(parsed, d=>d.date))
    .range([m.l, m.l+iw]);

  const xAxis = d3.axisBottom(x)
    .ticks(Math.min(5, Math.floor(iw/70)))
    .tickFormat(d3.timeFormat("%b"));

  if (mode === "seats"){
    const rules = SEAT_RULES[modeKey];
    const seatTotal = rules?.total ?? 0;
    const maj = (modeKey === "senate") ? SENATE_CONTROL_RULE.demAtLeast : (rules?.majorityLine ?? Math.floor(seatTotal/2)+1);

    const ext = d3.extent(parsed, d=>d.expDem);
    const pad = 3;
    const yMin = clamp((ext[0]??0)-pad, 0, seatTotal||1000);
    const yMax = clamp((ext[1]??(seatTotal||0))+pad, 0, seatTotal||1000);
    const y = d3.scaleLinear().domain([yMin, yMax]).range([m.t+ih, m.t]).nice();
    const yAxis = d3.axisLeft(y).ticks(5).tickFormat(d=>`${Math.round(d)}`);

    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${m.t+ih})`).call(xAxis);
    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${m.l},0)`).call(yAxis);

    // Horizontal gridlines
    y.ticks(5).forEach(t=>{
      svg.append("line").attr("x1",m.l).attr("x2",m.l+iw)
        .attr("y1",y(t)).attr("y2",y(t))
        .attr("stroke","var(--line)").attr("stroke-width",1)
        .attr("stroke-dasharray","3 3").attr("opacity",0.5);
    });

    if (isFinite(maj) && maj >= y.domain()[0] && maj <= y.domain()[1]){
      svg.append("line").attr("class","seatMajLine")
        .attr("x1",m.l).attr("x2",m.l+iw).attr("y1",y(maj)).attr("y2",y(maj));
      svg.append("text").attr("class","seatMajLabel")
        .attr("x",m.l+iw-2).attr("y",y(maj)-4).attr("text-anchor","end").text(`${maj}`);
    }

    const lineD = d3.line().x(d=>x(d.date)).y(d=>y(d.expDem)).curve(d3.curveMonotoneX);
    svg.append("path").datum(parsed).attr("class","seatsLine").attr("d",lineD);

    if (seatTotal > 0){
      const lineR = d3.line().x(d=>x(d.date)).y(d=>y(seatTotal - d.expDem)).curve(d3.curveMonotoneX);
      svg.append("path").datum(parsed).attr("class","seatsLineR").attr("d",lineR);
    }

    const dotD = svg.append("circle").attr("class","dotDem").attr("r",4).style("opacity",0);
    const dotR = svg.append("circle").attr("class","dotRep").attr("r",4).style("opacity",0);
    const bisect = d3.bisector(d=>d.date).left;

    svg.append("rect").attr("x",m.l).attr("y",m.t).attr("width",iw).attr("height",ih)
      .style("fill","transparent").style("cursor","crosshair")
      .on("mousemove",(ev)=>{
        const [mx]=d3.pointer(ev);const xd=x.invert(mx);
        const i=clamp(bisect(parsed,xd),1,parsed.length-1);
        const a=parsed[i-1],b=parsed[i];
        const d=(xd-a.date)>(b.date-xd)?b:a;
        dotD.attr("cx",x(d.date)).attr("cy",y(d.expDem)).style("opacity",1);
        if(seatTotal>0) dotR.attr("cx",x(d.date)).attr("cy",y(seatTotal-d.expDem)).style("opacity",1);
        showSimTip(ev,
          `<div class="stDate">${ds(d.date)}</div>`+
          `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">D</span><span class="stVal">${d.expDem.toFixed(1)}</span></div>`+
          (seatTotal>0?`<div class="stRow"><span class="stDot" style="background:var(--red)"></span><span class="stLbl">R</span><span class="stVal">${(seatTotal-d.expDem).toFixed(1)}</span></div>`:"")
        );
      })
      .on("mouseleave",()=>{dotD.style("opacity",0);dotR.style("opacity",0);hideSimTip();});

  } else {
    const y = d3.scaleLinear().domain([0,1]).range([m.t+ih, m.t]);
    const yAxis = d3.axisLeft(y).ticks(5).tickFormat(d=>`${Math.round(d*100)}%`);

    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${m.t+ih})`).call(xAxis);
    svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${m.l},0)`).call(yAxis);

    // Horizontal gridlines
    y.ticks(5).forEach(t=>{
      svg.append("line").attr("x1",m.l).attr("x2",m.l+iw)
        .attr("y1",y(t)).attr("y2",y(t))
        .attr("stroke","var(--line)").attr("stroke-width",1)
        .attr("stroke-dasharray","3 3").attr("opacity",0.5);
    });

    svg.append("line").attr("class","seatMajLine")
      .attr("x1",m.l).attr("x2",m.l+iw).attr("y1",y(0.5)).attr("y2",y(0.5));

    const lineD = d3.line().x(d=>x(d.date)).y(d=>y(d.pDem)).curve(d3.curveMonotoneX);
    svg.append("path").datum(parsed).attr("class","lineDem").attr("d",lineD);

    const lineR = d3.line().x(d=>x(d.date)).y(d=>y(d.pRep)).curve(d3.curveMonotoneX);
    svg.append("path").datum(parsed).attr("class","lineRep").attr("d",lineR);

    const dotD = svg.append("circle").attr("class","dotDem").attr("r",4).style("opacity",0);
    const dotR = svg.append("circle").attr("class","dotRep").attr("r",4).style("opacity",0);
    const bisect = d3.bisector(d=>d.date).left;

    svg.append("rect").attr("x",m.l).attr("y",m.t).attr("width",iw).attr("height",ih)
      .style("fill","transparent").style("cursor","crosshair")
      .on("mousemove",(ev)=>{
        const [mx]=d3.pointer(ev);const xd=x.invert(mx);
        const i=clamp(bisect(parsed,xd),1,parsed.length-1);
        const a=parsed[i-1],b=parsed[i];
        const d=(xd-a.date)>(b.date-xd)?b:a;
        dotD.attr("cx",x(d.date)).attr("cy",y(d.pDem)).style("opacity",1);
        dotR.attr("cx",x(d.date)).attr("cy",y(d.pRep)).style("opacity",1);
        showSimTip(ev,
          `<div class="stDate">${ds(d.date)}</div>`+
          `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">D</span><span class="stVal">${(d.pDem*100).toFixed(1)}%</span></div>`+
          `<div class="stRow"><span class="stDot" style="background:var(--red)"></span><span class="stLbl">R</span><span class="stVal">${(d.pRep*100).toFixed(1)}%</span></div>`
        );
      })
      .on("mouseleave",()=>{dotD.style("opacity",0);dotR.style("opacity",0);hideSimTip();});
  }
}

function initChartTabs(modeKey){
  const root = document.querySelector(`.modeCol[data-mode='${modeKey}']`);
  if (!root) return;
  const tabs = root.querySelectorAll("[data-chart-tab]");
  const ylabel = root.querySelector("[data-chart-ylabel]");
  tabs.forEach(tab=>{
    tab.addEventListener("click", ()=>{
      tabs.forEach(t=>t.classList.remove("active"));
      tab.classList.add("active");
      const mode = tab.dataset.chartTab;
      if (ylabel) ylabel.textContent = (mode === "seats") ? "Expected seats" : "Win probability";
      const data = PRECOMPUTED_ODDS[modeKey];
      if (data) renderComboChart(modeKey, data, mode);
    });
  });
}


function renderOddsChart(modeKey, data){
  const ui = UI[modeKey];
  const svgEl = ui?.oddsSvg;
  if (!svgEl) return;

  ui._lastOdds = data;

  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 800));
  const height = Math.max(170, Math.floor(rect.height || 190));

  // Clear
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const m = {l:46, r:12, t:10, b:26};
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;

  const parsed = (data||[]).map(d=>({
    date: parseDate(d.date),
    pDem: +d.pDem,
    expDem: +d.expDem
  })).filter(d=>d.date && isFinite(d.pDem));

  if (!parsed.length){
    setOddsStatus(modeKey, "No GB series available.");
    return;
  }

  const x = d3.scaleTime()
    .domain(d3.extent(parsed, d=>d.date))
    .range([m.l, m.l+iw]);

  const y = d3.scaleLinear()
    .domain([0,1])
    .range([m.t+ih, m.t])
    .nice();

  const xAxis = d3.axisBottom(x).ticks(Math.min(6, Math.floor(iw/110))).tickFormat(d3.timeFormat("%b %d"));
  const yAxis = d3.axisLeft(y).ticks(4).tickFormat(d=>`${Math.round(d*100)}%`);

  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${m.t+ih})`).call(xAxis);
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${m.l},0)`).call(yAxis);

  const line = d3.line()
    .x(d=>x(d.date))
    .y(d=>y(d.pDem))
    .curve(d3.curveMonotoneX);

  svg.append("path")
    .datum(parsed)
    .attr("class","oddsLine")
    .attr("d", line);

  const dot = svg.append("circle")
    .attr("class","oddsDot")
    .attr("r", 4)
    .style("opacity", 0);

  const bisect = d3.bisector(d=>d.date).left;

  svg.append("rect")
    .attr("x", m.l)
    .attr("y", m.t)
    .attr("width", iw)
    .attr("height", ih)
    .style("fill","transparent")
    .style("cursor","crosshair")
    .on("mousemove", (ev)=>{
      const [mx] = d3.pointer(ev);
      const xd = x.invert(mx);
      const i = clamp(bisect(parsed, xd), 1, parsed.length-1);
      const a = parsed[i-1], b = parsed[i];
      const d = (xd - a.date) > (b.date - xd) ? b : a;

      dot
        .attr("cx", x(d.date))
        .attr("cy", y(d.pDem))
        .style("opacity", 1);

      const pct = (d.pDem*100).toFixed(1);
      const seats = isFinite(d.expDem) ? d.expDem.toFixed(1) : "—";

      showSimTip(ev,
        `<div class="stDate">${ds(d.date)}</div>` +
        `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">P(D)</span><span class="stVal">${pct}%</span></div>` +
        `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">E[D]</span><span class="stVal">${seats}</span></div>`
      );
    })
    .on("mouseleave", ()=>{
      dot.style("opacity", 0);
      hideSimTip();
    });
}


function renderSeatAvgChart(modeKey, data){
  const ui = UI[modeKey];
  const svgEl = ui?.seatsSvg;
  if (!svgEl) return;

  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 800));
  const height = Math.max(170, Math.floor(rect.height || 190));

  // Clear
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  const m = {l:46, r:12, t:10, b:26};
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;

  const parsed = (data||[]).map(d=>({
    date: parseDate(d.date),
    pDem: +d.pDem,
    expDem: +d.expDem
  })).filter(d=>d.date && isFinite(d.expDem));

  if (!parsed.length) return;

  const rules = SEAT_RULES[modeKey];
  const seatTotal = rules?.total ?? 0;
  const maj = (modeKey === "senate") ? SENATE_CONTROL_RULE.demAtLeast : (rules?.majorityLine ?? Math.floor(seatTotal/2)+1);

  const x = d3.scaleTime()
    .domain(d3.extent(parsed, d=>d.date))
    .range([m.l, m.l+iw]);

  const ext = d3.extent(parsed, d=>d.expDem);
  const pad = 3;
  const yMin = clamp((ext[0] ?? 0) - pad, 0, seatTotal);
  const yMax = clamp((ext[1] ?? seatTotal) + pad, 0, seatTotal);
  const y = d3.scaleLinear()
    .domain([yMin, yMax])
    .range([m.t+ih, m.t])
    .nice();

  const xAxis = d3.axisBottom(x).ticks(Math.min(6, Math.floor(iw/110))).tickFormat(d3.timeFormat("%b %d"));
  const yAxis = d3.axisLeft(y).ticks(5).tickFormat(d=>`${Math.round(d)}`);

  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(0,${m.t+ih})`).call(xAxis);
  svg.append("g").attr("class","oddsAxis").attr("transform",`translate(${m.l},0)`).call(yAxis);

  // Majority line
  if (isFinite(maj) && maj >= y.domain()[0] && maj <= y.domain()[1]){
    svg.append("line")
      .attr("class","seatMajLine")
      .attr("x1", m.l)
      .attr("x2", m.l+iw)
      .attr("y1", y(maj))
      .attr("y2", y(maj));

    svg.append("text")
      .attr("class","seatMajLabel")
      .attr("x", m.l+iw-2)
      .attr("y", y(maj)-6)
      .attr("text-anchor","end")
      .text(`Maj ${maj}`);
  }

  const line = d3.line()
    .x(d=>x(d.date))
    .y(d=>y(d.expDem))
    .curve(d3.curveMonotoneX);

  svg.append("path")
    .datum(parsed)
    .attr("class","seatsLine")
    .attr("d", line);

  const dot = svg.append("circle")
    .attr("class","seatsDot")
    .attr("r", 4)
    .style("opacity", 0);

  const bisect = d3.bisector(d=>d.date).left;

  svg.append("rect")
    .attr("x", m.l)
    .attr("y", m.t)
    .attr("width", iw)
    .attr("height", ih)
    .style("fill","transparent")
    .style("cursor","crosshair")
    .on("mousemove", (ev)=>{
      const [mx] = d3.pointer(ev);
      const xd = x.invert(mx);
      const i = clamp(bisect(parsed, xd), 1, parsed.length-1);
      const a = parsed[i-1], b = parsed[i];
      const d = (xd - a.date) > (b.date - xd) ? b : a;

      dot
        .attr("cx", x(d.date))
        .attr("cy", y(d.expDem))
        .style("opacity", 1);

      const seats = d.expDem.toFixed(1);
      const pct = isFinite(d.pDem) ? (d.pDem*100).toFixed(1) : "—";

      showSimTip(ev,
        `<div class="stDate">${ds(d.date)}</div>` +
        `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">E[D]</span><span class="stVal">${seats}</span></div>` +
        `<div class="stRow"><span class="stDot" style="background:var(--blue)"></span><span class="stLbl">P(D)</span><span class="stVal">${pct}%</span></div>`
      );
    })
    .on("mouseleave", ()=>{
      dot.style("opacity", 0);
      hideSimTip();
    });
}

function setupOddsUI(modeKey){
  const ui = UI[modeKey];
  if (!ui?.comboSvg) return;
  // Odds are precomputed; just render from cache
  if (PRECOMPUTED_ODDS[modeKey]){
    renderComboChart(modeKey, PRECOMPUTED_ODDS[modeKey]);
  }
}

/* ---------- Boot ---------- */
(async function boot(){
  const ok = await loadCSV();
  if (!ok) return;

  const okHouse = await loadHouseRatios();
  if (!okHouse) return;

  // Generic ballot from polls.json (produced by poll.html)
  await loadGenericBallotFromPollsJSON();
  setupGbControlsUI();

  // Optional: manual state polls by date (state_polls_by_date.csv)
  await loadStatePollsByDateCSV();
  applyLatestStatePollsToData();

  // County-level ratio data (for county zoom)
  await loadCountyRatios();

  // Hispanic CD polling adjustment (must load before House model runs)
  await loadHispanicCDShare();
  await loadHispanicPolls();

  // cache indicators per mode (House intentionally has none)
  IND_CACHE.senate = computeIndicatorNationalFromPolls("senate");
  IND_CACHE.governor = computeIndicatorNationalFromPolls("governor");
  IND_CACHE.house = null;

  // init all panels
  for (const mode of MODES){
    initUI(mode);
    initChartTabs(mode);
  }

  // Load precomputed odds (must happen before updateSeatMeterFor reads them)
  for (const mode of MODES){
    await loadPrecomputedOdds(mode);
  }

  for (const mode of MODES){
    await initMapForMode(mode);
    recolorMapForMode(mode);
    renderBucketTableForMode(mode);
    updateSeatMeterFor(mode);
  }

  setupMapControlBars();

  // Redraw charts on resize
  window.addEventListener("resize", ()=>{
    for (const mode of MODES){
      const ui = UI[mode];
      if (ui?.simCanvas && ui._lastHist){
        drawSeatSimMini(ui.simCanvas, ui._lastHist, ui._lastMaj);
      }
      if (PRECOMPUTED_ODDS[mode]){
        renderComboChart(mode, PRECOMPUTED_ODDS[mode]);
      }
    }
  }, {passive:true});
})();
