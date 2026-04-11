const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const resultsDir = path.join(__dirname, '.results_history');
const inputFile = path.join(resultsDir, 'combined_results.json');
const outputFile = path.join(resultsDir, 'dashboard.html');
const logoFile = path.join(__dirname, 'assets', 'logo.svg');

// ─── Read & process data ────────────────────────────────────────────────────

if (!fs.existsSync(inputFile)) {
  console.error(
    'combined_results.json not found. Run "npm run combine" first.'
  );
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// Build a structured payload for the dashboard
const keys = Object.keys(raw)
  .filter(k => k !== 'combined_results')
  .sort();

const dashboardData = {
  periods: [],
  users: {},
  team: [],
};

// First pass: collect all periods with their date ranges
const allEntries = [];
keys.forEach(key => {
  const entry = raw[key];
  if (!entry || !entry.users) return;

  const startDate = entry?._report_info?.start_date || key.split('_')[0];
  const endDate =
    entry?._report_info?.end_date || key.split('_')[1] || startDate;
  const spanDays =
    (new Date(endDate + 'T00:00:00') - new Date(startDate + 'T00:00:00')) /
    86400000;

  allEntries.push({ key, entry, startDate, endDate, spanDays });
});

// ─── Overlap resolution ─────────────────────────────────────────────────────
// Strategy: for any month where both monthly (>= 28 days) and weekly (< 14 days)
// files exist, drop the monthly file. This prevents double-counting.
// Then resolve any remaining partial overlaps between weekly files by keeping
// the one that starts earlier (stable boundaries from a consistent run).

function resolveOverlaps(entries) {
  // 1. Find months that have both monthly and weekly data
  const monthMap = {}; // "YYYY-MM" -> { monthly: [], weekly: [] }

  entries.forEach(e => {
    // All months this entry touches
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

  // Collect monthly entries to drop
  const dropSet = new Set();
  for (const ym of Object.keys(monthMap)) {
    const { monthly, weekly } = monthMap[ym];
    if (monthly.length > 0 && weekly.length > 0) {
      monthly.forEach(e => dropSet.add(e));
    }
  }

  let result = entries.filter(e => !dropSet.has(e));

  // 2. Remove remaining partial overlaps between weekly files.
  // Sort by startDate, then by endDate. For overlapping pairs, keep the earlier one.
  result.sort((a, b) => {
    const cmp = a.startDate.localeCompare(b.startDate);
    if (cmp !== 0) return cmp;
    return a.endDate.localeCompare(b.endDate);
  });

  const final = [];
  for (const entry of result) {
    // Check if this entry overlaps with the last kept entry
    if (final.length > 0) {
      const prev = final[final.length - 1];
      if (entry.startDate <= prev.endDate) {
        // Overlap — keep the longer one (it covers more), or the earlier one if same span
        if (entry.spanDays > prev.spanDays) {
          final[final.length - 1] = entry;
        }
        // Otherwise skip this entry (keep prev)
        continue;
      }
    }
    final.push(entry);
  }

  return final;
}

const filteredEntries = resolveOverlaps(allEntries);

filteredEntries.forEach(({ entry, startDate, endDate }) => {
  // Use start_end as unique period ID
  const periodId = startDate + '_' + endDate;

  dashboardData.periods.push({
    id: periodId,
    startDate,
    endDate,
  });

  dashboardData.team.push({
    periodId,
    startDate,
    endDate,
    teamScore: entry.teamScore || 0,
    activeUsers: entry.activeUsers || 0,
    totalPullRequests: entry.totalPullRequests || 0,
    totalCommits: entry.totalCommits || 0,
    predictedPullRequests: entry.predictedPullRequests || 0,
  });

  entry.users.forEach(user => {
    const name = user.name;
    if (!dashboardData.users[name]) {
      dashboardData.users[name] = { name, data: {} };
    }
    dashboardData.users[name].data[periodId] = {
      score: user.score || 0,
      commits: user.commits || 0,
      pullRequests: user.pullRequests || 0,
      predictedPullRequests: user.predictedPullRequests || 0,
      reviews: user.reviews || 0,
      loc: user.loc || 0,
      filesTouched: user.filesTouched || 0,
    };
  });
});

// Deduplicate periods by ID and sort by startDate
const seen = new Set();
dashboardData.periods = dashboardData.periods
  .filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  })
  .sort((a, b) => a.startDate.localeCompare(b.startDate));

// ─── Build HTML ─────────────────────────────────────────────────────────────

const logoSvg = fs.existsSync(logoFile)
  ? fs.readFileSync(logoFile, 'utf8')
  : '';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Repo Hero — Dashboard</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logoSvg)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
/* ─── Repo Hero Dashboard — Terminal Theme ───────────────────────────────── */

