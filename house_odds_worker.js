// house_odds_worker.js — Monte Carlo House seat simulation worker
// Extracted from midterm-2.html inline Blob worker

// Worker: compute daily House Dem-control probability using 10k simulations/day.
const WINP_MIN = -40, WINP_MAX = 40, WINP_STEP = 0.1;
const WINP_N = Math.round((WINP_MAX - WINP_MIN) / WINP_STEP) + 1;
const PROB_ERROR_SD_PTS = 7;

function clamp(x, a, b){ return x < a ? a : (x > b ? b : x); }

// fast erf approximation (Abramowitz-Stegun 7.1.26)
function erf(x){
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
  const t = 1/(1+0.3275911*x);
  const y = 1 - (((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t)*Math.exp(-x*x);
  return sign*y;
}
function normalCDF(x){ return 0.5*(1 + erf(x/Math.SQRT2)); }
function winProbFromMargin(m){
  const z = m / PROB_ERROR_SD_PTS;
  const pR = clamp(normalCDF(z), 0, 1);
  return 1 - pR; // pD
}

const WINP_PD_TABLE = new Float32Array(WINP_N);
for (let i=0;i<WINP_N;i++){
  const m = WINP_MIN + i*WINP_STEP;
  WINP_PD_TABLE[i] = winProbFromMargin(m);
}
function winProbD_fast(m){
  if (!isFinite(m)) return 0.5;
  const mm = clamp(m, WINP_MIN, WINP_MAX);
  const idx = Math.round((mm - WINP_MIN) / WINP_STEP);
  return WINP_PD_TABLE[idx] ?? 0.5;
}

function randn(){
  // Box-Muller
  let u=0, v=0;
  while (u===0) u = Math.random();
  while (v===0) v = Math.random();
  return Math.sqrt(-2.0*Math.log(u)) * Math.cos(2.0*Math.PI*v);
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type !== "run") return;

  const dates = msg.dates || [];
  const gbD = msg.gbD || [];
  const gbR = msg.gbR || [];
  const ratioD = msg.ratioD || [];
  const ratioR = msg.ratioR || [];
  const seatTotal = msg.seatTotal || ratioD.length;
  const majorityLine = msg.majorityLine || Math.floor(seatTotal/2)+1;
  const sims = msg.sims || 10000;
  const swingRange = msg.swingRange || 7;
  const swingStep = msg.swingStep || 0.1;

  // discrete swing grid (uniformly sampled)
  const swings = [];
  for (let s=-swingRange; s<=swingRange+1e-9; s+=swingStep) swings.push(s);
  const nSw = swings.length;

  const margins = new Float32Array(seatTotal);
  const results = new Array(dates.length);

  for (let day=0; day<dates.length; day++){
    const d0 = +gbD[day];
    const r0 = +gbR[day];

    // compute per-seat baseline margin (R-D)
    for (let k=0;k<seatTotal;k++){
      let m = 0;
      if (k < ratioD.length){
        const a = +ratioD[k];
        const b = +ratioR[k];
        const den = d0*a + r0*b;
        if (den > 0){
          m = 100 * (r0*b - d0*a) / den;
        } else {
          m = 0;
        }
      } else {
        m = 0; // missing seats: pure tossup
      }
      margins[k] = m;
    }

    // conditional mean/var for each swing bucket
    const muBy = new Float32Array(nSw);
    const vaBy = new Float32Array(nSw);

    for (let j=0;j<nSw;j++){
      const sw = swings[j];
      let mu = 0, va = 0;
      for (let k=0;k<seatTotal;k++){
        const p = winProbD_fast(margins[k] + sw);
        mu += p;
        va += p*(1-p);
      }
      muBy[j] = mu;
      vaBy[j] = va;
    }

    let demWins = 0;
    let seatSum = 0;

    for (let s=0;s<sims;s++){
      const j = (Math.random()*nSw) | 0;
      const mu = muBy[j];
      const va = vaBy[j];

      let seats = mu;
      if (va > 1e-9){
        seats = mu + Math.sqrt(va) * randn();
      }
      seats = Math.round(seats);
      if (seats < 0) seats = 0;
      if (seats > seatTotal) seats = seatTotal;

      seatSum += seats;
      if (seats >= majorityLine) demWins++;
    }

    results[day] = { date: dates[day], pDem: demWins / sims, expDem: seatSum / sims };

    if (day % 7 === 0){
      self.postMessage({ type:"progress", day, total: dates.length });
    }
  }

  self.postMessage({ type:"done", results });
};
