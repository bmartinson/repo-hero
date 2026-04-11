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
  let cursor = toDate(start);
  const endD = toDate(end);

  while (cursor <= endD) {
    // Week ends 6 days from cursor, or at the overall end date
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const cappedEnd = weekEnd > endD ? endD : weekEnd;

    weeks.push({ start: toISO(cursor), end: toISO(cappedEnd) });

    // Move cursor to next day after this week
    cursor = new Date(cappedEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return weeks;
}

const weeks = generateWeeks(startDate, endDate);
const resultsDir = path.join(__dirname, '.results_history');

// Check which weeks already have results
const existingFiles = new Set(
  fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'))
    : []
);

const pending = weeks.filter(
  w => !existingFiles.has(`${w.start}_${w.end}.json`)
);

console.log(`\n${C.cyan}Repo Hero — Weekly Gather${C.reset}`);
console.log(
  `${C.dim}Range: ${startDate} → ${endDate}  (${weeks.length} weeks total)${C.reset}`
);
console.log(
  `${C.dim}Already gathered: ${weeks.length - pending.length}  |  Remaining: ${pending.length}${C.reset}\n`
);

if (pending.length === 0) {
  console.log(
    `${C.green}All weeks already gathered. Nothing to do.${C.reset}\n`
  );
  process.exit(0);
}

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
