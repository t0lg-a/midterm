#!/usr/bin/env node
// compute_odds_2024.js — Hindcast MC seat simulation for 2024
//
// Reads:  2024_entries.csv, 2024_presidential_polls.json,
//         2024_gb_polls.json, 2024_state_presidential_polls.csv
// Writes: json/past/2024_president_odds.json, json/past/2024_senate_odds.json,
//         json/past/2024_governor_odds.json, json/past/2024_house_odds.json

const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════
//  CONFIG — must match past-elections.js / forecast.js
// ═══════════════════════════════════════════════════════
const PROB_ERROR_SD_PTS = 7;
const WEIGHTS = { gb: 35, polls: 50, ind: 15 };
const SEAT_RULES = {
  president: { total: 538, majorityLine: 270, baseD: 0,  baseR: 0  },
  senate:    { total: 100, majorityLine: 50,  baseD: 28, baseR: 39 },
  governor:  { total: 50,  majorityLine: 26,  baseD: 20, baseR: 19 },
  house:     { total: 435, majorityLine: 218, baseD: 0,  baseR: 0  },
};

const EV = {
  AL:9,AK:3,AZ:11,AR:6,CA:54,CO:10,CT:7,DE:3,DC:3,FL:30,GA:16,HI:4,ID:4,IL:19,
  IN:11,IA:6,KS:6,KY:8,LA:8,ME:4,MD:10,MA:11,MI:15,MN:10,MS:6,MO:10,MT:4,NE:5,
  NV:6,NH:4,NJ:14,NM:5,NY:28,NC:16,ND:3,OH:17,OK:7,OR:8,PA:19,RI:4,SC:9,SD:3,
  TN:11,TX:40,UT:6,VT:3,VA:13,WA:12,WV:4,WI:10,WY:3
};

// Only contested races for senate/governor
const RACE_FILTER = {
  president: null,
  senate: new Set(["AZ","CA","CT","DE","FL","HI","IN","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NJ","NM","NY","ND","OH","PA","RI","TN","TX","UT","VT","VA","WA","WV","WI","WY"]),
  governor: new Set(["DE","IN","MO","MT","NC","NH","ND","UT","VT","WA","WV"]),
  house: null,
};

const MC_SIMS         = 10000;
const SWING_RANGE     = 7;
const SWING_STEP      = 0.1;
const GB_WINDOW_POLLS = 20;
const STATE_POLL_WINDOW = 6;

// ═══════════════════════════════════════════════════════
//  MATH
// ═══════════════════════════════════════════════════════
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429;
  const t = 1 / (1 + 0.3275911 * x);
  return sign * (1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-x * x));
}

function normalCDF(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

const WINP_MIN = -40, WINP_MAX = 40, WINP_STEP = 0.1;
const WINP_N = Math.round((WINP_MAX - WINP_MIN) / WINP_STEP) + 1;
const WINP_PD = new Float32Array(WINP_N);
for (let i = 0; i < WINP_N; i++) {
  const m = WINP_MIN + i * WINP_STEP;
  WINP_PD[i] = 1 - clamp(normalCDF(m / PROB_ERROR_SD_PTS), 0, 1);
}
function winProbD(m) {
  if (!isFinite(m)) return 0.5;
  return WINP_PD[Math.round((clamp(m, WINP_MIN, WINP_MAX) - WINP_MIN) / WINP_STEP)] ?? 0.5;
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
  const n = Number(String(v).trim());
  return isFinite(n) ? n : NaN;
}

// ═══════════════════════════════════════════════════════
//  CSV PARSER
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
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (vals[j] || "").trim();
    rows.push(row);
  }
  return rows;
}

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ═══════════════════════════════════════════════════════
//  DATA LOADING
// ═══════════════════════════════════════════════════════
const DATA = {
  president: { gb: null, ratios: {}, polls: {} },
  senate:    { gb: null, ratios: {}, polls: {} },
  governor:  { gb: null, ratios: {}, polls: {} },
  house:     { gb: null, ratios: {}, polls: {} },
};

function loadEntries() {
  const text = fs.readFileSync("2024_entries.csv", "utf8");
  const rows = parseCSV(text);
  for (const row of rows) {
    const mode = String(row.mode || "").trim().toLowerCase();
    if (!DATA[mode]) continue;
    const st = String(row.state || "").trim().toUpperCase();
    const ratioD = toNum(row.ratioD), ratioR = toNum(row.ratioR);
    if (!st || !isFinite(ratioD) || !isFinite(ratioR)) continue;
    // Apply race filter at load time
    const filter = RACE_FILTER[mode];
    if (filter && !filter.has(st)) continue;
    DATA[mode].ratios[st] = { D: ratioD, R: ratioR };
  }
  for (const m of Object.keys(DATA)) {
    console.log(`  ${m}: ${Object.keys(DATA[m].ratios).length} entries`);
  }
}

