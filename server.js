// ─── FORM LAB — Railway Server ───────────────────────────────────────────────
// Handles: CORS proxy + nightly race scanner + results settler + CSV download
// Runs on Railway — environment variables required:
//   PORT, PF_KEY, FF_KEY, LB_FROM, LB_PARTNER

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const PORT       = process.env.PORT || 3001;
const PF_KEY     = process.env.PF_KEY     || '';
const FF_KEY     = process.env.FF_KEY     || '';
const LB_FROM    = process.env.LB_FROM    || '';
const LB_PARTNER = process.env.LB_PARTNER || '';

// ─── METRO TRACKS ────────────────────────────────────────────────────────────
const METRO_TRACKS = [
  'flemington','caulfield','moonee valley','sandown','cranbourne',
  'randwick','rosehill','warwick farm',
  'eagle farm','doomben',
  'morphettville',
  'ascot','belmont park'
];

function isMetro(venueName) {
  const v = (venueName || '').toLowerCase();
  return METRO_TRACKS.some(t => v.includes(t));
}

// ─── AEST helpers ────────────────────────────────────────────────────────────
// AEST offset: UTC+10 standard, UTC+11 daylight saving
// Use fixed offset arithmetic — works on all Node.js environments
function aestNow() {
  const now = new Date();
  const aestOffset = 10 * 60; // AEST UTC+10 in minutes (conservative — no DST)
  return new Date(now.getTime() + aestOffset * 60 * 1000);
}

function aestDateStr(d) {
  const dt = d || aestNow();
  const day   = String(dt.getUTCDate()).padStart(2, '0');
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const year  = dt.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function aestDayName(d) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[(d || aestNow()).getUTCDay()];
}

function isoDate(d) {
  const dt = d || aestNow();
  const y  = dt.getUTCFullYear();
  const m  = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

// ─── CSV storage ─────────────────────────────────────────────────────────────
const CSV_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(CSV_DIR)) fs.mkdirSync(CSV_DIR);

function csvPath() {
  const now = aestNow();
  const month = now.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit' }).replace('/', '-');
  return path.join(CSV_DIR, `formlab_${month}.csv`);
}

const CSV_HEADER = 'Date,Track,Race,Horse,Tier,Odds,ScoreGap,Distance,Class,Result,PnL,Timing\n';

function loadCSV() {
  const p = csvPath();
  if (!fs.existsSync(p)) fs.writeFileSync(p, CSV_HEADER);
  return fs.readFileSync(p, 'utf8');
}

function saveCSV(content) {
  fs.writeFileSync(csvPath(), content);
}

function appendBet(bet) {
  let csv = loadCSV();
  const row = [
    bet.date, bet.track, bet.race, `"${bet.horse}"`,
    bet.tier, bet.odds, bet.scoreGap, bet.distance, bet.raceClass,
    bet.result || '', bet.pnl || '', bet.timing || 'day'
  ].join(',') + '\n';

  // avoid duplicates
  const key = `${bet.date},${bet.track},${bet.race},"${bet.horse}"`;
  if (csv.includes(key)) return;
  saveCSV(csv + row);
}

function updateResult(date, track, race, horse, result, pnl) {
  let csv = loadCSV();
  const lines = csv.split('\n');
  const updated = lines.map(line => {
    if (line.includes(date) && line.includes(track) && line.includes(race) && line.includes(horse)) {
      const cols = line.split(',');
      if (cols.length >= 11) {
        cols[9]  = result;
        cols[10] = pnl;
        return cols.join(',');
      }
    }
    return line;
  });
  saveCSV(updated.join('\n'));
}

