#!/usr/bin/env node
// compute_odds.js — Node.js CI script
// Runs Monte Carlo seat simulations for Senate, Governor, and House.
// First run computes all days from GB series; subsequent runs append only new days.
//
// Reads:  entries_all.csv, house_district_ratios_filled.csv, polls.json,
//         state_polls_by_date.csv (optional)
// Writes: senate_odds.json, governor_odds.json, house_odds.json

const fs = require("fs");

// ═══════════════════════════════════════════════════════
//  CONFIG — must match forecast.js
// ═══════════════════════════════════════════════════════
const PROB_ERROR_SD_PTS = 7;
const WEIGHTS = { gb: 35, polls: 50, ind: 15 };
const SEAT_RULES = {
  senate:   { total: 100, majorityLine: 51, baseR: 31, baseD: 34 },
  governor: { total: 50,  majorityLine: 26, baseR: 8,  baseD: 6  },
  house:    { total: 435, majorityLine: 218, baseR: 0, baseD: 0  },
};
const SENATE_CONTROL_LINE = 51;  // demAtLeast
const MC_SIMS           = 10000;
const SWING_RANGE       = 7;     // ±pts
const SWING_STEP        = 0.1;   // House grid step
const GB_WINDOW_POLLS   = 24;
const STATE_POLL_WINDOW = 6;
const FILTER_STRICT     = true;

// ═══════════════════════════════════════════════════════
//  MATH — shared with workers
// ═══════════════════════════════════════════════════════
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCDF(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

// Pre-compute win probability table
const WINP_MIN = -40, WINP_MAX = 40, WINP_STEP = 0.1;
const WINP_N = Math.round((WINP_MAX - WINP_MIN) / WINP_STEP) + 1;
const WINP_PD = new Float32Array(WINP_N);
for (let i = 0; i < WINP_N; i++) {
  const m = WINP_MIN + i * WINP_STEP;
  const z = m / PROB_ERROR_SD_PTS;
  WINP_PD[i] = 1 - clamp(normalCDF(z), 0, 1); // pDem
}

function winProbD(m) {
  if (!isFinite(m)) return 0.5;
  const mm = clamp(m, WINP_MIN, WINP_MAX);
  return WINP_PD[Math.round((mm - WINP_MIN) / WINP_STEP)] ?? 0.5;
}

function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalizePair(D, R) {
  const s = D + R;
  if (!isFinite(s) || s <= 0) return { D: 50, R: 50 };
  return { D: 100 * D / s, R: 100 * R / s };
}

function median(arr) {
  const a = arr.filter(x => isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length / 2);
  return (a.length % 2 === 1) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function toNum(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

// ═══════════════════════════════════════════════════════
//  SIMPLE CSV PARSER
// ═══════════════════════════════════════════════════════
function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = line.split(",");
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (vals[j] || "").trim();
    }
    rows.push(row);
  }
  return rows;
}

// ═══════════════════════════════════════════════════════
//  DATE HELPERS
// ═══════════════════════════════════════════════════════
function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ═══════════════════════════════════════════════════════
//  DATA LOADING
// ═══════════════════════════════════════════════════════
const DATA = {
  senate:   { gb: null, ratios: {}, polls: {} },
  governor: { gb: null, ratios: {}, polls: {} },
  house:    { gb: null, ratios: {}, polls: {}, meta: {} },
};

const NAME_TO_USPS = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",
  connecticut:"CT",delaware:"DE","district of columbia":"DC",florida:"FL",georgia:"GA",
  hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",
  louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",
  mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH",
  "new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",
  ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI",
  "south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",
  virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY"
};

function loadEntriesAll() {
  const text = fs.readFileSync("csv/entries_all.csv", "utf8");
  const rows = parseCSV(text);
  for (const row of rows) {
    const mode = String(row.mode || "").trim().toLowerCase();
    if (!DATA[mode]) continue;
    const st = String(row.state || "").trim().toUpperCase();
    const ratioD = toNum(row.ratioD), ratioR = toNum(row.ratioR);
    if (st && isFinite(ratioD) && isFinite(ratioR)) {
      DATA[mode].ratios[st] = { D: ratioD, R: ratioR };
    }
    const gbD = toNum(row.gbD), gbR = toNum(row.gbR);
    if (!DATA[mode].gb && isFinite(gbD) && isFinite(gbR)) {
      DATA[mode].gb = normalizePair(gbD, gbR);
    }
    const pollD = toNum(row.pollD), pollR = toNum(row.pollR), pollS = toNum(row.pollSigma);
    if (isFinite(pollD) && isFinite(pollR)) {
      DATA[mode].polls[st] = { D: pollD, R: pollR, S: isFinite(pollS) ? pollS : 3 };
    }
  }
  if (!DATA.senate.gb && DATA.governor.gb) DATA.senate.gb = DATA.governor.gb;
  if (!DATA.governor.gb && DATA.senate.gb) DATA.governor.gb = DATA.senate.gb;
  console.log(`  entries_all.csv: senate=${Object.keys(DATA.senate.ratios).length} gov=${Object.keys(DATA.governor.ratios).length} races`);
}

