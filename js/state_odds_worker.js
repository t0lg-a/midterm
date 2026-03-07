// state_odds_worker.js — Monte Carlo Senate/Governor seat simulation worker
// Extracted from midterm-2.html inline Blob worker

// Worker: compute daily Dem-control probability + E[D seats] for Senate/Governor using 10k sims/day.
const WINP_MIN = -40, WINP_MAX = 40, WINP_STEP = 0.1;
const WINP_N = Math.round((WINP_MAX - WINP_MIN) / WINP_STEP) + 1;

function clamp(x,a,b){ return x<a?a:(x>b?b:x); }

// Approx normal CDF via erf approximation (Abramowitz & Stegun 7.1.26-ish)
function erfApprox(x){
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
  const p=0.3275911;
  const t = 1/(1+p*x);
  const y = 1 - (((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t)*Math.exp(-x*x);
  return s*y;
}
function normCdf(z){ return 0.5*(1 + erfApprox(z/Math.SQRT2)); }

const PROB_ERROR_SD_PTS = 7;

// Precompute win prob table for speed
const WINP = new Float32Array(WINP_N);
for (let i=0;i<WINP_N;i++){
  const m = WINP_MIN + i*WINP_STEP;
  // pDem = Phi( -margin / sd )
  WINP[i] = normCdf((-m)/PROB_ERROR_SD_PTS);
}
function winProbD_fast(margin){
  const cl = clamp(margin, WINP_MIN, WINP_MAX);
  const idx = Math.round((cl - WINP_MIN)/WINP_STEP);
  return WINP[idx];
}

function normalizePair(D,R){
  const s = D + R;
  if (!isFinite(s) || s <= 0) return {D:50, R:50};
  return {D: (D*100)/s, R: (R*100)/s};
}

function isFin(x){ return Number.isFinite(x); }

// weighted combine of already-normalized component pairs
function weightedCombine(gbPair, pollPair, indPair, wGb, wPoll, wInd){
  let d=0, r=0, w=0;
  if (gbPair && wGb>0){ d += wGb*gbPair.D; r += wGb*gbPair.R; w += wGb; }
  if (pollPair && wPoll>0){ d += wPoll*pollPair.D; r += wPoll*pollPair.R; w += wPoll; }
  if (indPair && wInd>0){ d += wInd*indPair.D; r += wInd*indPair.R; w += wInd; }
  if (w <= 0) return {D:50,R:50};
  return normalizePair(d/w, r/w);
}

self.onmessage = (ev)=>{
  const msg = ev.data || {};
  if (msg.type !== "run") return;

  const modeKey = msg.modeKey || "state";
  const runId = msg.runId || 0;
  const dates = msg.dates || [];
  const gbD = msg.gbD || [];
  const gbR = msg.gbR || [];

  const ratioD = msg.ratioD || [];
  const ratioR = msg.ratioR || [];
  const pollD0 = msg.pollD0 || [];
  const pollR0 = msg.pollR0 || [];
  const pollDDay = msg.pollDDay || null;
  const pollRDay = msg.pollRDay || null;

  const indD = msg.indD;
  const indR = msg.indR;

  const wGb   = msg.wGb ?? 1;
  const wPoll = msg.wPoll ?? 0;
  const wInd  = msg.wInd ?? 0;

  const baseD = msg.baseD ?? 0;
  const baseR = msg.baseR ?? 0;
  const total = msg.total ?? (baseD + baseR + (ratioD.length||0));
  const controlLine = msg.controlLine ?? Math.floor(total/2)+1;

  const tieIsDem = !!msg.tieIsDem;
  const tieSeat = msg.tieSeat ?? (controlLine - 1);

  const sims = msg.sims ?? 10000;
  const swingRange = msg.swingRange ?? 7;

  const n = Math.min(ratioD.length||0, ratioR.length||0);
  const upSeats = n;

  const margins = new Float32Array(upSeats);
  const results = new Array(dates.length);

  for (let day=0; day<dates.length; day++){
    const gbd = +gbD[day], gbr = +gbR[day];

    // compute per-seat base margins
    for (let i=0;i<upSeats;i++){
      const rd = ratioD[i], rr = ratioR[i];
      const gbPair = normalizePair(gbd*rd, gbr*rr);

      let pollPair = null;
      // Prefer per-day rolling state polls (last-N as of the day). If missing for a seat/day, fall back to static pollD0/pollR0 (from entries_all.csv).
      let pDi = NaN, pRi = NaN;
      if (pollDDay && pollRDay){
        const pd = pollDDay[day*upSeats + i];
        const pr = pollRDay[day*upSeats + i];
        if (isFin(pd) && isFin(pr)) { pDi = pd; pRi = pr; }
      }
      if (!isFin(pDi) || !isFin(pRi)){
        pDi = pollD0[i]; pRi = pollR0[i];
      }
      if (isFin(pDi) && isFin(pRi)){
        pollPair = normalizePair(pDi, pRi);
      }

      let indPair = null;
      if (isFin(indD) && isFin(indR)){
        indPair = normalizePair(indD*rd, indR*rr);
      }

      const comb = weightedCombine(gbPair, pollPair, indPair, wGb, wPoll, wInd);
      margins[i] = comb.R - comb.D;
    }

    // MC sims
    let demControl = 0;
    let sumDSeats = 0;

    for (let s=0; s<sims; s++){
      const swing = (Math.random()*2 - 1) * swingRange;
      let dWins = 0;

      for (let i=0;i<upSeats;i++){
        const pD = winProbD_fast(margins[i] + swing);
        if (Math.random() < pD) dWins++;
      }

      const dSeats = baseD + dWins;
      sumDSeats += dSeats;

      const isDemCtrl = (dSeats >= controlLine) || (tieIsDem && dSeats === tieSeat);
      if (isDemCtrl) demControl++;
    }

    const pDem = demControl / sims;
    const expDem = sumDSeats / sims;

    results[day] = { date: dates[day], pDem, expDem };

    if ((day % 10) === 0){
      self.postMessage({ type:"progress", modeKey, runId, day, totalDays: dates.length });
    }
  }

  self.postMessage({ type:"done", modeKey, runId, results });
};
