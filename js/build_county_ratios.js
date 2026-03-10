#!/usr/bin/env node
// build_county_ratios.js — Downloads 2012-2024 county presidential results,
// computes ratio model (county/state), and builds json/county_ratios.json
//
// Ratio formula:  dRatio = county_D% / state_D%,  rRatio = county_R% / state_R%
// Ratios use 2024 data. Historical years stored in hist for tooltip display.

const fs = require("fs");
const https = require("https");

const BASE = "https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master";
const URLS = {
  y2024: `${BASE}/2024_US_County_Level_Presidential_Results.csv`,
  y2020: `${BASE}/2020_US_County_Level_Presidential_Results.csv`,
  y1216: `${BASE}/US_County_Level_Presidential_Results_12-16.csv`,
};
const OUT_FILE = "json/county_ratios.json";

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

const ABBR_TO_USPS = {};
for (const [, usps] of Object.entries(NAME_TO_USPS)) ABBR_TO_USPS[usps] = usps;

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve, reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function cleanCountyName(raw) {
  return raw
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|city|City and Borough)$/i, "")
    .replace(/^St\.\s/i, "ST. ")
    .trim()
    .toUpperCase();
}

// Parse 2020 or 2024 CSV (same format):
// state_name,county_fips,county_name,votes_gop,votes_dem,total_votes,diff,per_gop,per_dem,per_point_diff
function parseStandardCSV(csv) {
  const lines = csv.split(/\r?\n/);
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
    if (totalVotes < 10) continue;
    const usps = NAME_TO_USPS[stateName.toLowerCase()];
    if (!usps) continue;
    rows.push({
      usps, fips,
      countyName: cleanCountyName(countyRaw),
      votesDem, votesGop, totalVotes,
      perDem: perDem * 100,
      perGop: perGop * 100
    });
  }
  return rows;
}

// Parse the combined 12-16 CSV. Column layout (from data inspection):
// 0:index, 1:fips_12, 2:dem_12, 3:gop_12, 4:total_12, 5:per_dem_12, 6:per_gop_12, 7:diff_12, 8:ppd_12,
// 9:state_abbr, 10:county_name, 11:fips_16_full, 12:total_16, 13:dem_16, 14:gop_16, 15:county_part, 16:state_part,
// 17:per_dem_16, 18:per_gop_16, 19:diff_16, 20:ppd_16
function parse1216CSV(csv) {
  const lines = csv.split(/\r?\n/);
  const rows12 = [], rows16 = [];
  const start = lines[0].match(/^\d/) ? 0 : 1;
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 20) continue;
    const stAbbr = cols[9]?.trim().toUpperCase();
    const usps = ABBR_TO_USPS[stAbbr];
    if (!usps) continue;
    const countyName = cleanCountyName(cols[10]?.trim() || "");
    const fipsFull = cols[11]?.trim();
    if (!countyName || !fipsFull) continue;

    // 2012
    const dem12 = parseFloat(cols[2]);
    const gop12 = parseFloat(cols[3]);
    const total12 = parseFloat(cols[4]);
    const perDem12 = parseFloat(cols[5]);
    const perGop12 = parseFloat(cols[6]);
    if (isFinite(perDem12) && isFinite(perGop12) && total12 > 10) {
      rows12.push({
        usps, fips: fipsFull, countyName,
        votesDem: dem12, votesGop: gop12, totalVotes: total12,
        perDem: perDem12 * 100, perGop: perGop12 * 100
      });
    }

    // 2016
    const dem16 = parseFloat(cols[13]);
    const gop16 = parseFloat(cols[14]);
    const total16 = parseFloat(cols[12]);
    const perDem16 = parseFloat(cols[17]);
    const perGop16 = parseFloat(cols[18]);
    if (isFinite(perDem16) && isFinite(perGop16) && total16 > 10) {
      rows16.push({
        usps, fips: fipsFull, countyName,
        votesDem: dem16, votesGop: gop16, totalVotes: total16,
        perDem: perDem16 * 100, perGop: perGop16 * 100
      });
    }
  }
  return { rows12, rows16 };
}

// Build a lookup: { "AL": { "AUTAUGA": { perDem, perGop } } }
function buildHistLookup(rows) {
  const lookup = {};
  for (const r of rows) {
    if (!lookup[r.usps]) lookup[r.usps] = {};
    lookup[r.usps][r.countyName] = { perDem: +r.perDem.toFixed(1), perGop: +r.perGop.toFixed(1) };
  }
  return lookup;
}

async function main() {
  console.log("Downloading county election data...");
  const [csv24, csv20, csv1216] = await Promise.all([
    fetchURL(URLS.y2024).then(d => { console.log("  ✓ 2024"); return d; }),
    fetchURL(URLS.y2020).then(d => { console.log("  ✓ 2020"); return d; }),
    fetchURL(URLS.y1216).then(d => { console.log("  ✓ 2012-16"); return d; }),
  ]);

  const rows24 = parseStandardCSV(csv24);
  const rows20 = parseStandardCSV(csv20);
  const { rows12, rows16 } = parse1216CSV(csv1216);

  console.log(`  2024: ${rows24.length}, 2020: ${rows20.length}, 2016: ${rows16.length}, 2012: ${rows12.length}`);

  const hist20 = buildHistLookup(rows20);
  const hist16 = buildHistLookup(rows16);
  const hist12 = buildHistLookup(rows12);

  // Build output — ratios from 2024 county/state
  const output = {};
  const states = [...new Set(rows24.map(r => r.usps))].sort();

  for (const st of states) {
    const stRows = rows24.filter(r => r.usps === st);
    const counties = {};
    const fipsMap = {};

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

      const hist = {};
      const h12 = hist12[st]?.[r.countyName];
      const h16 = hist16[st]?.[r.countyName];
      const h20 = hist20[st]?.[r.countyName];
      if (h12) hist.pres12 = [h12.perDem, h12.perGop];
      if (h16) hist.pres16 = [h16.perDem, h16.perGop];
      if (h20) hist.pres20 = [h20.perDem, h20.perGop];
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

  const allStates = Object.values(NAME_TO_USPS);
  for (const st of allStates) {
    if (!output[st]) output[st] = { counties: {}, fips: {} };
  }

  if (!fs.existsSync("json")) fs.mkdirSync("json", { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output));

  let totalCounties = 0;
  for (const st of Object.keys(output)) totalCounties += Object.keys(output[st].counties).length;
  const size = (fs.statSync(OUT_FILE).size / 1024).toFixed(0);
  console.log(`\nWritten ${OUT_FILE}: ${totalCounties} counties, ${Object.keys(output).length} states, ${size} KB`);

  // Sanity checks
  const travis = output.TX?.counties["TRAVIS"];
  console.log(`\nTX TRAVIS: dR=${travis?.dRatio} rR=${travis?.rRatio}`);
  console.log(`  hist: ${JSON.stringify(travis?.hist)}`);
  const douglas = output.NE?.counties["DOUGLAS"];
  console.log(`NE DOUGLAS: dR=${douglas?.dRatio} rR=${douglas?.rRatio}`);
  console.log(`  hist: ${JSON.stringify(douglas?.hist)}`);

  let full = 0;
  for (const st of Object.keys(output)) {
    for (const c of Object.values(output[st].counties)) {
      if (c.hist.pres12 && c.hist.pres16 && c.hist.pres20 && c.hist.pres24) full++;
    }
  }
  console.log(`\nCounties with all 4 years: ${full}/${totalCounties}`);
}

main().catch(e => { console.error(e); process.exit(1); });