function loadHouseRatios() {
  const text = fs.readFileSync("csv/house_district_ratios_filled.csv", "utf8");
  const rows = parseCSV(text);
  for (const row of rows) {
    const rawId = String(row.path_id ?? "").trim();
    if (!rawId) continue;
    const did = rawId.padStart(4, "0");
    const dRatio = toNum(row.d_ratio), rRatio = toNum(row.r_ratio);
    if (isFinite(dRatio) && isFinite(rRatio)) {
      DATA.house.ratios[did] = { D: dRatio, R: rRatio };
    }
    // Build code (e.g. "TX-34") for Hispanic share matching
    const stateName = String(row.state_name ?? "").trim();
    const cd = parseInt(String(row.congressional_district_number ?? "").trim(), 10);
    const usps = NAME_TO_USPS[stateName.toLowerCase()] || "";
    if (usps) {
      const code = (cd === 0 || !isFinite(cd)) ? `${usps}-AL` : `${usps}-${String(cd).padStart(2,"0")}`;
      DATA.house.codes = DATA.house.codes || {};
      DATA.house.codes[did] = code;
    }
  }
  if (!DATA.house.gb) DATA.house.gb = DATA.senate.gb || DATA.governor.gb || { D: 50, R: 50 };
  console.log(`  house_district_ratios_filled.csv: ${Object.keys(DATA.house.ratios).length} districts`);
}

// ═══════════════════════════════════════════════════════
//  HISPANIC CD POLLING ADJUSTMENT
// ═══════════════════════════════════════════════════════
const HISPANIC_SHARE = {};  // code → h_cd (0-1)
let HISPANIC_GB = null;     // {D, R} normalized to 100

function loadHispanicCDShare() {
  if (!fs.existsSync("csv/cd_hispanic_share.csv")) {
    console.log("  cd_hispanic_share.csv: not found (optional, skipping)");
    return;
  }
  const text = fs.readFileSync("csv/cd_hispanic_share.csv", "utf8");
  const rows = parseCSV(text);
  let count = 0;
  for (const row of rows) {
    const cd = String(row.cd ?? "").trim();
    const hcd = parseFloat(row.h_cd);
    if (cd && isFinite(hcd)) { HISPANIC_SHARE[cd] = hcd; count++; }
  }
  console.log(`  cd_hispanic_share.csv: ${count} districts`);
}

function loadHispanicPolls() {
  if (!fs.existsSync("csv/trusted_hispanic_polls.csv")) {
    console.log("  trusted_hispanic_polls.csv: not found (optional, skipping)");
    return;
  }
  const text = fs.readFileSync("csv/trusted_hispanic_polls.csv", "utf8");
  const rows = parseCSV(text);
  const polls = [];
  for (const row of rows) {
    const d = parseFloat(row.Dem); const r = parseFloat(row.Rep);
    if (isFinite(d) && isFinite(r)) polls.push({ D: d, R: r });
  }
  if (!polls.length) return;
  const n = Math.min(12, polls.length);
  let sumD = 0, sumR = 0;
  for (let i = 0; i < n; i++) { sumD += polls[i].D; sumR += polls[i].R; }
  HISPANIC_GB = normalizePair(sumD / n, sumR / n);
  console.log(`  Hispanic GB (last ${n}): D ${HISPANIC_GB.D.toFixed(1)} R ${HISPANIC_GB.R.toFixed(1)}`);
}

function buildHispanicShareArray(keys) {
  // Build h_cd array aligned with sorted house ratio keys
  const hcd = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const code = DATA.house.codes?.[keys[i]];
    hcd[i] = (code && HISPANIC_SHARE[code]) ? HISPANIC_SHARE[code] : 0;
  }
  return hcd;
}