:root {
  --bg: #0a0a0a;
  --bg-card: #111111;
  --bg-card-hover: #1a1a1a;
  --fg: #c8c8c8;
  --fg-dim: #555555;
  --fg-bright: #ffffff;
  --fg-muted: #777777;
  --fg-error: #ff3333;
  --fg-warn: #ffaa00;
  --fg-success: #22cc44;
  --fg-info: #00aaff;
  --fg-cyan: #00ddcc;
  --fg-magenta: #cc66ff;
  --fg-orange: #ff8844;
  --border: #2a2a2a;
  --border-focus: #444444;
  --font: 'IBM Plex Mono', 'Courier New', 'Consolas', monospace;
  --radius: 4px;
  --glow-cyan: 0 0 8px rgba(0, 221, 204, 0.3);
  --glow-info: 0 0 8px rgba(0, 170, 255, 0.3);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.6;
  min-height: 100vh;
}

#app {
  max-width: 1440px;
  margin: 0 auto;
  padding: 20px 24px 60px;
}

/* ─── Header ─────────────────────────────────────────────────────────────── */

header {
  margin-bottom: 8px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.logo-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.logo-icon {
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  filter: drop-shadow(0 0 6px rgba(0, 221, 204, 0.35));
}

.logo-icon svg {
  width: 100%;
  height: 100%;
}

.logo {
  font-size: 48px;
  font-weight: 700;
  color: var(--fg-bright);
  letter-spacing: 6px;
  line-height: 1;
  text-transform: uppercase;
}

.logo .accent { color: var(--fg-cyan); }

.subtitle {
  color: var(--fg-dim);
  font-size: 12px;
  letter-spacing: 1px;
}

/* ─── Nav / Tab Bar ──────────────────────────────────────────────────────── */

.nav-bar {
  display: flex;
  align-items: center;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}

.nav-btn {
  background: transparent;
  color: var(--fg-dim);
  border: none;
  border-bottom: 2px solid transparent;
  padding: 10px 20px;
  font-family: var(--font);
  font-size: 12px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  transition: color 0.2s, border-color 0.2s;
}

.nav-btn:hover { color: var(--fg); border-bottom-color: var(--fg-dim); }
.nav-btn.active { color: var(--fg-bright); border-bottom-color: var(--fg-info); }

/* ─── Filter Bar ─────────────────────────────────────────────────────────── */

.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  font-size: 12px;
}

.filter-bar .label {
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-right: 4px;
}

.scope-btn {
  background: transparent;
  color: var(--fg-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px 14px;
  font-family: var(--font);
  font-size: 12px;
  cursor: pointer;
  letter-spacing: 1px;
  transition: all 0.15s;
}

.scope-btn:hover { color: var(--fg); border-color: var(--fg-dim); }
.scope-btn.active {
  color: var(--fg-bright);
  border-color: var(--fg-info);
  background: rgba(0, 170, 255, 0.08);
  box-shadow: var(--glow-info);
}

/* ─── Summary Cards ──────────────────────────────────────────────────────── */

.summary-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}

.summary-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
}

.summary-card .card-label {
  color: var(--fg-dim);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 6px;
}

.summary-card .card-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--fg-bright);
  line-height: 1.1;
}

.summary-card .card-delta {
  font-size: 11px;
  margin-top: 4px;
}

.delta-up { color: var(--fg-success); }
.delta-down { color: var(--fg-error); }
.delta-flat { color: var(--fg-dim); }

/* ─── Widget Grid ────────────────────────────────────────────────────────── */

.widget-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 16px;
  margin-bottom: 32px;
}

.widget {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px;
  display: flex;
  flex-direction: column;
}

.widget-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.widget-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 1.5px;
}

.widget-body {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.widget-chart {
  flex: 1;
  min-width: 0;
  position: relative;
}

.widget-chart canvas {
  width: 100% !important;
  height: 220px !important;
}

.widget-leaderboard {
  width: 180px;
  flex-shrink: 0;
}

.lb-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.15s;
  border-radius: 2px;
}

.lb-item:hover { background: var(--bg-card-hover); }

.lb-rank {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.lb-rank.gold { background: rgba(255, 170, 0, 0.15); color: var(--fg-warn); }
.lb-rank.silver { background: rgba(200, 200, 200, 0.1); color: #ccc; }
.lb-rank.bronze { background: rgba(205, 127, 50, 0.12); color: #cd7f32; }
.lb-rank.other { background: rgba(85, 85, 85, 0.15); color: var(--fg-dim); }

.lb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg);
}

.lb-value {
  font-size: 11px;
  color: var(--fg-dim);
  font-weight: 500;
}

/* ─── Users Tab ──────────────────────────────────────────────────────────── */

.users-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.user-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.user-card:hover {
  border-color: var(--fg-info);
  box-shadow: var(--glow-info);
}

.user-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.user-card-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--fg-bright);
  text-transform: capitalize;
}