// Presidential polls → GB series for "president" mode
function loadPresidentialPolls() {
  const j = JSON.parse(fs.readFileSync("2024_presidential_polls.json", "utf8"));
  const polls = (j.polls || []).map(p => ({
    date: parseDate(p.end_date),
    dem: +p.dem, rep: +p.rep
  })).filter(p => p.date && isFinite(p.dem) && isFinite(p.rep))
    .sort((a, b) => a.date - b.date);
  console.log(`  Presidential polls: ${polls.length}`);
  return polls;
}

// Generic ballot polls → GB series for senate/governor/house
function loadGBPolls() {
  const j = JSON.parse(fs.readFileSync("2024_gb_polls.json", "utf8"));
  const polls = (j.genericBallot || []).map(p => ({
    date: parseDate(p.end_date),
    dem: +p.dem, rep: +p.rep
  })).filter(p => p.date && isFinite(p.dem) && isFinite(p.rep))
    .sort((a, b) => a.date - b.date);
  console.log(`  GB polls: ${polls.length}`);
  return polls;
}

// State polls → per-day rolling averages
const STATE_POLLS = { president: {}, senate: {}, governor: {} };

function loadStatePolls() {
  const text = fs.readFileSync("2024_state_presidential_polls.csv", "utf8");
  const rows = parseCSV(text);
  let count = 0;
  for (const r of rows) {
    const mode = String(r.mode || "").trim().toLowerCase();
    const st = String(r.state || "").trim().toUpperCase();
    const dt = parseDate(r.date);
    if (!mode || !STATE_POLLS[mode] || !st || !dt) continue;
    // Filter out Maine senate
    if (st === "ME" && mode === "senate") continue;
    const D = toNum(r.dem), R = toNum(r.rep);
    if (!isFinite(D) || !isFinite(R) || (D + R) <= 0) continue;
    (STATE_POLLS[mode][st] ||= []).push({ date: dt, D, R, S: toNum(r.sigma) || 3 });
    count++;
  }
  for (const mode of Object.keys(STATE_POLLS)) {
    for (const k of Object.keys(STATE_POLLS[mode])) {
      STATE_POLLS[mode][k].sort((a, b) => a.date - b.date);
    }
  }
  console.log(`  State polls: ${count} entries`);
}

// ═══════════════════════════════════════════════════════
//  GB SERIES BUILDER (rolling last-N daily)
// ═══════════════════════════════════════════════════════
function buildGBSeries(polls, windowN) {
  if (!polls.length) return [];
  const n = polls.length;
  const dates = polls.map(p => p.date);
  const psD = new Float64Array(n + 1), psR = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    psD[i + 1] = psD[i] + polls[i].dem;
    psR[i + 1] = psR[i] + polls[i].rep;
  }

  const t0 = dates[0];
  const t1 = dates[n - 1];
  const series = [];
  let hi = 0;
  for (let day = new Date(t0); day <= t1; day.setDate(day.getDate() + 1)) {
    while (hi < n && dates[hi] <= day) hi++;
    const lo = Math.max(0, hi - windowN);
    const cnt = hi - lo;
    if (cnt <= 0) continue;
    series.push({
      date: fmtDate(day),
      dem: (psD[hi] - psD[lo]) / cnt,
      rep: (psR[hi] - psR[lo]) / cnt,
    });
  }
  return series;
}

// ═══════════════════════════════════════════════════════
//  POLL MATRIX (per-state per-day rolling average)
// ═══════════════════════════════════════════════════════
function buildPollMatrix(mode, keys, dateStrs) {
  const src = STATE_POLLS[mode];
  if (!src) return null;
  const nStates = keys.length, nDays = dateStrs.length;
  const pollDDay = new Float32Array(nStates * nDays).fill(NaN);
  const pollRDay = new Float32Array(nStates * nDays).fill(NaN);
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
      const lo = Math.max(0, hi - STATE_POLL_WINDOW);
      const cnt = hi - lo;
      if (cnt <= 0) continue;
      pollDDay[day * nStates + i] = (psD[hi] - psD[lo]) / cnt;
      pollRDay[day * nStates + i] = (psR[hi] - psR[lo]) / cnt;
    }
  }
  return { pollDDay, pollRDay, nStates, nDays };
}