// ═══════════════════════════════════════════════════════
//  GENERIC BALLOT SERIES (from polls.json)
// ═══════════════════════════════════════════════════════
const AP = [
  { pattern: /yougov/ }, { pattern: /verasight/ }, { pattern: /ipsos/ },
  { pattern: /americanresearchgroup|arg\b/ }, { pattern: /tipp/ },
  { pattern: /emerson/ }, { pattern: /gallup/ }, { pattern: /marist/ },
  { pattern: /quinnipiac/ }, { pattern: /apnorc|ap\-norc|norc/ },
  { pattern: /marquette/ }, { pattern: /cnnssrs|cnn\/ssrs|ssrs/ },
  { pattern: /atlasintel|atlas/ }, { pattern: /beaconresearch|shaw/ },
  { pattern: /hartresearch|publicopinionstrategies/ },
  { pattern: /pewresearch|pew/ }, { pattern: /surveymonkey/ },
  { pattern: /leger/ }, { pattern: /massachusetts|umass|departmentofpoliticalscience/ },
  { pattern: /siena|newyorktimes/ }, { pattern: /foxnews/ },
  { pattern: /wallstreetjournal|wsj/ },
];

function normPollster(s) {
  return String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

function isAllowed(pollster) {
  if (!FILTER_STRICT) return true;
  const n = normPollster(pollster);
  if (!n) return false;
  return AP.some(x => x.pattern.test(n));
}

function norm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }

function getAns(p, keys) {
  if (!p || !Array.isArray(p.answers)) return null;
  const want = keys.map(norm);
  for (const a of p.answers) {
    const c = norm(a.choice || "");
    if (want.includes(c)) return +a.pct;
  }
  for (const a of p.answers) {
    const c = norm(a.choice || "");
    for (const k of want) {
      if (c === k || c.includes(k)) return +a.pct;
    }
  }
  return null;
}

function buildGBSeries() {
  const j = JSON.parse(fs.readFileSync("json/polls.json", "utf8"));
  const gbRaw = Array.isArray(j.genericBallot) ? j.genericBallot : [];

  const gbPolls = gbRaw.map(p => {
    const date = parseDate(p.end_date || p.start_date || p.created_at);
    const dem = getAns(p, ["dem", "democrat", "democrats", "democratic"]);
    const rep = getAns(p, ["rep", "republican", "republicans", "gop"]);
    const pollster = p.pollster || p.pollster_name || p.pollsterName || p.sponsor || p.firm || p.source || "";
    return { date, dem, rep, pollster };
  }).filter(p => p.date && isFinite(p.dem) && isFinite(p.rep) && isAllowed(p.pollster))
    .sort((a, b) => a.date - b.date);

  if (!gbPolls.length) { console.error("No valid GB polls found!"); process.exit(1); }

  // Rolling last-N series (daily)
  const n = gbPolls.length;
  const dates = gbPolls.map(p => p.date);
  const psD = new Float64Array(n + 1);
  const psR = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    psD[i + 1] = psD[i] + gbPolls[i].dem;
    psR[i + 1] = psR[i] + gbPolls[i].rep;
  }

  const t0 = dates[0];
  const lastPoll = dates[n - 1];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t1 = today > lastPoll ? today : lastPoll;

  const series = [];
  let hi = 0;
  for (let day = new Date(t0); day <= t1; day.setDate(day.getDate() + 1)) {
    while (hi < n && dates[hi] <= day) hi++;
    const lo = Math.max(0, hi - GB_WINDOW_POLLS);
    const cnt = hi - lo;
    if (cnt <= 0) continue;
    series.push({
      date: fmtDate(day),
      dem: (psD[hi] - psD[lo]) / cnt,
      rep: (psR[hi] - psR[lo]) / cnt,
    });
  }

  console.log(`  GB series: ${series.length} days (${series[0]?.date} → ${series[series.length - 1]?.date}), from ${n} polls`);

  // Update DATA gb
  if (series.length) {
    const last = series[series.length - 1];
    const pair = normalizePair(last.dem, last.rep);
    DATA.senate.gb = pair;
    DATA.governor.gb = pair;
    DATA.house.gb = pair;
  }

  return series;
}

// ═══════════════════════════════════════════════════════
//  STATE POLLS BY DATE (optional)
// ═══════════════════════════════════════════════════════
const STATE_POLLS = { senate: {}, governor: {} };

