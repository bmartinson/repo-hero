const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { WEIGHTS } = require('./score');

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
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3"></script>
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

/* ─── Score Distribution ─────────────────────────────────────────────────── */

.dist-section {
  margin-top: 36px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
}

.dist-title {
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 4px;
}

.dist-subtitle {
  font-size: 11px;
  color: var(--fg-dim);
  margin-bottom: 16px;
}

.dist-chart-wrap {
  position: relative;
  width: 100%;
  height: 300px;
}

.dist-chart-wrap canvas {
  width: 100% !important;
  height: 100% !important;
}

.dist-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 14px;
  font-size: 11px;
  color: var(--fg-dim);
}

.dist-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dist-legend-swatch {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
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
  max-width: 960px;
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

/* ─── Contribution Breakdown Table ───────────────────────────────────────── */

.profile-breakdown {
  margin-top: 28px;
}

.breakdown-toggle {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-family: var(--font);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  padding: 8px 16px;
  cursor: pointer;
  border-radius: var(--radius);
  transition: color 0.15s, border-color 0.15s;
  width: 100%;
  text-align: left;
}

.breakdown-toggle:hover { color: var(--fg-bright); border-color: var(--fg-dim); }

.breakdown-toggle .caret {
  display: inline-block;
  transition: transform 0.2s;
  margin-right: 8px;
}

.breakdown-toggle.open .caret { transform: rotate(90deg); }

.breakdown-table-wrap {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.breakdown-table-wrap.open {
  max-height: 2000px;
}

.breakdown-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
  font-size: 12px;
}

.breakdown-table th {
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 10px;
  color: var(--fg-dim);
  font-weight: 500;
  padding: 8px 10px;
  text-align: right;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.breakdown-table th:first-child { text-align: left; }

.breakdown-table td {
  padding: 6px 10px;
  text-align: right;
  color: var(--fg);
  border-bottom: 1px solid rgba(255,255,255,0.04);
  white-space: nowrap;
}

.breakdown-table td:first-child {
  text-align: left;
  color: var(--fg-muted);
}

.breakdown-table tr:hover td {
  background: var(--bg-card-hover);
}

.breakdown-table .total-row td {
  border-top: 1px solid var(--fg-dim);
  color: var(--fg-bright);
  font-weight: 700;
}

/* ─── Methodology Page ───────────────────────────────────────────────────── */

.methodology-content {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px 0 60px;
  line-height: 1.7;
}

.meth-heading {
  color: var(--fg-bright);
  font-size: 22px;
  font-weight: 700;
  margin: 40px 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.meth-heading:first-child { margin-top: 8px; }

.meth-subheading {
  color: var(--fg-cyan);
  font-size: 15px;
  font-weight: 500;
  margin: 28px 0 8px;
}

.meth-text {
  color: var(--fg);
  font-size: 13px;
  margin: 8px 0 14px;
}

.meth-text strong { color: var(--fg-bright); }
.meth-text em { color: var(--fg-info); font-style: normal; }
.meth-text code {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 12px;
  color: var(--fg-cyan);
}

.meth-formula {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  font-size: 13px;
  color: var(--fg-cyan);
  margin: 16px 0;
  overflow-x: auto;
  white-space: nowrap;
  letter-spacing: 0.5px;
}

.meth-table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0 24px;
  font-size: 13px;
}

.meth-table th {
  text-align: left;
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 10px;
  color: var(--fg-dim);
  font-weight: 500;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.meth-table td {
  padding: 8px 12px;
  color: var(--fg);
  border-bottom: 1px solid rgba(255,255,255,0.04);
  vertical-align: top;
}

.meth-table tr:hover td { background: var(--bg-card-hover); }

.meth-mono {
  font-family: var(--font);
  color: var(--fg-cyan);
  white-space: nowrap;
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

/* ─── Footer ─────────────────────────────────────────────────────────────── */

.site-footer {
  text-align: center;
  padding: 32px 20px 24px;
  margin-top: 48px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--fg-dim);
  letter-spacing: 0.5px;
}

.site-footer a {
  color: var(--fg-muted);
  text-decoration: none;
  transition: color 0.15s;
}

.site-footer a:hover { color: var(--fg-bright); }

.footer-inner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.footer-sep {
  color: var(--border);
  margin: 0 6px;
}

.footer-icon {
  display: inline-block;
  width: 14px;
  height: 14px;
  vertical-align: -2px;
  opacity: 0.6;
}

.site-footer a:hover .footer-icon { opacity: 1; }

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
    <button class="nav-btn" data-tab="methodology" onclick="switchTab('methodology')">METHODOLOGY</button>
  </nav>

  <!-- ═══ Dashboard Tab ═══ -->
  <div class="tab-panel active" id="tab-dashboard">

    <!-- Filter bar -->
    <div class="filter-bar">
      <span class="label">Scope:</span>
      <button class="scope-btn active" data-scope="7" onclick="setScope(7)">1W</button>
      <button class="scope-btn" data-scope="14" onclick="setScope(14)">2W</button>
      <button class="scope-btn" data-scope="21" onclick="setScope(21)">3W</button>
      <button class="scope-btn" data-scope="30" onclick="setScope(30)">1M</button>
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
      <button class="scope-btn users-scope-btn active" data-scope="7" onclick="setScope(7)">1W</button>
      <button class="scope-btn users-scope-btn" data-scope="14" onclick="setScope(14)">2W</button>
      <button class="scope-btn users-scope-btn" data-scope="21" onclick="setScope(21)">3W</button>
      <button class="scope-btn users-scope-btn" data-scope="30" onclick="setScope(30)">1M</button>
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

    <!-- Score Distribution -->
    <div class="dist-section" id="dist-section">
      <div class="dist-title">SCORE DISTRIBUTION</div>
      <div class="dist-subtitle" id="dist-subtitle"></div>
      <div class="dist-chart-wrap">
        <canvas id="dist-chart"></canvas>
      </div>
      <div class="dist-legend" id="dist-legend"></div>
    </div>
  </div>

  <!-- ═══ Methodology Tab ═══ -->
  <div class="tab-panel" id="tab-methodology">
    <div class="methodology-content">

      <h2 class="meth-heading">How Scoring Works</h2>
      <p class="meth-text">
        Each contributor receives a <strong>score</strong> per time period based on a weighted sum
        of their activity metrics. The formula is:
      </p>
      <div class="meth-formula">
        score = ${Object.entries(WEIGHTS).map(([key, w]) => {
          const label = key === 'loc' ? 'LOC' : key === 'filesTouched' ? 'Files Touched' : key === 'pullRequests' ? 'Pull Requests' : key === 'predictedPullRequests' ? 'Predicted PRs' : key === 'commits' ? 'Commits' : key === 'reviews' ? 'Reviews' : key;
          if (w >= 1) return label + ' × ' + w;
          return label + ' × ' + w.toFixed(w < 0.001 ? 4 : 4).replace(/0+$/, '').replace(/\\.$/, '');
        }).join(' + ')}
      </div>
      <p class="meth-text">
        When a contributor has real pull request data, their <em>Pull Requests</em> count is used.
        When they have commits but zero PRs for a period, <em>Predicted PRs</em> are substituted instead
        (never both — the higher-signal real data always takes priority).
      </p>

      <h3 class="meth-subheading">Weight Breakdown</h3>
      <table class="meth-table">
        <thead>
          <tr><th>Metric</th><th>Weight</th><th>Rationale</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Pull Requests</td>
            <td class="meth-mono">${WEIGHTS.pullRequests}</td>
            <td>High weight — PRs represent complete, reviewable units of work.</td>
          </tr>
          <tr>
            <td>Predicted PRs</td>
            <td class="meth-mono">${WEIGHTS.predictedPullRequests}</td>
            <td>Same weight as real PRs. Only used when real PR data is unavailable.</td>
          </tr>
          <tr>
            <td>Reviews</td>
            <td class="meth-mono">${WEIGHTS.reviews}</td>
            <td>High weight — code reviews are critical to quality and team collaboration.</td>
          </tr>
          <tr>
            <td>Commits</td>
            <td class="meth-mono">${WEIGHTS.commits}</td>
            <td>Low weight — raw commit count is noisy (squash vs. many small commits).</td>
          </tr>
          <tr>
            <td>Lines of Code</td>
            <td class="meth-mono">${WEIGHTS.loc}</td>
            <td>Minimal weight — more code isn't necessarily better; avoids rewarding bloat.</td>
          </tr>
          <tr>
            <td>Files Touched</td>
            <td class="meth-mono">${WEIGHTS.filesTouched}</td>
            <td>Minimal weight — breadth signal, but easily inflated by refactors or renames.</td>
          </tr>
        </tbody>
      </table>

      <h2 class="meth-heading">Predicted Pull Requests</h2>
      <p class="meth-text">
        Many repositories — especially older ones or those without a PR-based workflow — have periods
        where contributors committed directly to the main branch with no pull requests. Without
        prediction, those periods would score near zero despite real work being done.
      </p>

      <h3 class="meth-subheading">Pass 1 — Learning Ratios</h3>
      <p class="meth-text">
        The enrichment pipeline scans <strong>all</strong> historical result files and, for every user who has
        periods with real PR data, accumulates their total commits and total PRs to compute a personal
        <strong>commits-per-PR ratio</strong> (e.g., "Brian averages 11.5 commits per PR"). A
        <strong>team-wide average</strong> ratio is also computed as a fallback for users with no PR
        history at all.
      </p>

      <h3 class="meth-subheading">Pass 2 — Synthesizing Predictions</h3>
      <p class="meth-text">
        For any period where a user has <strong>commits but zero PRs</strong>, their commit count is
        divided by their personal ratio (or the team average) to produce a
        <code>predictedPullRequests</code> value. If they <em>do</em> have real PRs in a period, any
        stale prediction is removed — real data always wins.
      </p>

      <div class="meth-formula">
        predictedPRs = commits ÷ personalCommitsPerPR
      </div>

      <h3 class="meth-subheading">How It Affects Scoring</h3>
      <p class="meth-text">
        The scoring function computes an <strong>effective PRs</strong> value: if <code>pullRequests > 0</code>,
        use real PRs; otherwise use <code>predictedPullRequests</code>. This effective value receives the
        same ${WEIGHTS.pullRequests}× weight, giving historical periods fair representation without
        double-counting when real data exists.
      </p>

      <h2 class="meth-heading">Outlier Detection</h2>
      <p class="meth-text">
        For each metric in the active scope, the dashboard computes the <strong>mean</strong> and
        <strong>standard deviation</strong> across all active contributors. Any user whose value exceeds
        <strong>mean + 1.5σ</strong> is flagged as a positive outlier and receives a 🔥 badge on their
        stat tile — indicating exceptional performance in that category.
      </p>

      <h2 class="meth-heading">Dashboard Metrics</h2>
      <table class="meth-table">
        <thead>
          <tr><th>Metric</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>Score</td><td>Weighted composite of all metrics below. Higher is better.</td></tr>
          <tr><td>Pull Requests</td><td>Real PRs merged/opened, or predicted PRs when real data is unavailable.</td></tr>
          <tr><td>Reviews</td><td>Pull request reviews performed (approved, commented, or requested changes).</td></tr>
          <tr><td>Commits</td><td>Total git commits authored across all tracked repositories.</td></tr>
          <tr><td>Lines of Code</td><td>Net lines added (insertions − deletions) across all commits.</td></tr>
          <tr><td>Files Touched</td><td>Unique files modified across all commits in the period.</td></tr>
          <tr><td>Active Contributors</td><td>Unique users with any commits, PRs, or reviews in the scope.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- User Profile Overlay -->
<div class="overlay" id="profile-overlay" onclick="if(event.target===this)closeProfile()">
  <div class="profile-panel" id="profile-panel"></div>
</div>

<!-- Footer -->
<footer class="site-footer">
  <div class="footer-inner">
    <a href="https://www.github.com/bmartinson/repo-hero" target="_blank" rel="noopener">
      <svg class="footer-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Feedback &amp; Source
    </a>
    <span class="footer-sep">|</span>
    <a href="https://www.brianmartinson.com" target="_blank" rel="noopener">
      <svg class="footer-icon" viewBox="0 0 100 100" fill="currentColor"><text x="50" y="72" text-anchor="middle" font-family="Georgia, serif" font-size="58" font-weight="700" fill="currentColor">BJM</text></svg>
      Developed by Brian Martinson
    </a>
  </div>
</footer>

<script>
// ─── Data ───────────────────────────────────────────────────────────────────
window.__REPO_HERO_DATA__ = ${JSON.stringify(dashboardData)};

(function() {
  'use strict';

  const DATA = window.__REPO_HERO_DATA__;
  const GENERATED_AT = '${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}';
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

  let currentScope = 7; // days (0 = all)
  let currentSort = 'score';
  let charts = {};
  let profileCharts = {};
  let distChart = null;

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

    // ─── Score Distribution Chart ────────────────────────────────────────
    renderDistribution(active);
  }

  function renderDistribution(activeUsers) {
    if (distChart) { distChart.destroy(); distChart = null; }

    const scores = activeUsers.map(u => u.totals.score);
    if (scores.length < 2) return;

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, v) => a + (v - mean) ** 2, 0) / scores.length;
    const stdDev = Math.sqrt(variance);

    document.getElementById('dist-subtitle').textContent =
      'μ = ' + mean.toFixed(1) + '   σ = ' + stdDev.toFixed(1) + '   n = ' + scores.length;

    const sorted = activeUsers
      .map(u => ({
        name: u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
        score: u.totals.score,
        z: stdDev > 0 ? (u.totals.score - mean) / stdDev : 0
      }))
      .sort((a, b) => a.score - b.score);

    const bandColors = {
      'below-2':  { bg: 'rgba(255, 51, 51, 0.5)',  border: '#ff3333', label: '< −2σ' },
      'below-1':  { bg: 'rgba(255, 136, 68, 0.5)',  border: '#ff8844', label: '−2σ to −1σ' },
      'within':   { bg: 'rgba(0, 170, 255, 0.5)',   border: '#00aaff', label: '−1σ to +1σ' },
      'above-1':  { bg: 'rgba(0, 221, 204, 0.5)',   border: '#00ddcc', label: '+1σ to +2σ' },
      'above-2':  { bg: 'rgba(204, 102, 255, 0.5)', border: '#cc66ff', label: '> +2σ' },
    };

    function getBand(z) {
      if (z <= -2) return 'below-2';
      if (z <= -1) return 'below-1';
      if (z <= 1)  return 'within';
      if (z <= 2)  return 'above-1';
      return 'above-2';
    }

    const labels = sorted.map(u => u.name);
    const data = sorted.map(u => u.score);
    const bgColors = sorted.map(u => bandColors[getBand(u.z)].bg);
    const borderColors = sorted.map(u => bandColors[getBand(u.z)].border);

    const annotations = {};
    const lineStyle = { type: 'line', borderDash: [6, 4], borderWidth: 1, label: { display: true, position: 'start', font: { size: 10, family: 'IBM Plex Mono' }, padding: 3 } };

    annotations.mean = {
      ...lineStyle,
      yMin: mean, yMax: mean,
      borderColor: 'rgba(255,255,255,0.5)',
      label: { ...lineStyle.label, content: 'μ ' + mean.toFixed(0), color: 'rgba(255,255,255,0.7)', backgroundColor: 'rgba(0,0,0,0.6)' }
    };
    [-2, -1, 1, 2].forEach(n => {
      const val = mean + n * stdDev;
      if (val >= 0) {
        annotations['sd' + n] = {
          ...lineStyle,
          yMin: val, yMax: val,
          borderColor: 'rgba(255,255,255,0.2)',
          label: { ...lineStyle.label, content: (n > 0 ? '+' : '') + n + 'σ ' + val.toFixed(0), color: 'rgba(255,255,255,0.4)', backgroundColor: 'rgba(0,0,0,0.6)' }
        };
      }
    });

    const canvas = document.getElementById('dist-chart');
    distChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'x',
        plugins: {
          legend: { display: false },
          annotation: { annotations },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const u = sorted[ctx.dataIndex];
                return 'Score: ' + u.score.toFixed(0) + ' (' + (u.z >= 0 ? '+' : '') + u.z.toFixed(2) + 'σ)';
              }
            },
            titleFont: { family: 'IBM Plex Mono', size: 12 },
            bodyFont: { family: 'IBM Plex Mono', size: 11 },
            backgroundColor: 'rgba(0,0,0,0.85)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
          }
        },
        scales: {
          x: {
            ticks: { color: '#777', font: { family: 'IBM Plex Mono', size: 10 }, maxRotation: 45, minRotation: 25 },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#555', font: { family: 'IBM Plex Mono', size: 10 } },
            grid: { color: 'rgba(255,255,255,0.06)' },
            title: { display: true, text: 'Score', color: '#555', font: { family: 'IBM Plex Mono', size: 11 } }
          }
        }
      }
    });

    const legendEl = document.getElementById('dist-legend');
    const usedBands = new Set(sorted.map(u => getBand(u.z)));
    legendEl.innerHTML = Object.entries(bandColors)
      .filter(([k]) => usedBands.has(k))
      .map(([, v]) =>
        '<div class="dist-legend-item">'
          + '<div class="dist-legend-swatch" style="background:' + v.border + '"></div>'
          + '<span>' + v.label + '</span>'
        + '</div>'
      ).join('');
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

    // ─── Per-period breakdown table ──────────────────────────────────────
    html += '<div class="profile-breakdown">';
    html += '<button class="breakdown-toggle" onclick="this.classList.toggle(\\'open\\');this.nextElementSibling.classList.toggle(\\'open\\')">'
      + '<span class="caret">▶</span> CONTRIBUTION BREAKDOWN (' + periods.length + ' periods)</button>';
    html += '<div class="breakdown-table-wrap">';
    html += '<table class="breakdown-table">';
    html += '<thead><tr><th>Period</th>';
    METRICS.forEach(m => { html += '<th>' + m.label + '</th>'; });
    html += '</tr></thead><tbody>';

    periods.forEach(pid => {
      const p = ALL_PERIODS.find(x => x.id === pid);
      const d = ud && ud.data[pid];
      const periodLabel = formatPeriodLabel(pid);
      const dateRange = p ? p.startDate + ' → ' + p.endDate : pid;
      html += '<tr title="' + dateRange + '"><td>' + periodLabel + '</td>';
      METRICS.forEach(m => {
        let val = 0;
        if (d) {
          if (m.key === 'effectivePRs') val = d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
          else val = d[m.key] || 0;
        }
        html += '<td>' + m.format(val) + '</td>';
      });
      html += '</tr>';
    });

    // Totals row
    html += '<tr class="total-row"><td>TOTAL</td>';
    METRICS.forEach(m => { html += '<td>' + m.format(totals[m.key]) + '</td>'; });
    html += '</tr>';

    html += '</tbody></table></div></div>';

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
      rangeEl.textContent = 'DATA RANGE: ' + first.startDate + ' — ' + last.endDate + ' (' + ALL_PERIODS.length + ' periods)  ·  Last updated ' + GENERATED_AT;
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
