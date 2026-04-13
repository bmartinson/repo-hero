/**
 * gather-weekly.js
 *
 * Splits a date range into weekly chunks and runs gather-and-rank.js
 * for each week sequentially. Reads dates from config.json or accepts
 * --start / --end CLI overrides.
 *
 * Usage:
 *   node gather-weekly.js
 *   node gather-weekly.js --start 2026-01-01 --end 2026-03-31
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Colors ─────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
};

// ─── Parse dates ────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

let startDate = config.startDate;
let endDate = config.endDate;

const args = process.argv.slice(2);
const startIdx = args.indexOf('--start');
const endIdx = args.indexOf('--end');
if (startIdx !== -1 && args[startIdx + 1]) startDate = args[startIdx + 1];
if (endIdx !== -1 && args[endIdx + 1]) endDate = args[endIdx + 1];

// Cap end date at today so we never query future data
const today = new Date().toISOString().slice(0, 10);
if (endDate > today) {
  console.log(`End date ${endDate} is in the future — capping at ${today}`);
  endDate = today;
}

if (!startDate || !endDate) {
  console.error(`${C.red}Missing start or end date.${C.reset}`);
  process.exit(1);
}

// ─── Generate weekly ranges ─────────────────────────────────────────────────
function toDate(str) {
  return new Date(str + 'T00:00:00');
}

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function generateWeeks(start, end) {
  const weeks = [];
  const startD = toDate(start);
  const endD = toDate(end);

  // Anchor to the 1st of the start month so week boundaries are always
  // consistent regardless of which sub-range is requested.
  let cursor = new Date(startD.getFullYear(), startD.getMonth(), 1);

  while (cursor <= endD) {
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);

    // Cap at end of the current month so weeks never cross month boundaries
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const cappedEnd = weekEnd > monthEnd ? monthEnd : weekEnd;

    // Only include this week if it overlaps the requested range
    if (cappedEnd >= startD && cursor <= endD) {
      const wStart = cursor < startD ? startD : cursor;
      const wEnd = cappedEnd > endD ? endD : cappedEnd;
      weeks.push({ start: toISO(wStart), end: toISO(wEnd) });
    }

    // Move cursor to next day after this week
    cursor = new Date(cappedEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return weeks;
}

const weeks = generateWeeks(startDate, endDate);
const resultsDir = path.join(__dirname, '.results_history');

// ─── Detect and remove overlapping weekly files ─────────────────────────────
// Remove existing YYYY-MM-DD_YYYY-MM-DD.json files that overlap our target
// weeks but have different boundaries (from prior runs with different date caps).
// Only removes files ≤ 14 days to avoid deleting monthly or large-range files.

const expectedFiles = new Set(weeks.map(w => `${w.start}_${w.end}.json`));

if (fs.existsSync(resultsDir)) {
  const existing = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));
  const dateRangePattern = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/;
  const monthlyPattern = /^(\d{4}-\d{2})\.json$/;

  existing.forEach(f => {
    if (expectedFiles.has(f)) return; // exact match — keep
    const m = f.match(dateRangePattern);
    if (!m) {
      // Check if it's a monthly file (YYYY-MM.json) covered by our target weeks
      const mm = f.match(monthlyPattern);
      if (mm) {
        const monthStr = mm[1]; // e.g. "2026-03"
        const monthStart = monthStr + '-01';
        const monthEndD = new Date(monthStr + '-01T00:00:00');
        monthEndD.setMonth(monthEndD.getMonth() + 1);
        monthEndD.setDate(monthEndD.getDate() - 1);
        const monthEnd = monthEndD.toISOString().slice(0, 10);

        // Remove the monthly file if our weekly range overlaps this month
        if (monthStart <= endDate && monthEnd >= startDate) {
          console.log(
            `${C.yellow}Removing superseded monthly file: ${f}${C.reset}`
          );
          fs.unlinkSync(path.join(resultsDir, f));
        }
      }
      return;
    }

    const fStart = m[1];
    const fEnd = m[2];
    const spanDays =
      (new Date(fEnd + 'T00:00:00') - new Date(fStart + 'T00:00:00')) /
      86400000;

    // Only consider files that are roughly week-sized (≤ 14 days)
    if (spanDays > 14) return;

    // Check if this file's range overlaps any of our target weeks
    const overlaps = weeks.some(w => fStart <= w.end && fEnd >= w.start);
    if (overlaps) {
      console.log(`${C.yellow}Removing stale overlapping file: ${f}${C.reset}`);
      fs.unlinkSync(path.join(resultsDir, f));
    }
  });
}

// Check which weeks already have results
const existingFiles = new Set(
  fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'))
    : []
);

// Always re-gather every week in the range so data stays fresh.
weeks.forEach(w => {
  const file = `${w.start}_${w.end}.json`;
  if (existingFiles.has(file)) {
    fs.unlinkSync(path.join(resultsDir, file));
    existingFiles.delete(file);
  }
});

const pending = weeks;

console.log(`\n${C.cyan}Repo Hero — Weekly Gather${C.reset}`);
console.log(
  `${C.dim}Range: ${startDate} → ${endDate}  (${weeks.length} weeks total)${C.reset}\n`
);

// ─── Run gather for each week ───────────────────────────────────────────────
let completed = 0;
let failed = 0;

pending.forEach((week, i) => {
  const label = `[${i + 1}/${pending.length}] ${week.start} → ${week.end}`;
  process.stdout.write(`${C.cyan}${label}${C.reset} ... `);

  try {
    execSync(
      `node gather-and-rank.js --start ${week.start} --end ${week.end}`,
      {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10 * 60 * 1000, // 10 min per week
      }
    );
    console.log(`${C.green}done${C.reset}`);
    completed++;
  } catch (err) {
    console.log(`${C.red}failed${C.reset}`);
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    if (stderr) console.log(`  ${C.dim}${stderr.split('\n')[0]}${C.reset}`);
    failed++;
  }
});

console.log(
  `\n${C.green}Weekly gather complete.${C.reset} ${completed} succeeded, ${failed} failed out of ${pending.length} weeks.\n`
);