function loadStatePollsByDate() {
  if (!fs.existsSync("csv/state_polls_by_date.csv")) {
    console.log("  state_polls_by_date.csv: not found (optional, skipping)");
    return;
  }
  const text = fs.readFileSync("csv/state_polls_by_date.csv", "utf8");
  const rows = parseCSV(text);

  function normMode(x) {
    const v = String(x || "").trim().toLowerCase();
    if (v.includes("senate") || v === "sen") return "senate";
    if (v.includes("governor") || v === "gov") return "governor";
    if (v.includes("house")) return "house";
    const u = v.toUpperCase();
    if (u.includes("SEN")) return "senate";
    if (u.includes("GOV")) return "governor";
    return "";
  }

  let count = 0;
  for (const r of rows) {
    const mode = normMode(r.mode || r.office || r.Office || r.race || r.type || r.contest || "");
    const key = String(r.state || r.State || r.key || "").trim().toUpperCase();
    const dt = parseDate(r.date || r.end_date || r.endDate || r.day || r.asof || "");
    if (!mode || !STATE_POLLS[mode] || !key || !dt) continue;

    let D = Number(r.dem ?? r.D ?? r.pollD ?? r.dem_pct ?? r.d ?? NaN);
    let R = Number(r.rep ?? r.R ?? r.pollR ?? r.rep_pct ?? r.r ?? NaN);
    if (!isFinite(D) || !isFinite(R) || (D + R) <= 0) continue;

    const S = Number(r.sigma ?? r.S ?? r.sd ?? r.moe ?? NaN);
    (STATE_POLLS[mode][key] ||= []).push({ date: dt, D, R, S: isFinite(S) ? S : 3 });
    count++;
  }
  for (const mode of Object.keys(STATE_POLLS)) {
    for (const k of Object.keys(STATE_POLLS[mode])) {
      STATE_POLLS[mode][k].sort((a, b) => a.date - b.date);
    }
  }
  console.log(`  state_polls_by_date.csv: ${count} poll entries`);
}

function applyLatestStatePollsToData(latestDateStr) {
  const latestDt = parseDate(latestDateStr);
  if (!latestDt) return;
  const window = STATE_POLL_WINDOW;
  for (const mode of ["senate", "governor"]) {
    const src = STATE_POLLS[mode];
    for (const st of Object.keys(DATA[mode].ratios || {})) {
      const polls = src[st];
      if (!polls || !polls.length) continue;
      let hi = 0;
      while (hi < polls.length && polls[hi].date <= latestDt) hi++;
      const lo = Math.max(0, hi - window);
      const cnt = hi - lo;
      if (cnt <= 0) continue;
      let sumD = 0, sumR = 0;
      for (let i = lo; i < hi; i++) { sumD += polls[i].D; sumR += polls[i].R; }
      DATA[mode].polls[st] = { D: sumD / cnt, R: sumR / cnt, S: 3 };
    }
  }
}

// ═══════════════════════════════════════════════════════
//  MODEL HELPERS (from forecast.js)
// ═══════════════════════════════════════════════════════
function computeIndicatorFromPolls(modeKey) {
  const ratios = DATA[modeKey].ratios;
  const polls = DATA[modeKey].polls;
  const implied = [];
  for (const st of Object.keys(ratios)) {
    const p = polls[st];
    if (!p || !isFinite(p.D) || !isFinite(p.R) || (p.D + p.R) <= 0) continue;
    const pNorm = normalizePair(p.D, p.R);
    const r = ratios[st];
    implied.push({ D: pNorm.D / r.D, R: pNorm.R / r.R });
  }
  if (!implied.length) return null;
  const d = median(implied.map(x => x.D));
  const r = median(implied.map(x => x.R));
  return normalizePair(d, r);
}

function computeIndicatorFromPollMatrix(arr, pollDDay, pollRDay, nStates, dayIndex) {
  const implied = [];
  for (let i = 0; i < nStates; i++) {
    const D = pollDDay[dayIndex * nStates + i];
    const R = pollRDay[dayIndex * nStates + i];
    if (!isFinite(D) || !isFinite(R) || (D + R) <= 0) continue;
    const p = normalizePair(D, R);
    const rd = arr.ratioD[i] || 1;
    const rr = arr.ratioR[i] || 1;
    implied.push({ D: p.D / rd, R: p.R / rr });
  }
  if (!implied.length) return null;
  return { D: median(implied.map(x => x.D)), R: median(implied.map(x => x.R)) };
}