// ═══════════════════════════════════════════════════════
//  MODEL HELPERS
// ═══════════════════════════════════════════════════════
function computeIndicatorFromPollMatrix(arr, pollDDay, pollRDay, nStates, dayIndex) {
  const implied = [];
  for (let i = 0; i < nStates; i++) {
    const D = pollDDay[dayIndex * nStates + i];
    const R = pollRDay[dayIndex * nStates + i];
    if (!isFinite(D) || !isFinite(R) || (D + R) <= 0) continue;
    const p = normalizePair(D, R);
    const rd = arr.ratioD[i] || 1, rr = arr.ratioR[i] || 1;
    implied.push({ D: p.D / rd, R: p.R / rr });
  }
  if (!implied.length) return null;
  return normalizePair(median(implied.map(x => x.D)), median(implied.map(x => x.R)));
}

function stateArraysSorted(mode) {
  const keys = Object.keys(DATA[mode]?.ratios || {}).sort();
  const n = keys.length;
  const ratioD = new Float32Array(n), ratioR = new Float32Array(n);
  const pollD = new Float32Array(n).fill(NaN), pollR = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const rr = DATA[mode].ratios[keys[i]];
    ratioD[i] = rr?.D ?? 1; ratioR[i] = rr?.R ?? 1;
  }
  return { keys, ratioD, ratioR, pollD, pollR };
}

