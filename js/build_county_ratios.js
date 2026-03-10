#!/usr/bin/env node
// build_county_ratios.js — Downloads 2024 county presidential results,
// computes ratio model, and builds json/county_ratios.json
//
// Usage: node build_county_ratios.js
//
// Ratio formula:
//   dRatio = county_dem_pct / national_dem_pct
//   rRatio = county_gop_pct / national_gop_pct
//
// Output format per state:
//   { counties: { "COUNTY_NAME": { dRatio, rRatio, hist: { pres24: [D%, R%] } } }, fips: {} }

const fs = require("fs");
const https = require("https");

const CSV_URL = "https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/2024_US_County_Level_Presidential_Results.csv";
const OUT_FILE = "json/county_ratios.json";

// State name → USPS
const NAME_TO_USPS = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
  "colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
  "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL",
  "indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
  "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR",
  "pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
  "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
};

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function cleanCountyName(raw) {
  // Remove suffixes like " County", " Parish", " Borough", " Census Area", etc.
  return raw
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|city|City and Borough)$/i, "")
    .replace(/^St\.\s/i, "ST. ")
    .trim()
    .toUpperCase();
}

async function main() {
  console.log("Downloading 2024 county results...");
  const csv = await fetch(CSV_URL);
  const lines = csv.split(/\r?\n/);
  const headers = lines[0].split(",");

  // Parse all rows
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 10) continue;
    const stateName = cols[0]?.trim();
    const fips = cols[1]?.trim();
    const countyRaw = cols[2]?.trim();
    const votesGop = parseFloat(cols[3]);
    const votesDem = parseFloat(cols[4]);
    const totalVotes = parseFloat(cols[5]);
    const perGop = parseFloat(cols[7]);
    const perDem = parseFloat(cols[8]);

    if (!stateName || !fips || !isFinite(perGop) || !isFinite(perDem)) continue;
    if (totalVotes < 10) continue; // skip tiny

    const usps = NAME_TO_USPS[stateName.toLowerCase()];
    if (!usps) continue;

    rows.push({
      usps,
      fips,
      countyName: cleanCountyName(countyRaw),
      votesDem,
      votesGop,
      totalVotes,
      perDem: perDem * 100, // convert to percentage
      perGop: perGop * 100
    });
  }

  console.log(`  Parsed ${rows.length} county rows across ${new Set(rows.map(r => r.usps)).size} states`);

  // Load existing county_ratios.json to preserve Texas historical data
  let existing = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
      console.log(`  Loaded existing ${OUT_FILE} (${Object.keys(existing).length} states)`);
    } catch (e) {
      console.warn(`  Could not parse existing ${OUT_FILE}:`, e.message);
    }
  }

  // Build output — ratios are county/STATE (not county/national)
  // because forecast.js multiplies ratios by the state-level model output
  const output = {};
  const states = [...new Set(rows.map(r => r.usps))].sort();

  for (const st of states) {
    const stRows = rows.filter(r => r.usps === st);
    const counties = {};
    const fipsMap = {};

    // Compute state-level D% and R% from vote totals
    let stDem = 0, stGop = 0, stTotal = 0;
    for (const r of stRows) {
      stDem += r.votesDem;
      stGop += r.votesGop;
      stTotal += r.totalVotes;
    }
    const stDemPct = stTotal > 0 ? (stDem / stTotal) * 100 : 50;
    const stGopPct = stTotal > 0 ? (stGop / stTotal) * 100 : 50;

    for (const r of stRows) {
      const dRatio = stDemPct > 0 ? r.perDem / stDemPct : 0;
      const rRatio = stGopPct > 0 ? r.perGop / stGopPct : 0;

      // Preserve existing historical data if available (e.g. Texas)
      const existingCounty = existing[st]?.counties?.[r.countyName];
      const hist = existingCounty?.hist || {};
      hist.pres24 = [+r.perDem.toFixed(1), +r.perGop.toFixed(1)];

      counties[r.countyName] = {
        dRatio: +dRatio.toFixed(5),
        rRatio: +rRatio.toFixed(5),
        hist
      };

      fipsMap[r.fips.padStart(5, "0")] = r.countyName;
    }

    output[st] = { counties, fips: fipsMap };
  }

  // Ensure all 50 states exist (even if no data)
  const allStates = Object.values(NAME_TO_USPS);
  for (const st of allStates) {
    if (!output[st]) output[st] = { counties: {}, fips: {} };
  }

  // Write output
  if (!fs.existsSync("json")) fs.mkdirSync("json", { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output));

  // Stats
  let totalCounties = 0;
  for (const st of Object.keys(output)) totalCounties += Object.keys(output[st].counties).length;
  const size = (fs.statSync(OUT_FILE).size / 1024).toFixed(0);
  console.log(`\n  Written ${OUT_FILE}: ${totalCounties} counties, ${Object.keys(output).length} states, ${size} KB`);

  // Sanity checks
  const tx = output.TX;
  if (tx) {
    const travis = tx.counties["TRAVIS"];
    const harris = tx.counties["HARRIS"];
    console.log(`\n  TX TRAVIS: dR=${travis?.dRatio} rR=${travis?.rRatio} hist=${JSON.stringify(travis?.hist?.pres24)}`);
    console.log(`  TX HARRIS: dR=${harris?.dRatio} rR=${harris?.rRatio} hist=${JSON.stringify(harris?.hist?.pres24)}`);
  }
  const ca = output.CA;
  if (ca) {
    const la = ca.counties["LOS ANGELES"];
    console.log(`  CA LOS ANGELES: dR=${la?.dRatio} rR=${la?.rRatio} hist=${JSON.stringify(la?.hist?.pres24)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
