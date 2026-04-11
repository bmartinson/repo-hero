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
const months = Object.keys(raw)
  .filter(k => k !== 'combined_results')
  .sort();

const dashboardData = {
  months: [],
  users: {},
  team: [],
};

months.forEach(month => {
  const entry = raw[month];
  if (!entry || !entry.users) return;

  const dateLabel = month.slice(0, 7); // YYYY-MM

  dashboardData.months.push(dateLabel);

  dashboardData.team.push({
    date: dateLabel,
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
    dashboardData.users[name].data[dateLabel] = {
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

// Deduplicate months
dashboardData.months = [...new Set(dashboardData.months)].sort();

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
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
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
      <button class="scope-btn" data-scope="1" onclick="setScope(1)">1M</button>
      <button class="scope-btn" data-scope="3" onclick="setScope(3)">3M</button>
      <button class="scope-btn" data-scope="6" onclick="setScope(6)">6M</button>
      <button class="scope-btn active" data-scope="12" onclick="setScope(12)">1Y</button>
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
      <button class="scope-btn users-scope-btn" data-scope="1" onclick="setScope(1)">1M</button>
      <button class="scope-btn users-scope-btn" data-scope="3" onclick="setScope(3)">3M</button>
      <button class="scope-btn users-scope-btn" data-scope="6" onclick="setScope(6)">6M</button>
      <button class="scope-btn users-scope-btn active" data-scope="12" onclick="setScope(12)">1Y</button>
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
  const ALL_MONTHS = DATA.months;
  const METRICS = [
    { key: 'score',        label: 'Score',         color: '#00ddcc', format: v => v.toFixed(0) },
    { key: 'effectivePRs', label: 'Pull Requests',  color: '#00aaff', format: v => v.toFixed(0), dataKey: 'effectivePR' },
    { key: 'reviews',      label: 'Reviews',        color: '#cc66ff', format: v => v.toFixed(0) },
    { key: 'commits',      label: 'Commits',        color: '#22cc44', format: v => v.toFixed(0) },
    { key: 'loc',          label: 'Lines of Code',  color: '#ff8844', format: v => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0) },
    { key: 'filesTouched', label: 'Files Touched',  color: '#ffaa00', format: v => v.toFixed(0) },
  ];

  const CHART_COLORS = ['#00ddcc','#00aaff','#cc66ff','#22cc44','#ff8844','#ffaa00','#ff3333','#88ff88','#ff66aa','#aaddff'];

  let currentScope = 12;
  let currentSort = 'score';
  let charts = {};
  let profileCharts = {};

  // ─── Helpers ────────────────────────────────────────────────────────────

  function getScopedMonths() {
    if (ALL_MONTHS.length === 0) return [];
    const end = ALL_MONTHS.length - 1;
    const start = Math.max(0, end - currentScope + 1);
    return ALL_MONTHS.slice(start, end + 1);
  }

  function getUserTotals(userName, months) {
    const ud = DATA.users[userName];
    if (!ud) return { score:0, commits:0, pullRequests:0, predictedPullRequests:0, effectivePRs:0, reviews:0, loc:0, filesTouched:0 };
    const totals = { score:0, commits:0, pullRequests:0, predictedPullRequests:0, effectivePRs:0, reviews:0, loc:0, filesTouched:0 };
    months.forEach(m => {
      const d = ud.data[m];
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

  function getTopUsers(metricKey, months, limit) {
    const userNames = Object.keys(DATA.users);
    const scored = userNames.map(name => {
      const totals = getUserTotals(name, months);
      return { name, value: totals[metricKey] };
    });
    scored.sort((a, b) => b.value - a.value);
    return scored.filter(u => u.value > 0).slice(0, limit);
  }

  function getTeamSummary(months) {
    const filtered = DATA.team.filter(t => months.includes(t.date));
    if (filtered.length === 0) return { teamScore:0, activeUsers:0, totalPullRequests:0, totalCommits:0 };
    const last = filtered[filtered.length - 1];
    const avg = (key) => filtered.reduce((s,t) => s + t[key], 0) / filtered.length;
    return {
      teamScore: avg('teamScore'),
      activeUsers: Math.round(avg('activeUsers')),
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

  // ─── Render summary cards ──────────────────────────────────────────────

  function renderSummary() {
    const months = getScopedMonths();
    const summary = getTeamSummary(months);

    // Compute a previous-period summary for delta
    const prevEnd = Math.max(0, ALL_MONTHS.length - currentScope - 1);
    const prevStart = Math.max(0, prevEnd - currentScope + 1);
    const prevMonths = ALL_MONTHS.slice(prevStart, prevEnd + 1);
    const prevSummary = getTeamSummary(prevMonths);

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
    const months = getScopedMonths();
    const grid = document.getElementById('widget-grid');

    // First pass: create DOM structure
    if (grid.children.length === 0) {
      grid.innerHTML = METRICS.map((m, i) =>
        '<div class="widget">'
          + '<div class="widget-header"><span class="widget-title">' + m.label + ' Trends</span></div>'
          + '<div class="widget-body">'
            + '<div class="widget-chart"><canvas id="chart-' + m.key + '"></canvas></div>'
            + '<div class="widget-leaderboard" id="lb-' + m.key + '"></div>'
          + '</div>'
        + '</div>'
      ).join('');
    }

    METRICS.forEach((metric, mi) => {
      // Top 5 for chart lines
      const top5 = getTopUsers(metric.key, months, 5);

      // Build datasets
      const datasets = top5.map((user, ui) => {
        const ud = DATA.users[user.name];
        return {
          label: user.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          data: months.map(m => {
            const d = ud.data[m];
            if (!d) return 0;
            if (metric.key === 'effectivePRs') return d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
            return d[metric.key] || 0;
          }),
          borderColor: CHART_COLORS[ui % CHART_COLORS.length],
          backgroundColor: CHART_COLORS[ui % CHART_COLORS.length] + '15',
          fill: false
        };
      });

      // Destroy previous chart if exists
      if (charts[metric.key]) charts[metric.key].destroy();

      const canvas = document.getElementById('chart-' + metric.key);
      charts[metric.key] = new Chart(canvas, makeChartConfig(months, datasets, metric.format));

      // Leaderboard
      const lb = document.getElementById('lb-' + metric.key);
      lb.innerHTML = top5.map((u, i) =>
        '<div class="lb-item" onclick="openProfile(\\'' + u.name.replace(/'/g, "\\\\'") + '\\')">'
          + '<span class="lb-rank ' + rankClass(i) + '">' + (i + 1) + '</span>'
          + '<span class="lb-name">' + u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') + '</span>'
          + '<span class="lb-value">' + metric.format(u.value) + '</span>'
        + '</div>'
      ).join('');
    });
  }

  // ─── Render users grid ─────────────────────────────────────────────────

  function renderUsers() {
    const months = getScopedMonths();
    const userNames = Object.keys(DATA.users);
    const usersWithTotals = userNames.map(name => ({
      name,
      totals: getUserTotals(name, months)
    }));

    usersWithTotals.sort((a, b) => b.totals[currentSort] - a.totals[currentSort]);

    // Filter to users with any activity
    const active = usersWithTotals.filter(u => u.totals.score > 0);

    const grid = document.getElementById('users-grid');
    grid.innerHTML = active.map((u, i) => {
      const t = u.totals;
      const displayName = u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      const rankColors = ['rgba(255,170,0,0.15);color:#ffaa00','rgba(200,200,200,0.1);color:#ccc','rgba(205,127,50,0.12);color:#cd7f32'];
      const rankStyle = i < 3 ? 'background:' + rankColors[i] : 'background:rgba(85,85,85,0.15);color:var(--fg-dim)';
      return '<div class="user-card" onclick="openProfile(\\'' + u.name.replace(/'/g, "\\\\'") + '\\')">'
        + '<div class="user-card-header">'
          + '<span class="user-card-name">' + displayName + '</span>'
          + '<span class="user-card-rank" style="' + rankStyle + '">#' + (i + 1) + '</span>'
        + '</div>'
        + '<div class="user-card-stats">'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.score) + '</div><div class="stat-label">Score</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.commits) + '</div><div class="stat-label">Commits</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.pullRequests) + '</div><div class="stat-label">PRs</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.reviews) + '</div><div class="stat-label">Reviews</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.loc) + '</div><div class="stat-label">LOC</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.filesTouched) + '</div><div class="stat-label">Files</div></div>'
        + '</div>'
      + '</div>';
    }).join('');
  }

  // ─── User Profile ──────────────────────────────────────────────────────

  window.openProfile = function(userName) {
    const overlay = document.getElementById('profile-overlay');
    const panel = document.getElementById('profile-panel');
    const months = getScopedMonths();
    const totals = getUserTotals(userName, months);
    const displayName = userName.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    const ud = DATA.users[userName];

    // Compute rank
    const allUsers = Object.keys(DATA.users).map(n => ({ name: n, score: getUserTotals(n, months).score }));
    allUsers.sort((a, b) => b.score - a.score);
    const rank = allUsers.findIndex(u => u.name === userName) + 1;

    let html = '<button class="profile-close" onclick="closeProfile()">✕ CLOSE</button>';
    html += '<div class="profile-name">' + displayName + '</div>';
    html += '<div class="profile-subtitle">Rank #' + rank + ' of ' + allUsers.filter(u => u.score > 0).length + ' active contributors &mdash; ' + months[0] + ' to ' + months[months.length-1] + '</div>';

    html += '<div class="profile-stats">';
    METRICS.forEach(m => {
      html += '<div class="profile-stat">'
        + '<div class="pstat-value">' + m.format(totals[m.key]) + '</div>'
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
      const data = months.map(mo => {
        const d = ud && ud.data[mo];
        if (!d) return 0;
        if (m.key === 'effectivePRs') return d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
        return d[m.key] || 0;
      });
      profileCharts[m.key] = new Chart(canvas, makeChartConfig(
        months,
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

  window.setScope = function(months) {
    currentScope = months;
    document.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', +b.dataset.scope === months));
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
    if (ALL_MONTHS.length > 0) {
      rangeEl.textContent = 'DATA RANGE: ' + ALL_MONTHS[0] + ' — ' + ALL_MONTHS[ALL_MONTHS.length - 1] + ' (' + ALL_MONTHS.length + ' months)';
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