function stateArraysSorted(modeKey) {
  const keys = Object.keys(DATA[modeKey]?.ratios || {}).sort();
  const n = keys.length;
  const ratioD = new Float32Array(n), ratioR = new Float32Array(n);
  const pollD = new Float32Array(n), pollR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    const rr = DATA[modeKey].ratios[k];
    ratioD[i] = rr?.D ?? 1; ratioR[i] = rr?.R ?? 1;
    const pp = DATA[modeKey].polls?.[k];
    pollD[i] = pp?.D ?? NaN; pollR[i] = pp?.R ?? NaN;
  }
  return { keys, ratioD, ratioR, pollD, pollR };
}

function houseRatioArraysSorted() {
  const keys = Object.keys(DATA.house.ratios || {}).sort();
  const d = new Float32Array(keys.length), r = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const rr = DATA.house.ratios[keys[i]];
    d[i] = rr?.D ?? 1; r[i] = rr?.R ?? 1;
  }
  return { keys, d, r };
}

function buildPollMatrix(modeKey, keys, dateStrs) {
  const src = STATE_POLLS[modeKey];
  if (!src) return null;
  const nStates = keys.length, nDays = dateStrs.length;
  const pollDDay = new Float32Array(nStates * nDays).fill(NaN);
  const pollRDay = new Float32Array(nStates * nDays).fill(NaN);
  const window = STATE_POLL_WINDOW;
  const dayDates = dateStrs.map(parseDate);

  for (let i = 0; i < nStates; i++) {
    const polls = src[keys[i]];
    if (!polls || !polls.length) continue;
    const m = polls.length;
    const psD = new Float64Array(m + 1), psR = new Float64Array(m + 1);
    for (let j = 0; j < m; j++) { psD[j + 1] = psD[j] + polls[j].D; psR[j + 1] = psR[j] + polls[j].R; }
    let hi = 0;
    for (let day = 0; day < nDays; day++) {
      const dt = dayDates[day];
      if (!dt) continue;
      while (hi < m && polls[hi].date <= dt) hi++;
      const lo = Math.max(0, hi - window);
      const cnt = hi - lo;
      if (cnt <= 0) continue;
      pollDDay[day * nStates + i] = (psD[hi] - psD[lo]) / cnt;
      pollRDay[day * nStates + i] = (psR[hi] - psR[lo]) / cnt;
    }
  }
  return { pollDDay, pollRDay, nStates, nDays };
}

// ═══════════════════════════════════════════════════════
//  HOUSE MC SIMULATION (from house_odds_worker.js)
// ═══════════════════════════════════════════════════════
const HISPANIC_BASELINE = normalizePair(52, 46); // {D: 53.06, R: 46.94}

function simHouseDay(gbD, gbR, ratioD, ratioR, seatTotal, majorityLine, trackHist, hcdArr) {
  // If we have Hispanic polling data, compute swing from baseline and adjust ratios
  let adjD = ratioD, adjR = ratioR;
  if (hcdArr && HISPANIC_GB) {
    const swD = (HISPANIC_GB.D - HISPANIC_BASELINE.D) / HISPANIC_BASELINE.D;
    const swR = (HISPANIC_GB.R - HISPANIC_BASELINE.R) / HISPANIC_BASELINE.R;
    adjD = new Float32Array(ratioD.length);
    adjR = new Float32Array(ratioR.length);
    for (let k = 0; k < ratioD.length; k++) {
      const h = hcdArr[k];
      adjD[k] = ratioD[k] * (1 + h * 0.75 * swD);
      adjR[k] = ratioR[k] * (1 + h * 0.75 * swR);
    }
  }

  const margins = new Float32Array(seatTotal);
  for (let k = 0; k < seatTotal; k++) {
    if (k < adjD.length) {
      const a = +adjD[k], b = +adjR[k];
      const den = gbD * a + gbR * b;
      margins[k] = den > 0 ? 100 * (gbR * b - gbD * a) / den : 0;
    }
  }

  // Discrete swing grid
  const swings = [];
  for (let s = -SWING_RANGE; s <= SWING_RANGE + 1e-9; s += SWING_STEP) swings.push(s);
  const nSw = swings.length;

  const muBy = new Float32Array(nSw), vaBy = new Float32Array(nSw);
  for (let j = 0; j < nSw; j++) {
    let mu = 0, va = 0;
    for (let k = 0; k < seatTotal; k++) {
      const p = winProbD(margins[k] + swings[j]);
      mu += p; va += p * (1 - p);
    }
    muBy[j] = mu; vaBy[j] = va;
  }

  let demWins = 0, seatSum = 0;
  const samples = trackHist ? new Int16Array(MC_SIMS) : null;
  for (let s = 0; s < MC_SIMS; s++) {
    const j = (Math.random() * nSw) | 0;
    let seats = muBy[j];
    if (vaBy[j] > 1e-9) seats += Math.sqrt(vaBy[j]) * randn();
    seats = clamp(Math.round(seats), 0, seatTotal);
    seatSum += seats;
    if (seats >= majorityLine) demWins++;
    if (samples) samples[s] = seats;
  }

  const result = { pDem: demWins / MC_SIMS, expDem: seatSum / MC_SIMS };
  if (samples) result.hist = buildBinnedHist(samples, 12, 2);
  return result;
}