// ─── HTTP fetch helper ───────────────────────────────────────────────────────
function fetchJSON(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(targetUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.path,
      method:   'GET',
      headers:  { 'Accept': 'application/json', ...headers }
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PuntingForm API ─────────────────────────────────────────────────────────
const PF_BASE = 'https://api.puntingform.com.au/v2/form';

async function pfMeetings(date) {
  const data = await fetchJSON(`${PF_BASE}/meetingslist?meetingDate=${date}&apiKey=${PF_KEY}`);
  return (data.payLoad || []);
}

async function pfForm(meetingId, raceNumber) {
  const data = await fetchJSON(`${PF_BASE}/form?meetingId=${meetingId}&raceNumber=${raceNumber}&runs=10&apiKey=${PF_KEY}`);
  return (data.payLoad || []);
}

async function pfFields(meetingId) {
  const data = await fetchJSON(`${PF_BASE}/fields?meetingId=${meetingId}&apiKey=${PF_KEY}`);
  return data.payLoad || null;
}

async function pfResults(meetingId, raceNumber) {
  try {
    const data = await fetchJSON(`${PF_BASE}/results?meetingId=${meetingId}&raceNumber=${raceNumber}&apiKey=${PF_KEY}`);
    return data.payLoad || null;
  } catch (e) {
    return null;
  }
}

// ─── Ladbrokes odds ──────────────────────────────────────────────────────────
const LB_BASE = 'https://api-affiliates.ladbrokes.com.au/affiliates/v1/racing';

async function lbMeetings(date) {
  try {
    const data = await fetchJSON(
      `${LB_BASE}/meetings?category=T&country=AUS&date_from=${date}&date_to=${date}&limit=200`,
      { 'from': LB_FROM, 'x-partner': LB_PARTNER }
    );
    return data.meetings || data || [];
  } catch (e) {
    console.warn('LB meetings error:', e.message);
    return [];
  }
}

async function lbRaceOdds(eventId) {
  try {
    const data = await fetchJSON(
      `${LB_BASE}/events/${eventId}`,
      { 'from': LB_FROM, 'x-partner': LB_PARTNER }
    );
    const odds = {};
    const selections = data.markets?.[0]?.selections || data.selections || [];
    selections.forEach(s => {
      const name = (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      odds[name] = { price: s.price?.win || s.win_price || 0, tabNo: s.tab_no || s.number };
    });
    return odds;
  } catch (e) {
    return {};
  }
}

// ─── Simple scoring engine ───────────────────────────────────────────────────
function classifyRace(notes) {
  const n = (notes || '').toUpperCase();
  if (n.includes('MAIDEN')) return 'Maiden';
  if (n.includes('CLASS 1')) return 'Class 1';
  if (n.includes('CLASS 2')) return 'Class 2';
  if (n.includes('CLASS 3')) return 'Class 3';
  const bm = n.match(/BM(\d+)/);
  if (bm) {
    const v = parseInt(bm[1]);
    if (v <= 56) return 'BM50-56';
    if (v <= 64) return 'BM58-64';
    if (v <= 72) return 'BM66-72';
    if (v <= 80) return 'BM74-80';
    return 'BM82+';
  }
  return 'Other';
}

function scoreRunner(runner, raceConditions) {
  let score = 50;

  // Career record
  const starts = runner.careerStarts || 0;
  const wins   = runner.careerWins   || 0;
  const places = (runner.careerSeconds || 0) + (runner.careerThirds || 0);
  if (starts > 0) {
    score += (wins / starts) * 20;
    score += (places / starts) * 8;
  }
  if (starts >= 5 && wins === 0) score -= 5;

  // Going record
  const going    = (raceConditions.trackCondition || 'Good').toLowerCase();
  const synthetic = (raceConditions.trackSurface || '').toLowerCase() === 'synthetic' ||
                    (raceConditions.venueName || '').toLowerCase().includes('synthetic') ||
                    (raceConditions.venueName || '').toLowerCase().includes('pakenham');
  let goingRec;
  if (synthetic) goingRec = runner.syntheticRecord;
  else if (going.includes('firm'))  goingRec = runner.firmRecord;
  else if (going.includes('soft'))  goingRec = runner.softRecord;
  else if (going.includes('heavy')) goingRec = runner.heavyRecord;
  else                              goingRec = runner.goodRecord;

  if (goingRec && goingRec.starts > 0) {
    const gwr = goingRec.firsts / goingRec.starts;
    score += gwr * 15;
    if (goingRec.firsts === 0 && goingRec.starts >= 3) score -= 5;
  }

  // Distance record
  const distRec = runner.distanceRecord;
  if (distRec && distRec.starts > 0) {
    score += (distRec.firsts / distRec.starts) * 12;
    if (distRec.firsts === 0 && distRec.starts >= 3) score -= 4;
  }

  // Track record
  const trkRec = runner.trackRecord;
  if (trkRec && trkRec.starts > 0) {
    score += (trkRec.firsts / trkRec.starts) * 10;
  }

  // Win% and place%
  score += (runner.winPct || 0) * 0.15;
  score += (runner.placePct || 0) * 0.05;

  // Last 10 form
  const last10 = (runner.last10 || '').replace(/\s/g, '');
  if (last10.length >= 3) {
    const recent = last10.slice(0, 5).split('');
    let formBonus = 0;
    recent.forEach((r, i) => {
      const w = 5 - i;
      if (r === '1') formBonus += w * 2;
      else if (r === '2' || r === '3') formBonus += w * 0.8;
      else if (r === '0' || r === 'x') formBonus -= w * 0.5;
    });
    score += Math.min(Math.max(formBonus, -8), 12);
  }

  // Prize money
  const prize = raceConditions.prizeMoney || 0;
  if (prize >= 100000) score += 3;
  else if (prize >= 50000) score += 1.5;

  return Math.round(score * 10) / 10;
}

function getScoreGap(runners, thisRunner) {
  const sorted = [...runners].sort((a, b) => (b.algoScore || 0) - (a.algoScore || 0));
  const topScore = sorted[0]?.algoScore || 0;
  const myScore  = thisRunner.algoScore || 0;
  const myRank   = sorted.findIndex(r => r.runnerId === thisRunner.runnerId || r.name === thisRunner.name);
  if (myRank !== 0) return null; // only recommend rank 1
  const secondScore = sorted[1]?.algoScore || 0;
  return Math.round((myScore - secondScore) * 10) / 10;
}

function isSAVenue(venueName) {
  const v = (venueName || '').toLowerCase();
  return v.includes('morphettville') || v.includes('gawler') || v.includes('balaklava') ||
         v.includes('murray bridge') || v.includes('strathalbyn') || v.includes('mt gambier') ||
         v.includes('naracoorte') || v.includes('port augusta');
}

function getMinGap(venueName, dayName) {
  if (isSAVenue(venueName)) return 4;
  if (isMetro(venueName)) {
    const month = aestNow().getMonth() + 1;
    const isWinter = month >= 6 && month <= 8;
    if (dayName === 'Wednesday' && isWinter) return 2;
    return 0;
  }
  return 2; // provincial/country
}

// ─── Discord alert ───────────────────────────────────────────────────────────
async function sendDiscord(message) {
  if (!process.env.DISCORD_WEBHOOK) return;
  try {
    const body = JSON.stringify({ content: message });
    await new Promise((resolve, reject) => {
      const u = url.parse(process.env.DISCORD_WEBHOOK);
      const req = https.request({
        hostname: u.hostname, path: u.path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.warn('Discord error:', e.message);
  }
}

// ─── MAIN SCANNER ─────────────────────────────────────────────────────────────
async function runScanner() {
  const now     = aestNow();
  const dayName = aestDayName(now);
  const dateStr = isoDate(now);
  const metroOnly = dayName === 'Wednesday' || dayName === 'Saturday';

  console.log(`\n[SCANNER] ${dayName} ${dateStr} — ${metroOnly ? 'Metro only' : 'All meetings'}`);
  await sendDiscord(`🏇 **Form Lab Scanner starting** — ${dayName} ${dateStr}\n${metroOnly ? 'Metro meetings only' : 'All meetings'}`);

  let meetings;
  try {
    meetings = await pfMeetings(dateStr);
  } catch (e) {
    console.error('[SCANNER] Failed to fetch meetings:', e.message);
    return;
  }

  // Filter thoroughbred only and apply metro filter
  meetings = meetings.filter(m => {
    const venue = (m.track?.name || m.venueName || '').toLowerCase();
    if (metroOnly && !isMetro(venue)) return false;
    return true;
  });

  console.log(`[SCANNER] ${meetings.length} meetings to scan`);

  // Fetch LB meetings for odds matching
  const lbMeetingData = await lbMeetings(dateStr);
  const lbEventMap = {};
  (lbMeetingData.meetings || lbMeetingData || []).forEach(m => {
    const name = (m.name || m.venue_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    (m.events || m.races || []).forEach(e => {
      const raceNum = e.race_number || e.number || '';
      lbEventMap[`${name}_r${raceNum}`] = e.id || e.event_id;
    });
  });

  let totalRecs = 0;
  const allRecs = [];

  for (const meeting of meetings) {
    const venue     = meeting.track?.name || meeting.venueName || 'Unknown';
    const meetingId = meeting.meetingId || meeting.id;
    const surface   = meeting.track?.surface || '';

    // Fetch fields to get race list
    let fields;
    try {
      fields = await pfFields(meetingId);
      await sleep(500);
    } catch (e) {
      console.warn(`[SCANNER] Fields error for ${venue}:`, e.message);
      continue;
    }

    const races = fields?.races || [];

    for (const race of races) {
      const raceNum  = race.number || race.raceNumber;
      const distance = race.distance || 0;
      const prize    = race.prizeMoney || 0;
      const raceClass = race.raceClass || race.class || '';

      // Fetch form
      let formRunners;
      try {
        formRunners = await pfForm(meetingId, raceNum);
        await sleep(600);
      } catch (e) {
        console.warn(`[SCANNER] Form error ${venue} R${raceNum}:`, e.message);
        continue;
      }

      if (!formRunners || formRunners.length === 0) continue;

      // Fetch LB odds
      const venueKey  = venue.toLowerCase().replace(/[^a-z0-9]/g, '');
      const eventId   = lbEventMap[`${venueKey}_r${raceNum}`];
      let lbOdds = {};
      if (eventId) {
        lbOdds = await lbRaceOdds(eventId);
        await sleep(400);
      }

      // Build runners
      const raceConditions = {
        trackCondition: meeting.expectedCondition || 'Good',
        prizeMoney: prize,
        raceDistance: distance,
        venueName: venue,
        trackSurface: surface
      };

      let runners = formRunners.map(r => {
        const nameKey = (r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const lbEntry = lbOdds[nameKey];
        const odds    = lbEntry?.price || r.priceSP || 0;
        return {
          ...r,
          runnerName: r.name,
          algoScore:  0,
          bfOdds:     odds,
          tabNo:      lbEntry?.tabNo || r.tabNo
        };
      });

      // Score
      runners = runners.map(r => ({
        ...r,
        algoScore: scoreRunner(r, raceConditions)
      })).sort((a, b) => b.algoScore - a.algoScore);

      // Check top runner
      const top = runners[0];
      if (!top || !top.bfOdds || top.bfOdds < 1.3) continue;

      const scoreGap = getScoreGap(runners, top);
      if (scoreGap === null) continue;

      const minGap = getMinGap(venue, dayName);
      if (scoreGap < minGap) continue;

      // Tier A only
      const tierA = top.bfOdds >= 1.5 && top.bfOdds <= 12 && scoreGap >= minGap;
      if (!tierA) continue;

      totalRecs++;
      const bet = {
        date:      aestDateStr(now),
        track:     venue,
        race:      `R${raceNum}`,
        horse:     top.runnerName || top.name,
        tier:      'A',
        odds:      top.bfOdds,
        scoreGap:  scoreGap,
        distance:  distance,
        raceClass: raceClass,
        result:    '',
        pnl:       '',
        timing:    'day'
      };

      appendBet(bet);
      allRecs.push(bet);

      console.log(`[REC] ${venue} R${raceNum}: ${bet.horse} @ $${bet.odds} gap:${scoreGap}`);
    }
  }

  // Send Discord summary
  if (allRecs.length === 0) {
    await sendDiscord(`✅ Scan complete — no Tier A recommendations today`);
  } else {
    let msg = `🏇 **Form Lab — ${dayName} ${dateStr} Recommendations**\n\n`;
    allRecs.forEach(b => {
      msg += `📍 **${b.track} ${b.race}** — ${b.horse}\n`;
      msg += `   Odds: $${b.odds} | Gap: +${b.scoreGap} | Dist: ${b.distance}m | ${b.raceClass}\n\n`;
    });
    msg += `_${allRecs.length} Tier A pick${allRecs.length > 1 ? 's' : ''} — good luck Jed_ 🍀`;
    await sendDiscord(msg);
  }

  console.log(`[SCANNER] Complete — ${totalRecs} recommendations`);
}

// ─── RESULTS SETTLER ─────────────────────────────────────────────────────────
async function runSettler() {
  const now     = aestNow();
  const dateStr = aestDateStr(now);
  console.log(`\n[SETTLER] Settling results for ${dateStr}`);

  const csv   = loadCSV();
  const lines = csv.split('\n');
  let settled = 0;

  // Get today's meetings for meeting IDs
  const meetings = await pfMeetings(isoDate(now));

  for (const meeting of meetings) {
    const venue     = meeting.track?.name || meeting.venueName || '';
    const meetingId = meeting.meetingId || meeting.id;
    const fields    = await pfFields(meetingId);
    if (!fields) continue;
    await sleep(400);

    for (const race of (fields.races || [])) {
      const raceNum = race.number || race.raceNumber;
      const results = await pfResults(meetingId, raceNum);
      if (!results) continue;
      await sleep(400);

      // Find winners/placers
      const finishers = Array.isArray(results) ? results : (results.runners || []);
      const winner    = finishers.find(r => r.position === 1 || r.finishingPosition === 1);
      const second    = finishers.find(r => r.position === 2 || r.finishingPosition === 2);
      const third     = finishers.find(r => r.position === 3 || r.finishingPosition === 3);

      // Match against our logged bets
      lines.forEach((line, i) => {
        if (i === 0 || !line.trim()) return; // skip header
        const cols = line.split(',');
        if (cols.length < 10) return;
        const [betDate, betTrack, betRace, betHorse] = cols;
        if (cols[9]) return; // already settled

        if (betDate !== dateStr) return;
        if (!betTrack.toLowerCase().includes(venue.toLowerCase().substring(0, 5))) return;
        if (betRace !== `R${raceNum}`) return;

        const horseName = betHorse.replace(/"/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const odds = parseFloat(cols[5]) || 0;
        const stake = 10;

        let result = 'L';
        let pnl = -stake;

        if (winner && (winner.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === horseName) {
          result = 'W';
          pnl = Math.round((odds - 1) * stake * 100) / 100;
        } else if (
          (second && (second.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === horseName) ||
          (third  && (third.name  || '').toLowerCase().replace(/[^a-z0-9]/g, '') === horseName)
        ) {
          result = 'P';
          pnl = -stake;
        }

        cols[9]  = result;
        cols[10] = pnl;
        lines[i] = cols.join(',');
        settled++;
        console.log(`[SETTLER] ${betTrack} ${betRace} ${betHorse}: ${result} P&L: $${pnl}`);
      });
    }
  }

  saveCSV(lines.join('\n'));

  if (settled > 0) {
    await sendDiscord(`📊 **Results settled** — ${settled} bet${settled > 1 ? 's' : ''} updated for ${dateStr}`);
  }
  console.log(`[SETTLER] Complete — ${settled} results settled`);
}

// ─── CRON SCHEDULER ──────────────────────────────────────────────────────────
// Check every minute if it's time to run scanner (9am) or settler (6pm) AEST
// Only run on racing days — skip Saturday scanner (metro already covered) and check day rules

const SCAN_DAYS    = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const SKIP_SCANNER = []; // all days covered — Wednesday/Saturday filtered inside scanner

let lastScanDate   = '';
let lastSettleDate = '';

setInterval(() => {
  const now     = aestNow();
  const hour    = now.getHours();
  const minute  = now.getMinutes();
  const dateStr = isoDate(now);
  const dayName = aestDayName(now);

  // Run scanner at 9:00am AEST on racing days
  if (hour === 9 && minute === 0 && dateStr !== lastScanDate && SCAN_DAYS.includes(dayName)) {
    lastScanDate = dateStr;
    runScanner().catch(e => console.error('[SCANNER] Error:', e.message));
  }

  // Run settler at 6:00pm AEST on racing days
  if (hour === 18 && minute === 0 && dateStr !== lastSettleDate && SCAN_DAYS.includes(dayName)) {
    lastSettleDate = dateStr;
    runSettler().catch(e => console.error('[SETTLER] Error:', e.message));
  }
}, 60 * 1000);

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = url.parse(req.url);

  // ── GET /results — download CSV ──────────────────────────────────────────
  if (reqUrl.pathname === '/results') {
    const now   = aestNow();
    const month = now.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: 'long' });
    const csv   = loadCSV();
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="formlab_${month.replace(' ', '_')}.csv"`
    });
    res.end(csv);
    return;
  }

  // ── GET /scan — manual trigger ────────────────────────────────────────────
  if (reqUrl.pathname === '/scan') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Scanner started', time: aestNow().toISOString() }));
    runScanner().catch(e => console.error('[MANUAL SCAN] Error:', e.message));
    return;
  }

  // ── GET /settle — manual settle trigger ───────────────────────────────────
  if (reqUrl.pathname === '/settle') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Settler started', time: aestNow().toISOString() }));
    runSettler().catch(e => console.error('[MANUAL SETTLE] Error:', e.message));
    return;
  }

  // ── GET /status — health check ────────────────────────────────────────────
  if (reqUrl.pathname === '/status') {
    const csv   = loadCSV();
    const bets  = csv.split('\n').filter(l => l.trim() && !l.startsWith('Date')).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:        'Form Lab proxy running',
      time:          new Date().toISOString(),
      lastScanDate,
      lastSettleDate,
      betsLogged:    bets
    }));
    return;
  }

  // ── PROXY — forward all other requests ───────────────────────────────────
  const targetUrl = req.url.slice(1);
  if (!targetUrl) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Form Lab Proxy — OK');
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = url.parse(decodeURIComponent(targetUrl));
  } catch (e) {
    res.writeHead(400);
    res.end('Invalid URL');
    return;
  }

  const isHttps = parsedUrl.protocol === 'https:';
  const lib     = isHttps ? https : http;
  const options = {
    hostname: parsedUrl.hostname,
    port:     parsedUrl.port || (isHttps ? 443 : 80),
    path:     parsedUrl.path,
    method:   req.method,
    headers:  {}
  };

  const forwardHeaders = [
    'x-application','x-authentication','content-type','accept',
    'from','x-partner','x-api-key','authorization'
  ];
  forwardHeaders.forEach(h => {
    if (req.headers[h]) options.headers[h] = req.headers[h];
  });

  const proxyReq = lib.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': proxyRes.headers['content-type'] || 'application/json'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    console.error('Proxy error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });

  if (req.method === 'POST') req.pipe(proxyReq);
  else proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`\n  ██████╗  █████╗  ██████╗██╗███╗   ██╗ ██████╗`);
  console.log(`  Form Lab Server running on port ${PORT}`);
  console.log(`  Scanner: 9am AEST daily`);
  console.log(`  Settler: 6pm AEST daily`);
  console.log(`  Results: /results`);
  console.log(`  Status:  /status\n`);
});