// ═══════════════════════════════════════════════════════
//  STATE MC SIMULATION (senate/governor/president)
// ═══════════════════════════════════════════════════════
function simStateDay(mode, gbD, gbR, ratioD, ratioR, pollDDay, pollRDay,
                     nStates, dayIdx, indNat, keys, wGb, wPoll, wInd,
                     baseD, baseR, total, controlLine, tieIsDem, trackHist, controlLine2) {
  const upSeats = nStates;
  const margins = new Float32Array(upSeats);
  const evWeights = new Float32Array(upSeats); // 1 for senate/gov, EV for president

  for (let i = 0; i < upSeats; i++) {
    const rd = ratioD[i], rr = ratioR[i];
    const st = keys[i];
    evWeights[i] = (mode === "president") ? (EV[st] || 1) : 1;

    // GB component
    const gbS = rd * gbD + rr * gbR;
    const gbPair = gbS > 0 ? { D: 100 * rd * gbD / gbS, R: 100 * rr * gbR / gbS } : { D: 50, R: 50 };

    // Poll component (per-day rolling)
    let pollPair = null;
    if (pollDDay && pollRDay) {
      const pd = pollDDay[dayIdx * upSeats + i];
      const pr = pollRDay[dayIdx * upSeats + i];
      if (isFinite(pd) && isFinite(pr)) pollPair = normalizePair(pd, pr);
    }

    // Indicator component
    let indPair = null;
    if (indNat) {
      const s = indNat.D * rd + indNat.R * rr;
      if (s > 0) indPair = { D: 100 * indNat.D * rd / s, R: 100 * indNat.R * rr / s };
    }

    // Circuit breaker: poll/ratio implied national >= 70%
    let wg = wGb, wp = wPoll, wi = wInd;
    if (pollPair) {
      const impliedNat = normalizePair(pollPair.D / rd, pollPair.R / rr);
      if (Math.max(impliedNat.D, impliedNat.R) >= 70) {
        wp = 80; wg = 15; wi = 5;
      }
    }

    // Weighted combine
    let d = 0, r = 0, w = 0;
    if (wg > 0) { d += wg * gbPair.D; r += wg * gbPair.R; w += wg; }
    if (pollPair && wp > 0) { d += wp * pollPair.D; r += wp * pollPair.R; w += wp; }
    if (indPair && wi > 0) { d += wi * indPair.D; r += wi * indPair.R; w += wi; }
    if (w <= 0) { margins[i] = 0; continue; }
    const cD = d / w, cR = r / w, cs = cD + cR;
    margins[i] = cs > 0 ? 100 * (cR / cs - cD / cs) : 0;
  }

  // MC simulations
  let demControl = 0, demControl2 = 0, sumDSeats = 0;
  const samples = trackHist ? new Int16Array(MC_SIMS) : null;

  for (let s = 0; s < MC_SIMS; s++) {
    const swing = (Math.random() * 2 - 1) * SWING_RANGE;
    let dSeats = baseD;

    for (let i = 0; i < upSeats; i++) {
      if (Math.random() < winProbD(margins[i] + swing)) {
        dSeats += evWeights[i]; // EV for president, 1 for others
      }
    }

    sumDSeats += dSeats;
    if (dSeats >= controlLine || (tieIsDem && dSeats === controlLine - 1)) demControl++;
    if (controlLine2 != null && dSeats >= controlLine2) demControl2++;
    if (samples) samples[s] = dSeats;
  }

  const result = { pDem: demControl / MC_SIMS, expDem: sumDSeats / MC_SIMS };
  if (controlLine2 != null) result.pDem2 = demControl2 / MC_SIMS;
  if (samples) {
    if (mode === "president") {
      result.hist = buildRangeHist(samples, 150, 400);
    } else if (mode === "house") {
      result.hist = buildBinnedHist(samples, 12, 2);
    } else {
      const lo = mode === "governor" ? 21 : 44;
      const hi = mode === "governor" ? 31 : 57;
      result.hist = buildRangeHist(samples, lo, hi);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════
//  HOUSE MC SIMULATION (no polls, just GB + ratios)
// ═══════════════════════════════════════════════════════
function simHouseDay(gbD, gbR, ratioD, ratioR, seatTotal, majorityLine, trackHist) {
  const margins = new Float32Array(seatTotal);
  for (let k = 0; k < seatTotal && k < ratioD.length; k++) {
    const a = ratioD[k], b = ratioR[k];
    const den = gbD * a + gbR * b;
    margins[k] = den > 0 ? 100 * (gbR * b - gbD * a) / den : 0;
  }

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
//  HISTOGRAM HELPERS
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
  return { counts, min: minB, max: minB + (n-1)*binSize + (binSize-1), isProb: false, total: samples.length, binSize, binOffset };
}

function buildRangeHist(samples, showMin, showMax) {
  const counts = new Array(showMax - showMin + 1).fill(0);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v >= showMin && v <= showMax) counts[v - showMin]++;
  }
  return { counts, min: showMin, max: showMax, isProb: false, total: samples.length, binSize: 1 };
}

function saveOdds(file, results, latestHist) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const obj = {
    updatedAt: new Date().toISOString(),
    config: { sims: MC_SIMS, swingRange: SWING_RANGE, gbWindow: GB_WINDOW_POLLS },
    results,
  };
  if (latestHist) obj.latestHist = latestHist;
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ═══════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════
function main() {
  console.log("Loading 2024 hindcast data...");
  loadEntries();

  const presPolls = loadPresidentialPolls();
  const gbPolls = loadGBPolls();
  loadStatePolls();

  // Build daily GB series
  const presSeries = buildGBSeries(presPolls, GB_WINDOW_POLLS);
  const gbSeries = buildGBSeries(gbPolls, GB_WINDOW_POLLS);

  console.log(`  President GB series: ${presSeries.length} days (${presSeries[0]?.date} → ${presSeries[presSeries.length-1]?.date})`);
  console.log(`  Generic ballot series: ${gbSeries.length} days (${gbSeries[0]?.date} → ${gbSeries[gbSeries.length-1]?.date})`);

  // Prepare sorted arrays
  const presArr = stateArraysSorted("president");
  const senArr = stateArraysSorted("senate");
  const govArr = stateArraysSorted("governor");
  const houseArr = stateArraysSorted("house");

  // Build poll matrices
  const presDates = presSeries.map(d => d.date);
  const gbDates = gbSeries.map(d => d.date);

  const presPM = buildPollMatrix("president", presArr.keys, presDates);
  const senPM = buildPollMatrix("senate", senArr.keys, gbDates);
  const govPM = buildPollMatrix("governor", govArr.keys, gbDates);

  // ─── PRESIDENT ───
  let presResults = []; // store for senate VP blending
  {
    const file = "json/past/2024_president_odds.json";
    const rules = SEAT_RULES.president;
    console.log(`\nPresident: computing ${presSeries.length} days...`);
    const results = [];
    let latestHist = null;

    for (let i = 0; i < presSeries.length; i++) {
      const isLast = (i === presSeries.length - 1);
      const indNat = presPM ? computeIndicatorFromPollMatrix(presArr, presPM.pollDDay, presPM.pollRDay, presPM.nStates, i) : null;

      const r = simStateDay("president", presSeries[i].dem, presSeries[i].rep,
        presArr.ratioD, presArr.ratioR, presPM?.pollDDay || null, presPM?.pollRDay || null,
        presArr.keys.length, i, indNat, presArr.keys,
        WEIGHTS.gb, WEIGHTS.polls, WEIGHTS.ind,
        rules.baseD, rules.baseR, rules.total, rules.majorityLine, false, isLast);

      results.push({ date: presDates[i], pDem: +r.pDem.toFixed(4), expDem: +r.expDem.toFixed(2) });
      if (r.hist) latestHist = r.hist;
      if ((i+1) % 30 === 0 || i === presSeries.length-1) process.stdout.write(`  ${i+1}/${presSeries.length}\r`);
    }
    console.log();
    presResults = results;
    saveOdds(file, results, latestHist);
    console.log(`  → ${file}: ${results.length} days`);
  }

  // Build date→pDem lookup for presidential odds (for senate VP blending)
  const presPDemByDate = {};
  for (const r of presResults) presPDemByDate[r.date] = r.pDem;

  // ─── SENATE ───
  {
    const file = "json/past/2024_senate_odds.json";
    const rules = SEAT_RULES.senate;
    console.log(`\nSenate: computing ${gbSeries.length} days (with VP tiebreaker)...`);
    const results = [];
    let latestHist = null;

    for (let i = 0; i < gbSeries.length; i++) {
      const isLast = (i === gbSeries.length - 1);
      const indNat = senPM ? computeIndicatorFromPollMatrix(senArr, senPM.pollDDay, senPM.pollRDay, senPM.nStates, i) : null;

      // Run MC with controlLine=50 (VP tiebreak) and controlLine2=51 (outright)
      const r = simStateDay("senate", gbSeries[i].dem, gbSeries[i].rep,
        senArr.ratioD, senArr.ratioR, senPM?.pollDDay || null, senPM?.pollRDay || null,
        senArr.keys.length, i, indNat, senArr.keys,
        WEIGHTS.gb, WEIGHTS.polls, WEIGHTS.ind,
        rules.baseD, rules.baseR, rules.total, 50, false, isLast, 51);

      // Blend: P(Dem controls) = P(Dem pres) × P(≥50) + P(Rep pres) × P(≥51)
      const presPD = presPDemByDate[gbDates[i]] ?? 0.5;
      const blendedPDem = presPD * r.pDem + (1 - presPD) * r.pDem2;

      results.push({ date: gbDates[i], pDem: +blendedPDem.toFixed(4), expDem: +r.expDem.toFixed(2) });
      if (r.hist) latestHist = r.hist;
      if ((i+1) % 30 === 0 || i === gbSeries.length-1) process.stdout.write(`  ${i+1}/${gbSeries.length}\r`);
    }
    console.log();
    saveOdds(file, results, latestHist);
    console.log(`  → ${file}: ${results.length} days`);
  }

  // ─── GOVERNOR ───
  {
    const file = "json/past/2024_governor_odds.json";
    const rules = SEAT_RULES.governor;
    console.log(`\nGovernor: computing ${gbSeries.length} days...`);
    const results = [];
    let latestHist = null;

    for (let i = 0; i < gbSeries.length; i++) {
      const isLast = (i === gbSeries.length - 1);
      const indNat = govPM ? computeIndicatorFromPollMatrix(govArr, govPM.pollDDay, govPM.pollRDay, govPM.nStates, i) : null;

      const r = simStateDay("governor", gbSeries[i].dem, gbSeries[i].rep,
        govArr.ratioD, govArr.ratioR, govPM?.pollDDay || null, govPM?.pollRDay || null,
        govArr.keys.length, i, indNat, govArr.keys,
        WEIGHTS.gb, WEIGHTS.polls, WEIGHTS.ind,
        rules.baseD, rules.baseR, rules.total, rules.majorityLine, true, isLast);

      results.push({ date: gbDates[i], pDem: +r.pDem.toFixed(4), expDem: +r.expDem.toFixed(2) });
      if (r.hist) latestHist = r.hist;
      if ((i+1) % 30 === 0 || i === gbSeries.length-1) process.stdout.write(`  ${i+1}/${gbSeries.length}\r`);
    }
    console.log();
    saveOdds(file, results, latestHist);
    console.log(`  → ${file}: ${results.length} days`);
  }

  // ─── HOUSE ───
  {
    const file = "json/past/2024_house_odds.json";
    const rules = SEAT_RULES.house;
    console.log(`\nHouse: computing ${gbSeries.length} days...`);
    const results = [];
    let latestHist = null;

    for (let i = 0; i < gbSeries.length; i++) {
      const isLast = (i === gbSeries.length - 1);
      const r = simHouseDay(gbSeries[i].dem, gbSeries[i].rep,
        houseArr.ratioD, houseArr.ratioR, rules.total, rules.majorityLine, isLast);

      results.push({ date: gbDates[i], pDem: +r.pDem.toFixed(4), expDem: +r.expDem.toFixed(2) });
      if (r.hist) latestHist = r.hist;
      if ((i+1) % 30 === 0 || i === gbSeries.length-1) process.stdout.write(`  ${i+1}/${gbSeries.length}\r`);
    }
    console.log();
    saveOdds(file, results, latestHist);
    console.log(`  → ${file}: ${results.length} days`);
  }

  console.log("\nDone.");
}

main();