// ═══════════════════════════════════════════════════════
//  STATE MC SIMULATION (from state_odds_worker.js)
// ═══════════════════════════════════════════════════════
function simStateDay(modeKey, gbD, gbR, ratioD, ratioR, pollD0, pollR0, pollDDay, pollRDay,
                     nStates, dayIdx, indD, indR, wGb, wPoll, wInd,
                     baseD, baseR, total, controlLine, tieIsDem, tieSeat, trackHist) {
  const upSeats = Math.min(ratioD.length, ratioR.length);
  const margins = new Float32Array(upSeats);

  for (let i = 0; i < upSeats; i++) {
    const rd = ratioD[i], rr = ratioR[i];
    // GB component
    const gbS = rd * gbD + rr * gbR;
    const gbPair = gbS > 0 ? { D: 100 * rd * gbD / gbS, R: 100 * rr * gbR / gbS } : { D: 50, R: 50 };

    // Poll component (prefer per-day, fall back to static)
    let pollPair = null;
    let pDi = NaN, pRi = NaN;
    if (pollDDay && pollRDay) {
      const pd = pollDDay[dayIdx * upSeats + i];
      const pr = pollRDay[dayIdx * upSeats + i];
      if (isFinite(pd) && isFinite(pr)) { pDi = pd; pRi = pr; }
    }
    if (!isFinite(pDi) || !isFinite(pRi)) { pDi = pollD0[i]; pRi = pollR0[i]; }
    if (isFinite(pDi) && isFinite(pRi)) pollPair = normalizePair(pDi, pRi);

    // Indicator component
    let indPair = null;
    if (isFinite(indD) && isFinite(indR)) {
      const s = indD * rd + indR * rr;
      if (s > 0) indPair = { D: 100 * indD * rd / s, R: 100 * indR * rr / s };
    }

    // Weighted combine
    let d = 0, r = 0, w = 0;
    if (wGb > 0) { d += wGb * gbPair.D; r += wGb * gbPair.R; w += wGb; }
    if (pollPair && wPoll > 0) { d += wPoll * pollPair.D; r += wPoll * pollPair.R; w += wPoll; }
    if (indPair && wInd > 0) { d += wInd * indPair.D; r += wInd * indPair.R; w += wInd; }
    if (w <= 0) { margins[i] = 0; continue; }
    const cD = d / w, cR = r / w;
    const cs = cD + cR;
    margins[i] = cs > 0 ? 100 * (cR / cs - cD / cs) : 0;
  }

  // MC
  let demControl = 0, sumDSeats = 0;
  const samples = trackHist ? new Int16Array(MC_SIMS) : null;
  for (let s = 0; s < MC_SIMS; s++) {
    const swing = (Math.random() * 2 - 1) * SWING_RANGE;
    let dWins = 0;
    for (let i = 0; i < upSeats; i++) {
      if (Math.random() < winProbD(margins[i] + swing)) dWins++;
    }
    const dSeats = baseD + dWins;
    sumDSeats += dSeats;
    if (dSeats >= controlLine || (tieIsDem && dSeats === tieSeat)) demControl++;
    if (samples) samples[s] = dSeats;
  }

  const result = { pDem: demControl / MC_SIMS, expDem: sumDSeats / MC_SIMS };
  if (samples) result.hist = buildRangeHist(samples, modeKey === "governor" ? 21 : 44, modeKey === "governor" ? 31 : 57);
  return result;
}

