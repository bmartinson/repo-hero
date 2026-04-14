const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, '.results_history');
const dryRun = process.argv.includes('--dry');

// ─── Load all result files ──────────────────────────────────────────────────

const files = fs
  .readdirSync(resultsDir)
  .filter(
    (f) =>
      f.endsWith('.json') &&
      f !== 'combined_results.json' &&
      !f.includes('.DS_Store')
  );

if (files.length === 0) {
  console.log('No result files found.');
  process.exit(0);
}

const allEntries = [];

files.forEach((file) => {
  const filePath = path.join(resultsDir, file);
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return; // skip unparseable files
  }

  const key = path.parse(file).name;
  const startDate = entry?._report_info?.start_date || key.split('_')[0];
  const endDate = entry?._report_info?.end_date || key.split('_')[1] || startDate;
  const spanDays =
    (new Date(endDate + 'T00:00:00') - new Date(startDate + 'T00:00:00')) /
    86400000;

  allEntries.push({ file, key, startDate, endDate, spanDays });
});

// ─── Overlap resolution (mirrors results-dashboard.js exactly) ──────────────

function resolveOverlaps(entries) {
  // 1. Drop monthly files when weekly data exists for the same month
  const monthMap = {};

  entries.forEach((e) => {
    const start = new Date(e.startDate + 'T00:00:00');
    const end = new Date(e.endDate + 'T00:00:00');
    let cursor = new Date(start);
    while (cursor <= end) {
      const ym =
        cursor.getFullYear() +
        '-' +
        String(cursor.getMonth() + 1).padStart(2, '0');
      if (!monthMap[ym]) monthMap[ym] = { monthly: [], weekly: [] };
      if (e.spanDays >= 27) {
        if (!monthMap[ym].monthly.includes(e)) monthMap[ym].monthly.push(e);
      } else {
        if (!monthMap[ym].weekly.includes(e)) monthMap[ym].weekly.push(e);
      }
      cursor.setMonth(cursor.getMonth() + 1);
      cursor.setDate(1);
    }
  });

  const dropSet = new Set();
  for (const ym of Object.keys(monthMap)) {
    const { monthly, weekly } = monthMap[ym];
    if (monthly.length > 0 && weekly.length > 0) {
      monthly.forEach((e) => dropSet.add(e));
    }
  }

  let result = entries.filter((e) => !dropSet.has(e));

  // 2. Remove overlapping weekly files (keep earlier start, or longer span)
  result.sort((a, b) => {
    const cmp = a.startDate.localeCompare(b.startDate);
    if (cmp !== 0) return cmp;
    return a.endDate.localeCompare(b.endDate);
  });

  const final = [];
  for (const entry of result) {
    if (final.length > 0) {
      const prev = final[final.length - 1];
      if (entry.startDate <= prev.endDate) {
        if (entry.spanDays > prev.spanDays) {
          final[final.length - 1] = entry;
        }
        continue;
      }
    }
    final.push(entry);
  }

  return final;
}

// ─── Identify orphans ───────────────────────────────────────────────────────

const kept = resolveOverlaps(allEntries);
const keptFiles = new Set(kept.map((e) => e.file));
const orphans = allEntries.filter((e) => !keptFiles.has(e.file));

if (orphans.length === 0) {
  console.log(
    `Cache is clean — all ${allEntries.length} result files are in use.`
  );
  process.exit(0);
}

// Calculate savings
let totalBytes = 0;
orphans.forEach((o) => {
  const stat = fs.statSync(path.join(resultsDir, o.file));
  totalBytes += stat.size;
});

const formatSize = (bytes) => {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
};

console.log(
  `Found ${orphans.length} orphaned file${orphans.length === 1 ? '' : 's'} ` +
    `(${formatSize(totalBytes)}) out of ${allEntries.length} total:`
);
console.log('');

orphans.forEach((o) => {
  const stat = fs.statSync(path.join(resultsDir, o.file));
  const reason =
    o.spanDays >= 27
      ? 'monthly file superseded by weekly data'
      : 'overlapping period (duplicate date range)';
  console.log(`  ${o.file} (${formatSize(stat.size)}) — ${reason}`);
});

if (dryRun) {
  console.log('\n--dry mode: no files deleted.');
} else {
  console.log('');
  orphans.forEach((o) => {
    fs.unlinkSync(path.join(resultsDir, o.file));
  });
  console.log(
    `Deleted ${orphans.length} file${orphans.length === 1 ? '' : 's'}, ` +
      `freed ${formatSize(totalBytes)}.`
  );
  console.log(`Remaining: ${kept.length} result files.`);
}
