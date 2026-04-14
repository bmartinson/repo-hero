const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, '.results_history');
const cacheDir = path.join(__dirname, '.results_cache');
const dryRun = process.argv.includes('--dry');

const formatSize = (bytes) => {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
};

let totalFreed = 0;
let totalDeleted = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Results history — prune overlapping period files
// ═══════════════════════════════════════════════════════════════════════════════

console.log('━'.repeat(60));
console.log('  RESULTS HISTORY (.results_history/)');
console.log('━'.repeat(60));

const historyFiles = fs.existsSync(resultsDir)
  ? fs
      .readdirSync(resultsDir)
      .filter(
        (f) =>
          f.endsWith('.json') &&
          f !== 'combined_results.json' &&
          !f.includes('.DS_Store')
      )
  : [];

if (historyFiles.length === 0) {
  console.log('  No result files found.\n');
} else {
  const allEntries = [];

  historyFiles.forEach((file) => {
    const filePath = path.join(resultsDir, file);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return;
    }

    const key = path.parse(file).name;
    const startDate = entry?._report_info?.start_date || key.split('_')[0];
    const endDate =
      entry?._report_info?.end_date || key.split('_')[1] || startDate;
    const spanDays =
      (new Date(endDate + 'T00:00:00') - new Date(startDate + 'T00:00:00')) /
      86400000;

    allEntries.push({ file, key, startDate, endDate, spanDays });
  });

  // Overlap resolution (mirrors results-dashboard.js exactly)
  function resolveOverlaps(entries) {
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

  const kept = resolveOverlaps(allEntries);
  const keptFiles = new Set(kept.map((e) => e.file));
  const orphans = allEntries.filter((e) => !keptFiles.has(e.file));

  if (orphans.length === 0) {
    console.log(
      `  Clean — all ${allEntries.length} result files are in use.\n`
    );
  } else {
    let orphanBytes = 0;
    orphans.forEach((o) => {
      const stat = fs.statSync(path.join(resultsDir, o.file));
      orphanBytes += stat.size;
    });

    console.log(
      `  Found ${orphans.length} orphaned file${orphans.length === 1 ? '' : 's'} (${formatSize(orphanBytes)}):`
    );
    orphans.forEach((o) => {
      const reason =
        o.spanDays >= 27
          ? 'monthly superseded by weekly'
          : 'overlapping duplicate';
      console.log(`    ${o.file} — ${reason}`);
    });

    if (!dryRun) {
      orphans.forEach((o) => fs.unlinkSync(path.join(resultsDir, o.file)));
      totalFreed += orphanBytes;
      totalDeleted += orphans.length;
      console.log(
        `  Deleted ${orphans.length} file${orphans.length === 1 ? '' : 's'}, freed ${formatSize(orphanBytes)}.`
      );
    }
    console.log('');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. API response cache — prune stale entries where a newer response exists
// ═══════════════════════════════════════════════════════════════════════════════

console.log('━'.repeat(60));
console.log('  API RESPONSE CACHE (.results_cache/)');
console.log('━'.repeat(60));

if (!fs.existsSync(cacheDir)) {
  console.log('  No cache directory found.\n');
} else {
  const cacheFiles = fs
    .readdirSync(cacheDir)
    .filter((f) => f.endsWith('.json'))
    .sort(); // Alphabetical = chronological (timestamp in filename)

  if (cacheFiles.length === 0) {
    console.log('  No cache files found.\n');
  } else {
    console.log(`  Scanning ${cacheFiles.length.toLocaleString()} cache files...`);

    // For each API request key, track only the latest file that provides it.
    // Files are sorted chronologically, so the last writer wins (same as
    // the cache load in gather-and-rank.js).
    const keyToLatestFile = {}; // apiKey -> filename

    cacheFiles.forEach((file) => {
      try {
        const filePath = path.join(cacheDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        Object.keys(data).forEach((apiKey) => {
          keyToLatestFile[apiKey] = file;
        });
      } catch {
        // Unparseable files are orphans by definition
      }
    });

    const keeperFiles = new Set(Object.values(keyToLatestFile));
    const cacheOrphans = cacheFiles.filter((f) => !keeperFiles.has(f));

    const uniqueKeys = Object.keys(keyToLatestFile).length;

    if (cacheOrphans.length === 0) {
      console.log(
        `  Clean — all ${cacheFiles.length.toLocaleString()} files provide the latest response ` +
          `for ${uniqueKeys.toLocaleString()} unique API keys.\n`
      );
    } else {
      let orphanBytes = 0;
      cacheOrphans.forEach((f) => {
        try {
          orphanBytes += fs.statSync(path.join(cacheDir, f)).size;
        } catch {}
      });

      console.log(
        `  ${uniqueKeys.toLocaleString()} unique API keys across ${cacheFiles.length.toLocaleString()} files`
      );
      console.log(
        `  ${cacheOrphans.length.toLocaleString()} orphaned files (${formatSize(orphanBytes)}) ` +
          `— superseded by newer responses`
      );
      console.log(
        `  ${keeperFiles.size.toLocaleString()} files to keep`
      );

      if (!dryRun) {
        let deleted = 0;
        cacheOrphans.forEach((f) => {
          try {
            fs.unlinkSync(path.join(cacheDir, f));
            deleted++;
          } catch {}
        });
        totalFreed += orphanBytes;
        totalDeleted += deleted;
        console.log(
          `  Deleted ${deleted.toLocaleString()} files, freed ${formatSize(orphanBytes)}.`
        );
      }
      console.log('');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log('━'.repeat(60));
if (dryRun) {
  console.log('  --dry mode: no files were deleted.');
} else if (totalDeleted > 0) {
  console.log(
    `  Total: deleted ${totalDeleted.toLocaleString()} files, freed ${formatSize(totalFreed)}.`
  );
} else {
  console.log('  Everything is clean — nothing to remove.');
}
console.log('━'.repeat(60));