// ═══════════════════════════════════════════════════════
//  HISTOGRAM HELPERS (format matches drawSeatSimMini in forecast.js)
// ═══════════════════════════════════════════════════════
function buildBinnedHist(samples, binSize, binOffset) {
  binSize = Math.max(1, binSize); binOffset = binOffset || 0;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] < min) min = samples[i];
    if (samples[i] > max) max = samples[i];
  }
  if (!isFinite(min)) { min = 0; max = 0; }
  const toBin = v => Math.floor((v - binOffset) / binSize) * binSize + binOffset;
  const minB = toBin(min), maxB = toBin(max);
  const n = Math.max(1, Math.floor((maxB - minB) / binSize) + 1);
  const counts = new Array(n).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const idx = Math.floor((toBin(samples[i]) - minB) / binSize);
    if (idx >= 0 && idx < n) counts[idx]++;
  }
  return { counts, min: minB, max: minB + (n - 1) * binSize + (binSize - 1), isProb: false, total: samples.length, binSize, binOffset };
}

function buildRangeHist(samples, showMin, showMax) {
  const counts = new Array(showMax - showMin + 1).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v >= showMin && v <= showMax) counts[v - showMin]++;
  }
  return { counts, min: showMin, max: showMax, isProb: false, total: samples.length, binSize: 1 };
}

// ═══════════════════════════════════════════════════════
//  INCREMENTAL LOGIC
// ═══════════════════════════════════════════════════════
function loadExisting(file) {
  if (!fs.existsSync(file)) return { results: [] };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { results: [] };
  }
}