.user-card-rank {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 10px;
  font-weight: 500;
}

.user-card-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.user-stat {
  text-align: center;
}

.user-stat .stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--fg-bright);
  white-space: nowrap;
}

.fire-badge {
  display: inline;
  font-size: 0.75em;
  margin-left: 1px;
  filter: drop-shadow(0 0 4px rgba(255, 100, 0, 0.6));
  cursor: help;
  vertical-align: baseline;
}

.user-stat .stat-label {
  font-size: 9px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* ─── User Profile Overlay ───────────────────────────────────────────────── */

.overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 1000;
  overflow-y: auto;
  backdrop-filter: blur(4px);
}

.overlay.visible { display: flex; justify-content: center; padding: 40px 20px; }

.profile-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-width: 900px;
  width: 100%;
  padding: 32px;
  position: relative;
}

.profile-close {
  position: absolute;
  top: 16px;
  right: 20px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  font-family: var(--font);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
  border-radius: var(--radius);
  transition: color 0.15s, border-color 0.15s;
}

.profile-close:hover { color: var(--fg-bright); border-color: var(--fg-dim); }

.profile-name {
  font-size: 28px;
  font-weight: 700;
  color: var(--fg-bright);
  text-transform: capitalize;
  margin-bottom: 4px;
}

.profile-subtitle {
  color: var(--fg-dim);
  font-size: 12px;
  margin-bottom: 24px;
}

.profile-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 28px;
}

.profile-stat {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  text-align: center;
}

.profile-stat .pstat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--fg-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.profile-stat .pstat-label {
  font-size: 9px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-top: 2px;
}

.profile-charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 16px;
}

.profile-chart-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.profile-chart-box .pchart-title {
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 10px;
}

.profile-chart-box canvas {
  width: 100% !important;
  height: 180px !important;
}

/* ─── Scan-line overlay (subtle CRT effect) ──────────────────────────────── */

body::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.03) 2px,
    rgba(0, 0, 0, 0.03) 4px
  );
}

/* ─── Scrollbar ──────────────────────────────────────────────────────────── */

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--fg-dim); }

/* ─── Responsive ─────────────────────────────────────────────────────────── */

@media (max-width: 900px) {
  .widget-grid { grid-template-columns: 1fr; }
  .widget-body { flex-direction: column; }
  .widget-leaderboard { width: 100%; }
  .widget-chart canvas { height: 180px !important; }
}

/* ─── Users Sort Bar ─────────────────────────────────────────────────────── */

.users-sort-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 12px;
}

