/**
 * results-reindexer.js
 *
 * Re-indexes all historical results JSON files in .results_history/ to
 * accommodate changes to alias definitions and ignoreUsers in config.json.
 *
 * For each results file this script will:
 *   1. Re-map user names using the current alias configuration
 *   2. Merge users that now resolve to the same alias (summing metrics)
 *   3. Re-calculate scores using the original commitsPerPullRequest ratio
 *   4. Remove ignored users
 *   5. Re-sort by score descending
 *   6. Re-calculate teamScore and activeUsers
 *   7. Write the updated file back to disk
 *
 * Usage:
 *   node results-reindexer.js          # re-index all files
 *   node results-reindexer.js --dry    # preview changes without writing
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
};

// ─── Config ─────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry');
const configPath = path.join(__dirname, 'config.json');
const resultsDir = path.join(__dirname, '.results_history');

if (!fs.existsSync(configPath)) {
  console.error(`${C.red}config.json not found.${C.reset}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ─── Build reverse alias map ────────────────────────────────────────────────

function removeEmailAccount(input) {
  return input.replace(/<[^>]+>/, '').trim();
}

const aliasMap = {};

if (config.aliases) {
  Object.keys(config.aliases).forEach(canonical => {
    const values = config.aliases[canonical];
    if (values && values.length > 0) {
      values.forEach(value => {
        const key = removeEmailAccount(value.toLowerCase()).trim();
        aliasMap[key] = removeEmailAccount(canonical.toLowerCase()).trim();
      });
    }
  });
}

function getAliasForUser(user) {
  if (!user) return '';
  user = removeEmailAccount(user.toLowerCase()).trim();
  return aliasMap[user] || user;
}

const ignoreUsers = (config.ignoreUsers || []).map(u => u.toLowerCase());

// ─── Process files ──────────────────────────────────────────────────────────

const files = fs
  .readdirSync(resultsDir)
  .filter(f => f.endsWith('.json') && f !== 'combined_results.json')
  .sort();

if (files.length === 0) {
  console.log(
    `${C.yellow}No results files found in .results_history/${C.reset}`
  );
  process.exit(0);
}

console.log(`\n${C.cyan}Repo Hero — Results Re-indexer${C.reset}`);
console.log(
  `${C.dim}Applying ${Object.keys(aliasMap).length} alias mappings, ${ignoreUsers.length} ignored users${C.reset}`
);

if (dryRun) {
  console.log(`${C.yellow}DRY RUN — no files will be modified${C.reset}`);
}

console.log('');

let totalMerges = 0;
let totalRenames = 0;
let totalIgnored = 0;
let filesModified = 0;

files.forEach(file => {
  const filePath = path.join(resultsDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (!data.users || !Array.isArray(data.users)) {
    console.log(`${C.gray}  SKIP  ${file} (no users array)${C.reset}`);
    return;
  }

  let fileMerges = 0;
  let fileRenames = 0;
  let fileIgnored = 0;

  // Step 1: Re-map user names and merge duplicates
  const merged = {};

  data.users.forEach(user => {
    const oldName = user.name;
    const newName = getAliasForUser(oldName);

    if (oldName !== newName) {
      fileRenames++;
    }

    if (!merged[newName]) {
      merged[newName] = {
        name: newName,
        commits: 0,
        pullRequests: 0,
        pendingCommits: 0,
        loc: 0,
        filesTouched: 0,
        reviews: 0,
        score: 0,
      };
    } else if (oldName !== newName || merged[newName]._seen) {
      fileMerges++;
    }

    merged[newName]._seen = true;
    merged[newName].commits += user.commits || 0;
    merged[newName].pullRequests += user.pullRequests || 0;
    merged[newName].pendingCommits += user.pendingCommits || 0;
    merged[newName].loc += user.loc || 0;
    merged[newName].filesTouched += user.filesTouched || 0;
    merged[newName].reviews += user.reviews || 0;
  });

  // Step 2: Re-calculate scores
  Object.values(merged).forEach(user => {
    delete user._seen;
    user.score = calculateScore(user);
  });

  // Step 3: Sort by score descending
  let usersArray = Object.values(merged);
  usersArray.sort((a, b) => b.score - a.score);

  // Step 4: Remove ignored users and recalculate team stats
  let activeUsers = 0;
  let teamScoreSum = 0;

  usersArray.forEach(user => {
    if (user.score > 0) {
      activeUsers++;
      teamScoreSum += user.score;
    }
  });

  // Remove ignored users
  usersArray = usersArray.filter(user => {
    const isIgnored = ignoreUsers.includes(user.name);
    if (isIgnored) {
      fileIgnored++;
      if (user.score > 0) {
        activeUsers--;
      }
    }
    return !isIgnored;
  });

  // Step 5: Update team-level fields
  data.users = usersArray;
  data.activeUsers = activeUsers;
  data.teamScore = activeUsers > 0 ? teamScoreSum / activeUsers : 0;

  // Track totals
  totalMerges += fileMerges;
  totalRenames += fileRenames;
  totalIgnored += fileIgnored;

  const hasChanges = fileRenames > 0 || fileMerges > 0 || fileIgnored > 0;

  if (hasChanges) {
    filesModified++;
    const parts = [];
    if (fileRenames > 0) parts.push(`${fileRenames} renamed`);
    if (fileMerges > 0) parts.push(`${fileMerges} merged`);
    if (fileIgnored > 0) parts.push(`${fileIgnored} ignored`);
    console.log(
      `  ${C.green}UPDATE${C.reset}  ${file}  ${C.dim}(${parts.join(', ')})${C.reset}`
    );
  } else {
    console.log(`  ${C.gray}  OK    ${file}${C.reset}`);
  }

  // Step 6: Write back
  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(
  `\n${C.cyan}Done.${C.reset} ${files.length} files scanned, ${filesModified} modified`
);
console.log(
  `  ${C.dim}${totalRenames} user renames, ${totalMerges} user merges, ${totalIgnored} users ignored${C.reset}\n`
);