function saveOdds(file, results, latestHist) {
  const obj = {
    updatedAt: new Date().toISOString(),
    config: { sims: MC_SIMS, swingRange: SWING_RANGE, gbWindow: GB_WINDOW_POLLS, filterStrict: FILTER_STRICT },
    results,
  };
  if (latestHist) obj.latestHist = latestHist;
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ═══════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════
function main() {
  console.log("Loading data...");
  loadEntriesAll();
  loadHouseRatios();
  loadHispanicCDShare();
  loadHispanicPolls();
  const gbSeries = buildGBSeries();
  loadStatePollsByDate();

  // Apply latest state polls to DATA
  if (gbSeries.length) {
    applyLatestStatePollsToData(gbSeries[gbSeries.length - 1].date);
  }

  // Compute indicators
  const indSenate = computeIndicatorFromPolls("senate");
  const indGovernor = computeIndicatorFromPolls("governor");

  // Prepare arrays
  const houseArr = houseRatioArraysSorted();
  const senateArr = stateArraysSorted("senate");
  const govArr = stateArraysSorted("governor");

  const allDates = gbSeries.map(d => d.date);
  const allGbD = gbSeries.map(d => d.dem);
  const allGbR = gbSeries.map(d => d.rep);

  // Build state poll matrices for full date range
  const senatePM = buildPollMatrix("senate", senateArr.keys, allDates);
  const govPM = buildPollMatrix("governor", govArr.keys, allDates);

  // ─── HOUSE ───
  {
    const file = "json/house_odds.json";
    const existing = loadExisting(file);
    const doneSet = new Set((existing.results || []).map(r => r.date));
    const newDays = [];
    for (let i = 0; i < allDates.length; i++) {
      if (!doneSet.has(allDates[i])) newDays.push(i);
    }

    if (newDays.length === 0) {
      console.log(`House: 0 new days → skip`);
    } else {
      console.log(`House: computing ${newDays.length} new day(s)...`);
      const rules = SEAT_RULES.house;
      const hcdArr = buildHispanicShareArray(houseArr.keys);
      const newResults = [];
      let latestHist = existing.latestHist || null;
      for (let ni = 0; ni < newDays.length; ni++) {
        const i = newDays[ni];
        const isLast = (i === allDates.length - 1);
        const r = simHouseDay(allGbD[i], allGbR[i], houseArr.d, houseArr.r, rules.total, rules.majorityLine, isLast, hcdArr);
        newResults.push({ date: allDates[i], pDem: +r.pDem.toFixed(4), expDem: +r.expDem.toFixed(2) });
        if (r.hist) latestHist = r.hist;
        if ((ni + 1) % 50 === 0 || ni === newDays.length - 1) {
          process.stdout.write(`  ${ni + 1}/${newDays.length}\r`);
        }
      }
      console.log();
      const merged = [...(existing.results || []), ...newResults].sort((a, b) => a.date.localeCompare(b.date));
      saveOdds(file, merged, latestHist);
      console.log(`  → ${file}: ${merged.length} total days`);
    }
  }

  // ─── SENATE ───
  {
    const file = "json/senate_odds.json";
    const existing = loadExisting(file);
    const doneSet = new Set((existing.results || []).map(r => r.date));
    const newDays = [];
    for (let i = 0; i < allDates.length; i++) {
      if (!doneSet.has(allDates[i])) newDays.push(i);
    }

    if (newDays.length === 0) {
      console.log(`Senate: 0 new days → skip`);
    } else {
      console.log(`Senate: computing ${newDays.length} new day(s)...`);
      const rules = SEAT_RULES.senate;
      const controlLine = SENATE_CONTROL_LINE;
      const indD = indSenate ? indSenate.D : NaN;
      const indR = indSenate ? indSenate.R : NaN;
      const newResults = [];
      let latestHist = existing.latestHist || null;
      for (let ni = 0; ni < newDays.length; ni++) {
        const i = newDays[ni];
        const isLast = (i === allDates.length - 1);

        // Per-day indicator from poll matrix
        let dayIndD = indD, dayIndR = indR;
        if (senatePM) {
          const pmInd = computeIndicatorFromPollMatrix(senateArr, senatePM.pollDDay, senatePM.pollRDay, senatePM.nStates, i);
          if (pmInd) { dayIndD = pmInd.D; dayIndR = pmInd.R; }
        }

        const r = simStateDay("senate", allGbD[i], allGbR[i],
          senateArr.ratioD, senateArr.ratioR, senateArr.pollD, senateArr.pollR,
          senatePM?.pollDDay || null, senatePM?.pollRDay || null,
          senateArr.keys.length, i,
          dayIndD, dayIndR, WEIGHTS.gb, WEIGHTS.polls, WEIGHTS.ind,
          rules.baseD, rules.baseR, rules.total, controlLine,
          false, controlLine - 1, isLast);
        newResults.push({ date: allDates[i], pDem: +r.pDem.toFixed(4), expDem: +r.expDem.toFixed(2) });
        if (r.hist) latestHist = r.hist;
        if ((ni + 1) % 50 === 0 || ni === newDays.length - 1) process.stdout.write(`  ${ni + 1}/${newDays.length}\r`);
      }
      console.log();
      const merged = [...(existing.results || []), ...newResults].sort((a, b) => a.date.localeCompare(b.date));
      saveOdds(file, merged, latestHist);
      console.log(`  → ${file}: ${merged.length} total days`);
    }
  }

  // ─── GOVERNOR ───
  {
    const file = "json/governor_odds.json";
    const existing = loadExisting(file);
    const doneSet = new Set((existing.results || []).map(r => r.date));
    const newDays = [];
    for (let i = 0; i < allDates.length; i++) {
      if (!doneSet.has(allDates[i])) newDays.push(i);
    }

    if (newDays.length === 0) {
      console.log(`Governor: 0 new days → skip`);
    } else {
      console.log(`Governor: computing ${newDays.length} new day(s)...`);
      const rules = SEAT_RULES.governor;
      const controlLine = rules.majorityLine;
      const indD = indGovernor ? indGovernor.D : NaN;
      const indR = indGovernor ? indGovernor.R : NaN;
      const newResults = [];
      let latestHist = existing.latestHist || null;
      for (let ni = 0; ni < newDays.length; ni++) {
        const i = newDays[ni];
        const isLast = (i === allDates.length - 1);

        let dayIndD = indD, dayIndR = indR;
        if (govPM) {
          const pmInd = computeIndicatorFromPollMatrix(govArr, govPM.pollDDay, govPM.pollRDay, govPM.nStates, i);
          if (pmInd) { dayIndD = pmInd.D; dayIndR = pmInd.R; }
        }

        const r = simStateDay("governor", allGbD[i], allGbR[i],
          govArr.ratioD, govArr.ratioR, govArr.pollD, govArr.pollR,
          govPM?.pollDDay || null, govPM?.pollRDay || null,
          govArr.keys.length, i,
          dayIndD, dayIndR, WEIGHTS.gb, WEIGHTS.polls, WEIGHTS.ind,
          rules.baseD, rules.baseR, rules.total, controlLine,
          true, controlLine - 1, isLast);  // tieIsDem = true for governor
        newResults.push({ date: allDates[i], pDem: +r.pDem.toFixed(4), expDem: +r.expDem.toFixed(2) });
        if (r.hist) latestHist = r.hist;
        if ((ni + 1) % 50 === 0 || ni === newDays.length - 1) process.stdout.write(`  ${ni + 1}/${newDays.length}\r`);
      }
      console.log();
      const merged = [...(existing.results || []), ...newResults].sort((a, b) => a.date.localeCompare(b.date));
      saveOdds(file, merged, latestHist);
      console.log(`  → ${file}: ${merged.length} total days`);
    }
  }

  console.log("Done.");
}

main();
