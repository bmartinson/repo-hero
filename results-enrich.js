/**
 * results-enrich.js
 *
 * Two-pass enrichment of historical results to synthesize predicted pull
 * requests for periods where PR data is missing or sparse.
 *
 * Pass 1 — Learn:
 *   Scans all results files to compute each user's personal commits-per-PR
 *   ratio from months where they have real PR data. Also computes a team-wide
 *   average ratio as a fallback.
 *
 * Pass 2 — Enrich:
 *   For each user in each month: if they have commits but zero PRs, uses
 *   their personal ratio (or the team average if no personal data exists)
 *   to synthesize predictedPullRequests. Recalculates scores using the
 *   shared scoring module.
 *
 * Usage:
 *   node results-enrich.js          # enrich all files
 *   node results-enrich.js --dry    # preview without writing
 */

const fs = require('fs');
const path = require('path');
const { calculateScore } = require('./score');

// ─── Terminal colors ────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
};

// ─── Config ─────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry');
const resultsDir = path.join(__dirname, '.results_history');

const files = fs
  .readdirSync(resultsDir)
  .filter(f => f.endsWith('.json') && f !== 'combined_results.json')
  .sort();

if (files.length === 0) {
  console.log(`${C.yellow}No results files found.${C.reset}`);
  process.exit(0);
}

console.log(`\n${C.cyan}Repo Hero — PR Enrichment${C.reset}`);
if (dryRun) {
  console.log(`${C.yellow}DRY RUN — no files will be modified${C.reset}`);
}

// ─── Pass 1: Learn per-user commits-per-PR ratios ───────────────────────────

console.log(`\n${C.blue}Pass 1:${C.reset} Learning commits-per-PR ratios...`);

// Accumulate totals from months where the user has real PR data
const userStats = {}; // { name: { commits: N, pullRequests: N } }

files.forEach(file => {
  const data = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
  if (!data.users || !Array.isArray(data.users)) return;

  data.users.forEach(user => {
    const prs = user.pullRequests || 0;
    const commits = user.commits || 0;

    if (prs > 0 && commits > 0) {
      if (!userStats[user.name]) {
        userStats[user.name] = { commits: 0, pullRequests: 0 };
      }
      userStats[user.name].commits += commits;
      userStats[user.name].pullRequests += prs;
    }
  });
});

// Compute per-user ratios
const userRatios = {}; // { name: commitsPerPR }
let teamTotalCommits = 0;
let teamTotalPRs = 0;

Object.entries(userStats).forEach(([name, stats]) => {
  userRatios[name] = stats.commits / stats.pullRequests;
  teamTotalCommits += stats.commits;
  teamTotalPRs += stats.pullRequests;
});

const teamAvgRatio = teamTotalPRs > 0 ? teamTotalCommits / teamTotalPRs : 0;

// Report findings
const usersWithRatio = Object.keys(userRatios).length;
console.log(
  `  ${C.dim}${usersWithRatio} users with PR history, team avg ratio: ${teamAvgRatio.toFixed(1)} commits/PR${C.reset}`
);

// Show top ratios for context
const sortedRatios = Object.entries(userRatios)
  .sort((a, b) => a[1] - b[1])
  .slice(0, 5);
sortedRatios.forEach(([name, ratio]) => {
  const display = name
    .split(' ')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  console.log(
    `  ${C.dim}  ${display}: ${ratio.toFixed(1)} commits/PR${C.reset}`
  );
});

// ─── Pass 2: Enrich with predicted PRs ──────────────────────────────────────

console.log(
  `\n${C.blue}Pass 2:${C.reset} Enriching results with predicted PRs...\n`
);

let totalPredictions = 0;
let totalRecalculated = 0;
let filesModified = 0;

files.forEach(file => {
  const filePath = path.join(resultsDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (!data.users || !Array.isArray(data.users)) {
    console.log(`${C.gray}  SKIP  ${file} (no users array)${C.reset}`);
    return;
  }

  let filePredictions = 0;
  let fileRecalculated = 0;

  data.users.forEach(user => {
    const prs = user.pullRequests || 0;
    const commits = user.commits || 0;
    const oldScore = user.score || 0;

    if (prs === 0 && commits > 0) {
      // No real PR data — synthesize predicted PRs
      const ratio = userRatios[user.name] || teamAvgRatio;

      if (ratio > 0) {
        user.predictedPullRequests = parseFloat((commits / ratio).toFixed(2));
        filePredictions++;
      }
    } else {
      // Has real PR data — clear any stale prediction
      if (user.predictedPullRequests !== undefined) {
        delete user.predictedPullRequests;
      }
    }

    // Recalculate score using shared scoring
    const newScore = calculateScore(user);
    if (Math.abs(newScore - oldScore) > 0.001) {
      fileRecalculated++;
    }
    user.score = newScore;
  });

  // Re-sort by score
  data.users.sort((a, b) => b.score - a.score);

  // Recalculate team stats
  let activeUsers = 0;
  let teamScoreSum = 0;

  data.users.forEach(user => {
    if (user.score > 0) {
      activeUsers++;
      teamScoreSum += user.score;
    }
  });

  data.activeUsers = activeUsers;
  data.teamScore = activeUsers > 0 ? teamScoreSum / activeUsers : 0;

  totalPredictions += filePredictions;
  totalRecalculated += fileRecalculated;

  const hasChanges = filePredictions > 0 || fileRecalculated > 0;

  if (hasChanges) {
    filesModified++;
    const parts = [];
    if (filePredictions > 0) parts.push(`${filePredictions} predicted`);
    if (fileRecalculated > 0) parts.push(`${fileRecalculated} rescored`);
    console.log(
      `  ${C.green}UPDATE${C.reset}  ${file}  ${C.dim}(${parts.join(', ')})${C.reset}`
    );
  } else {
    console.log(`  ${C.gray}  OK    ${file}${C.reset}`);
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(
  `\n${C.cyan}Done.${C.reset} ${files.length} files scanned, ${filesModified} modified`
);
console.log(
  `  ${C.dim}${totalPredictions} PR predictions synthesized, ${totalRecalculated} scores recalculated${C.reset}`
);

if (teamAvgRatio > 0) {
  console.log(
    `  ${C.dim}Team avg: ${teamAvgRatio.toFixed(1)} commits/PR (used as fallback for users with no PR history)${C.reset}\n`
  );
}