.sort-btn {
  background: transparent;
  color: var(--fg-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 12px;
  font-family: var(--font);
  font-size: 11px;
  cursor: pointer;
  letter-spacing: 0.5px;
  transition: all 0.15s;
}

.sort-btn:hover { color: var(--fg); border-color: var(--fg-dim); }
.sort-btn.active {
  color: var(--fg-bright);
  border-color: var(--fg-cyan);
  background: rgba(0, 221, 204, 0.06);
}

/* ─── Tab panels ─────────────────────────────────────────────────────────── */

.tab-panel { display: none; }
.tab-panel.active { display: block; }

</style>
</head>
<body>
<div id="app">

  <!-- Header -->
  <header>
    <div>
      <div class="logo-row">
        <div class="logo-icon">${logoSvg}</div>
        <div class="logo">Repo <span class="accent">Hero</span></div>
      </div>
      <div class="subtitle" id="data-range"></div>
    </div>
  </header>

  <!-- Navigation -->
  <nav class="nav-bar">
    <button class="nav-btn active" data-tab="dashboard" onclick="switchTab('dashboard')">DASHBOARD</button>
    <button class="nav-btn" data-tab="users" onclick="switchTab('users')">USERS</button>
  </nav>

  <!-- ═══ Dashboard Tab ═══ -->
  <div class="tab-panel active" id="tab-dashboard">

    <!-- Filter bar -->
    <div class="filter-bar">
      <span class="label">Scope:</span>
      <button class="scope-btn" data-scope="7" onclick="setScope(7)">1W</button>
      <button class="scope-btn" data-scope="14" onclick="setScope(14)">2W</button>
      <button class="scope-btn" data-scope="21" onclick="setScope(21)">3W</button>
      <button class="scope-btn active" data-scope="30" onclick="setScope(30)">1M</button>
      <button class="scope-btn" data-scope="60" onclick="setScope(60)">2M</button>
      <button class="scope-btn" data-scope="90" onclick="setScope(90)">3M</button>
      <button class="scope-btn" data-scope="180" onclick="setScope(180)">6M</button>
      <button class="scope-btn" data-scope="365" onclick="setScope(365)">1Y</button>
      <button class="scope-btn" data-scope="0" onclick="setScope(0)">All</button>
    </div>

    <!-- Summary cards -->
    <div class="summary-row" id="summary-row"></div>

    <!-- Trend widgets -->
    <div class="widget-grid" id="widget-grid"></div>
  </div>

  <!-- ═══ Users Tab ═══ -->
  <div class="tab-panel" id="tab-users">
    <div class="filter-bar">
      <span class="label">Scope:</span>
      <button class="scope-btn users-scope-btn" data-scope="7" onclick="setScope(7)">1W</button>
      <button class="scope-btn users-scope-btn" data-scope="14" onclick="setScope(14)">2W</button>
      <button class="scope-btn users-scope-btn" data-scope="21" onclick="setScope(21)">3W</button>
      <button class="scope-btn users-scope-btn active" data-scope="30" onclick="setScope(30)">1M</button>
      <button class="scope-btn users-scope-btn" data-scope="60" onclick="setScope(60)">2M</button>
      <button class="scope-btn users-scope-btn" data-scope="90" onclick="setScope(90)">3M</button>
      <button class="scope-btn users-scope-btn" data-scope="180" onclick="setScope(180)">6M</button>
      <button class="scope-btn users-scope-btn" data-scope="365" onclick="setScope(365)">1Y</button>
      <button class="scope-btn users-scope-btn" data-scope="0" onclick="setScope(0)">All</button>
    </div>
    <div class="users-sort-bar">
      <span class="label">Sort by:</span>
      <button class="sort-btn active" data-sort="score" onclick="setUserSort('score')">Score</button>
      <button class="sort-btn" data-sort="commits" onclick="setUserSort('commits')">Commits</button>
      <button class="sort-btn" data-sort="pullRequests" onclick="setUserSort('pullRequests')">PRs</button>
      <button class="sort-btn" data-sort="reviews" onclick="setUserSort('reviews')">Reviews</button>
      <button class="sort-btn" data-sort="loc" onclick="setUserSort('loc')">LOC</button>
      <button class="sort-btn" data-sort="filesTouched" onclick="setUserSort('filesTouched')">Files</button>
    </div>
    <div class="users-grid" id="users-grid"></div>
  </div>
</div>

<!-- User Profile Overlay -->
<div class="overlay" id="profile-overlay" onclick="if(event.target===this)closeProfile()">
  <div class="profile-panel" id="profile-panel"></div>
</div>

<script>
// ─── Data ───────────────────────────────────────────────────────────────────
window.__REPO_HERO_DATA__ = ${JSON.stringify(dashboardData)};

(function() {
  'use strict';

  const DATA = window.__REPO_HERO_DATA__;
  const ALL_PERIODS = DATA.periods; // [{id, startDate, endDate}, ...]
  const ALL_PERIOD_IDS = ALL_PERIODS.map(p => p.id);
  const METRICS = [
    { key: 'score',        label: 'Score',         color: '#00ddcc', format: v => v.toFixed(0) },
    { key: 'effectivePRs', label: 'Pull Requests',  color: '#00aaff', format: v => v.toFixed(0), dataKey: 'effectivePR' },
    { key: 'reviews',      label: 'Reviews',        color: '#cc66ff', format: v => v.toFixed(0) },
    { key: 'commits',      label: 'Commits',        color: '#22cc44', format: v => v.toFixed(0) },
    { key: 'loc',          label: 'Lines of Code',  color: '#ff8844', format: v => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0) },
    { key: 'filesTouched', label: 'Files Touched',  color: '#ffaa00', format: v => v.toFixed(0) },
  ];

  const CHART_COLORS = ['#00ddcc','#00aaff','#cc66ff','#22cc44','#ff8844','#ffaa00','#ff3333','#88ff88','#ff66aa','#aaddff'];

  let currentScope = 30; // days (0 = all)
  let currentSort = 'score';
  let charts = {};
  let profileCharts = {};

  // ─── Helpers ────────────────────────────────────────────────────────────

  function parseDate(str) { return new Date(str + 'T00:00:00'); }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

  function getScopedPeriods() {
    if (ALL_PERIODS.length === 0) return [];
    if (currentScope === 0) return ALL_PERIOD_IDS; // All time

    const latest = parseDate(ALL_PERIODS[ALL_PERIODS.length - 1].endDate);
    const cutoff = new Date(latest);
    cutoff.setDate(cutoff.getDate() - currentScope);

    return ALL_PERIODS
      .filter(p => parseDate(p.startDate) >= cutoff)
      .map(p => p.id);
  }

  function formatPeriodLabel(periodId) {
    const p = ALL_PERIODS.find(x => x.id === periodId);
    if (!p) return periodId;
    const s = parseDate(p.startDate);
    const e = parseDate(p.endDate);
    const span = daysBetween(s, e);
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (span <= 7) {
      // Weekly: "Apr 1"
      return mo[s.getMonth()] + ' ' + s.getDate();
    } else if (span <= 31) {
      // Monthly: "Jan '24"
      return mo[s.getMonth()] + " '" + String(s.getFullYear()).slice(2);
    } else {
      // Yearly or custom: "2024"
      return String(s.getFullYear());
    }
  }

  function getUserTotals(userName, periods) {
    const ud = DATA.users[userName];
    if (!ud) return { score:0, commits:0, pullRequests:0, predictedPullRequests:0, effectivePRs:0, reviews:0, loc:0, filesTouched:0 };
    const totals = { score:0, commits:0, pullRequests:0, predictedPullRequests:0, effectivePRs:0, reviews:0, loc:0, filesTouched:0 };
    periods.forEach(p => {
      const d = ud.data[p];
      if (d) {
        totals.score += d.score;
        totals.commits += d.commits;
        totals.pullRequests += d.pullRequests;
        totals.predictedPullRequests += d.predictedPullRequests || 0;
        totals.effectivePRs += d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
        totals.reviews += d.reviews;
        totals.loc += d.loc;
        totals.filesTouched += d.filesTouched;
      }
    });
    return totals;
  }

  function getTopUsers(metricKey, periods, limit) {
    const userNames = Object.keys(DATA.users);
    const scored = userNames.map(name => {
      const totals = getUserTotals(name, periods);
      return { name, value: totals[metricKey] };
    });
    scored.sort((a, b) => b.value - a.value);
    return scored.filter(u => u.value > 0).slice(0, limit);
  }

  // Compute positive outliers: users > mean + 1.5*stdDev for each metric
  function computeOutliers(periods) {
    const userNames = Object.keys(DATA.users);
    const allTotals = userNames.map(name => ({ name, totals: getUserTotals(name, periods) }));
    const active = allTotals.filter(u => u.totals.score > 0);
    if (active.length < 3) return {};

    const outliers = {};
    const metricKeys = METRICS.map(m => m.key);

    metricKeys.forEach(key => {
      const values = active.map(u => u.totals[key]);
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev === 0) return;

      const threshold = mean + 1.5 * stdDev;
      active.forEach(u => {
        if (u.totals[key] >= threshold) {
          if (!outliers[u.name]) outliers[u.name] = {};
          outliers[u.name][key] = { value: u.totals[key], mean, stdDev, zScore: ((u.totals[key] - mean) / stdDev).toFixed(1) };
        }
      });
    });

    return outliers;
  }

  function getTeamSummary(periods) {
    const filtered = DATA.team.filter(t => periods.includes(t.periodId));
    if (filtered.length === 0) return { teamScore:0, activeUsers:0, totalPullRequests:0, totalCommits:0 };
    const avg = (key) => filtered.reduce((s,t) => s + t[key], 0) / filtered.length;

    // Count unique users who had any activity across all scoped periods
    const activeSet = new Set();
    Object.keys(DATA.users).forEach(name => {
      const ud = DATA.users[name];
      for (const pid of periods) {
        const d = ud.data[pid];
        if (d && (d.commits > 0 || d.pullRequests > 0 || d.reviews > 0)) {
          activeSet.add(name);
          break;
        }
      }
    });

    return {
      teamScore: avg('teamScore'),
      activeUsers: activeSet.size,
      totalPullRequests: filtered.reduce((s,t) => s + t.totalPullRequests, 0),
      totalCommits: filtered.reduce((s,t) => s + t.totalCommits, 0),
    };
  }

  function getDelta(current, previous) {
    if (previous === 0) return { pct: 0, cls: 'delta-flat', text: '—' };
    const pct = ((current - previous) / previous) * 100;
    if (Math.abs(pct) < 0.5) return { pct: 0, cls: 'delta-flat', text: '—' };
    return {
      pct,
      cls: pct > 0 ? 'delta-up' : 'delta-down',
      text: (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(1) + '% vs prev period'
    };
  }

  function formatNum(v) {
    if (v >= 1000000) return (v/1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v/1000).toFixed(1) + 'k';
    return typeof v === 'number' ? (Number.isInteger(v) ? v.toString() : v.toFixed(1)) : v;
  }

  function rankClass(i) {
    if (i === 0) return 'gold';
    if (i === 1) return 'silver';
    if (i === 2) return 'bronze';
    return 'other';
  }

  // ─── Chart defaults ────────────────────────────────────────────────────

  Chart.defaults.color = '#777777';
  Chart.defaults.borderColor = '#2a2a2a';
  Chart.defaults.font.family = "'IBM Plex Mono', 'Courier New', monospace";
  Chart.defaults.font.size = 11;

  function makeChartConfig(labels, datasets, yFormat) {
    return {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 10, padding: 8, font: { size: 10 } } },
          tooltip: {
            backgroundColor: '#1a1a1a',
            borderColor: '#333',
            borderWidth: 1,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            callbacks: yFormat ? { label: ctx => ctx.dataset.label + ': ' + yFormat(ctx.parsed.y) } : {}
          }
        },
        scales: {
          x: { grid: { color: '#1a1a1a' }, ticks: { maxRotation: 45, font: { size: 10 } } },
          y: { grid: { color: '#1a1a1a' }, ticks: { callback: yFormat || (v => v), font: { size: 10 } }, beginAtZero: true }
        },
        elements: {
          point: { radius: 2, hoverRadius: 5 },
          line: { tension: 0.3, borderWidth: 2 }
        }
      }
    };
  }

  // Bar chart: users on x-axis, single metric on y-axis (used for 1W scope)
  function makeBarChartConfig(userLabels, values, colors, yFormat) {
    return {
      type: 'bar',
      data: {
        labels: userLabels,
        datasets: [{
          label: '',
          data: values,
          backgroundColor: colors.map(c => c + 'bb'),
          borderColor: colors,
          borderWidth: 1,
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a1a1a',
            borderColor: '#333',
            borderWidth: 1,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            callbacks: yFormat
              ? { label: ctx => yFormat(ctx.parsed.y) }
              : {}
          }
        },
        scales: {
          x: { grid: { color: '#1a1a1a' }, ticks: { maxRotation: 35, font: { size: 10 } } },
          y: { grid: { color: '#1a1a1a' }, ticks: { callback: yFormat || (v => v), font: { size: 10 } }, beginAtZero: true }
        }
      }
    };
  }

  // ─── Render summary cards ──────────────────────────────────────────────

  function renderSummary() {
    const periods = getScopedPeriods();
    const summary = getTeamSummary(periods);

    // Compute a previous-period summary for delta comparison
    let prevPeriods = [];
    if (currentScope > 0 && ALL_PERIODS.length > 0) {
      const latest = parseDate(ALL_PERIODS[ALL_PERIODS.length - 1].endDate);
      const cutoffEnd = new Date(latest);
      cutoffEnd.setDate(cutoffEnd.getDate() - currentScope);
      const cutoffStart = new Date(cutoffEnd);
      cutoffStart.setDate(cutoffStart.getDate() - currentScope);
      prevPeriods = ALL_PERIODS
        .filter(p => {
          const s = parseDate(p.startDate);
          return s >= cutoffStart && s < cutoffEnd;
        })
        .map(p => p.id);
    }
    const prevSummary = getTeamSummary(prevPeriods);

    const cards = [
      { label: 'Avg Team Score', value: summary.teamScore, prev: prevSummary.teamScore, fmt: v => v.toFixed(1) },
      { label: 'Active Users', value: summary.activeUsers, prev: prevSummary.activeUsers, fmt: v => v },
      { label: 'Total PRs', value: summary.totalPullRequests, prev: prevSummary.totalPullRequests, fmt: formatNum },
      { label: 'Total Commits', value: summary.totalCommits, prev: prevSummary.totalCommits, fmt: formatNum },
    ];

    const el = document.getElementById('summary-row');
    el.innerHTML = cards.map(c => {
      const d = getDelta(c.value, c.prev);
      return '<div class="summary-card">'
        + '<div class="card-label">' + c.label + '</div>'
        + '<div class="card-value">' + c.fmt(c.value) + '</div>'
        + '<div class="card-delta ' + d.cls + '">' + d.text + '</div>'
        + '</div>';
    }).join('');
  }

  // ─── Render widgets ────────────────────────────────────────────────────

  function renderWidgets() {
    const periods = getScopedPeriods();
    const isWeekView = currentScope === 7;
    const grid = document.getElementById('widget-grid');

    // First pass: create DOM structure
    if (grid.children.length === 0) {
      grid.innerHTML = METRICS.map((m, i) =>
        '<div class="widget">'
          + '<div class="widget-header"><span class="widget-title" id="widget-title-' + m.key + '">' + m.label + ' Trends</span></div>'
          + '<div class="widget-body">'
            + '<div class="widget-chart"><canvas id="chart-' + m.key + '"></canvas></div>'
            + '<div class="widget-leaderboard" id="lb-' + m.key + '"></div>'
          + '</div>'
        + '</div>'
      ).join('');
    }

    METRICS.forEach((metric, mi) => {
      const titleEl = document.getElementById('widget-title-' + metric.key);
      if (titleEl) titleEl.textContent = metric.label + (isWeekView ? ' — This Week' : ' Trends');

      // Destroy previous chart if exists
      if (charts[metric.key]) charts[metric.key].destroy();

      const canvas = document.getElementById('chart-' + metric.key);

      if (isWeekView) {
        // Bar chart: all active users sorted by value descending, on x-axis
        const allUsers = Object.keys(DATA.users)
          .map(name => {
            const totals = getUserTotals(name, periods);
            const value = metric.key === 'effectivePRs' ? totals.effectivePRs : (totals[metric.key] || 0);
            return { name, value };
          })
          .filter(u => u.value > 0)
          .sort((a, b) => b.value - a.value);

        const userLabels = allUsers.map(u => u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '));
        const values = allUsers.map(u => u.value);
        const colors = allUsers.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);

        charts[metric.key] = new Chart(canvas, makeBarChartConfig(userLabels, values, colors, metric.format));

        // Leaderboard: top 5 from same sorted list
        const lb = document.getElementById('lb-' + metric.key);
        lb.innerHTML = allUsers.slice(0, 5).map((u, i) =>
          '<div class="lb-item" onclick="openProfile(\\'' + u.name.replace(/'/g, "\\\\'") + '\\')">'
            + '<span class="lb-rank ' + rankClass(i) + '">' + (i + 1) + '</span>'
            + '<span class="lb-name">' + u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') + '</span>'
            + '<span class="lb-value">' + metric.format(u.value) + '</span>'
          + '</div>'
        ).join('');
      } else {
        // Line chart: top 5 users over time
        const labels = periods.map(formatPeriodLabel);
        const top5 = getTopUsers(metric.key, periods, 5);

        const datasets = top5.map((user, ui) => {
          const ud = DATA.users[user.name];
          return {
            label: user.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
            data: periods.map(p => {
              const d = ud.data[p];
              if (!d) return 0;
              if (metric.key === 'effectivePRs') return d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
              return d[metric.key] || 0;
            }),
            borderColor: CHART_COLORS[ui % CHART_COLORS.length],
            backgroundColor: CHART_COLORS[ui % CHART_COLORS.length] + '15',
            fill: false
          };
        });

        charts[metric.key] = new Chart(canvas, makeChartConfig(labels, datasets, metric.format));

        // Leaderboard
        const lb = document.getElementById('lb-' + metric.key);
        lb.innerHTML = top5.map((u, i) =>
          '<div class="lb-item" onclick="openProfile(\\'' + u.name.replace(/'/g, "\\\\'") + '\\')">'
            + '<span class="lb-rank ' + rankClass(i) + '">' + (i + 1) + '</span>'
            + '<span class="lb-name">' + u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') + '</span>'
            + '<span class="lb-value">' + metric.format(u.value) + '</span>'
          + '</div>'
        ).join('');
      }
    });
  }

  // ─── Render users grid ─────────────────────────────────────────────────

  function renderUsers() {
    const periods = getScopedPeriods();
    const userNames = Object.keys(DATA.users);
    const usersWithTotals = userNames.map(name => ({
      name,
      totals: getUserTotals(name, periods)
    }));

    usersWithTotals.sort((a, b) => b.totals[currentSort] - a.totals[currentSort]);

    // Filter to users with any activity
    const active = usersWithTotals.filter(u => u.totals.score > 0);

    // Compute positive outliers
    const outliers = computeOutliers(periods);

    const grid = document.getElementById('users-grid');
    grid.innerHTML = active.map((u, i) => {
      const t = u.totals;
      const o = outliers[u.name] || {};
      const displayName = u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      const rankColors = ['rgba(255,170,0,0.15);color:#ffaa00','rgba(200,200,200,0.1);color:#ccc','rgba(205,127,50,0.12);color:#cd7f32'];
      const rankStyle = i < 3 ? 'background:' + rankColors[i] : 'background:rgba(85,85,85,0.15);color:var(--fg-dim)';
      const fire = (key) => o[key] ? '<span class="fire-badge" title="+' + o[key].zScore + 'σ above avg">🔥</span>' : '';
      return '<div class="user-card" onclick="openProfile(\\'' + u.name.replace(/'/g, "\\\\'") + '\\')">'
        + '<div class="user-card-header">'
          + '<span class="user-card-name">' + displayName + '</span>'
          + '<span class="user-card-rank" style="' + rankStyle + '">#' + (i + 1) + '</span>'
        + '</div>'
        + '<div class="user-card-stats">'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.score) + fire('score') + '</div><div class="stat-label">Score</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.commits) + fire('commits') + '</div><div class="stat-label">Commits</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.effectivePRs) + fire('effectivePRs') + '</div><div class="stat-label">PRs</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.reviews) + fire('reviews') + '</div><div class="stat-label">Reviews</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.loc) + fire('loc') + '</div><div class="stat-label">LOC</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.filesTouched) + fire('filesTouched') + '</div><div class="stat-label">Files</div></div>'
        + '</div>'
      + '</div>';
    }).join('');
  }

  // ─── User Profile ──────────────────────────────────────────────────────

  window.openProfile = function(userName) {
    const overlay = document.getElementById('profile-overlay');
    const panel = document.getElementById('profile-panel');
    const periods = getScopedPeriods();
    const labels = periods.map(formatPeriodLabel);
    const totals = getUserTotals(userName, periods);
    const displayName = userName.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    const ud = DATA.users[userName];

    // Compute rank
    const allUsers = Object.keys(DATA.users).map(n => ({ name: n, score: getUserTotals(n, periods).score }));
    allUsers.sort((a, b) => b.score - a.score);
    const rank = allUsers.findIndex(u => u.name === userName) + 1;

    // Determine date range label
    const firstPeriod = ALL_PERIODS.find(p => p.id === periods[0]);
    const lastPeriod = ALL_PERIODS.find(p => p.id === periods[periods.length - 1]);
    const rangeLabel = (firstPeriod ? firstPeriod.startDate : '') + ' to ' + (lastPeriod ? lastPeriod.endDate : '');

    let html = '<button class="profile-close" onclick="closeProfile()">✕ CLOSE</button>';
    html += '<div class="profile-name">' + displayName + '</div>';
    html += '<div class="profile-subtitle">Rank #' + rank + ' of ' + allUsers.filter(u => u.score > 0).length + ' active contributors &mdash; ' + rangeLabel + '</div>';

    const outliers = computeOutliers(periods);
    const userOutliers = outliers[userName] || {};

    html += '<div class="profile-stats">';
    METRICS.forEach(m => {
      const fire = userOutliers[m.key] ? '<span class="fire-badge" title="+' + userOutliers[m.key].zScore + 'σ above avg">🔥</span>' : '';
      html += '<div class="profile-stat">'
        + '<div class="pstat-value">' + m.format(totals[m.key]) + fire + '</div>'
        + '<div class="pstat-label">' + m.label + '</div>'
        + '</div>';
    });
    html += '</div>';

    html += '<div class="profile-charts">';
    METRICS.forEach(m => {
      html += '<div class="profile-chart-box">'
        + '<div class="pchart-title">' + m.label + '</div>'
        + '<canvas id="pchart-' + m.key + '"></canvas>'
        + '</div>';
    });
    html += '</div>';

    panel.innerHTML = html;
    overlay.classList.add('visible');

    // Render profile charts
    Object.values(profileCharts).forEach(c => c.destroy());
    profileCharts = {};

    METRICS.forEach(m => {
      const canvas = document.getElementById('pchart-' + m.key);
      const data = periods.map(p => {
        const d = ud && ud.data[p];
        if (!d) return 0;
        if (m.key === 'effectivePRs') return d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
        return d[m.key] || 0;
      });
      profileCharts[m.key] = new Chart(canvas, makeChartConfig(
        labels,
        [{
          label: m.label,
          data,
          borderColor: m.color,
          backgroundColor: m.color + '20',
          fill: true
        }],
        m.format
      ));
    });
  };

  window.closeProfile = function() {
    document.getElementById('profile-overlay').classList.remove('visible');
    Object.values(profileCharts).forEach(c => c.destroy());
    profileCharts = {};
  };

  // ─── Tab switching ─────────────────────────────────────────────────────

  window.switchTab = function(tab) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
    if (tab === 'users') renderUsers();
  };

  // ─── Scope filter ──────────────────────────────────────────────────────

  window.setScope = function(days) {
    currentScope = days;
    document.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', +b.dataset.scope === days));
    renderAll();
  };

  // ─── User sort ─────────────────────────────────────────────────────────

  window.setUserSort = function(key) {
    currentSort = key;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
    renderUsers();
  };

  // ─── Render all ────────────────────────────────────────────────────────

  function renderAll() {
    renderSummary();
    renderWidgets();
    if (document.getElementById('tab-users').classList.contains('active')) {
      renderUsers();
    }
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  function init() {
    const rangeEl = document.getElementById('data-range');
    if (ALL_PERIODS.length > 0) {
      const first = ALL_PERIODS[0];
      const last = ALL_PERIODS[ALL_PERIODS.length - 1];
      rangeEl.textContent = 'DATA RANGE: ' + first.startDate + ' — ' + last.endDate + ' (' + ALL_PERIODS.length + ' periods)';
    } else {
      rangeEl.textContent = 'NO DATA AVAILABLE';
    }
    renderAll();
  }

  // Handle escape key to close profile
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeProfile();
  });

  init();
})();
</script>
</body>
</html>`;

// ─── Write output ───────────────────────────────────────────────────────────

fs.writeFileSync(outputFile, html, 'utf8');
console.log(`Dashboard written to ${outputFile}`);

// Open in default browser
const openCmd =
  process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'start'
      : 'xdg-open';
exec(`${openCmd} "${outputFile}"`);
