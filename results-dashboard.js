const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { sendDashboardEmail } = require('./email-dashboard');
const { WEIGHTS, CHURN_WEIGHTS, calculateChurn } = require('./score');

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
  // Jira is an opt-in integration. When no results file carries resolution data
  // the dashboard hides the metric entirely rather than showing empty zeroes.
  hasIssueResolutions: false,
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
      feedback: user.feedback || 0,
      approvals: user.approvals || 0,
      issueResolutions: user.issueResolutions || 0,
      loc: user.loc || 0,
      filesTouched: user.filesTouched || 0,
      churnOpenDurationDays: user.churnOpenDurationDays || 0,
      churnFeedbackReviews: user.churnFeedbackReviews || 0,
      churnNonBotComments: user.churnNonBotComments || 0,
      repoBreakdown: user.repoBreakdown || {},
      resolutionBreakdown: user.resolutionBreakdown || {},
      pullRequestList: user.pullRequestList || [],
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

// Detect whether any period carries issue resolution data
dashboardData.hasIssueResolutions = Object.values(dashboardData.users).some(u =>
  Object.values(u.data).some(d => (d.issueResolutions || 0) > 0)
);

const hasIssueResolutions = dashboardData.hasIssueResolutions;

// ─── Team roles (optional) ──────────────────────────────────────────────────
// Reads "roles" (per-role weekly satisfactory/goal targets), "userRoles"
// (canonical name -> role name), and "userEndDates" (canonical name -> the
// last day they should be counted, for departed/offboarded contributors) from
// config.json. All are entirely optional — a missing/unparseable config, or
// missing keys, simply disables the role badge / attainment bar and the
// methodology role tables, with no trailing-window clamp applied.
const configFilePath = path.join(__dirname, 'config.json');
function loadRoleConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    return {
      roles: cfg.roles || {},
      userRoles: cfg.userRoles || {},
      userEndDates: cfg.userEndDates || {},
    };
  } catch {
    return { roles: {}, userRoles: {}, userEndDates: {} };
  }
}
const {
  roles: ROLES,
  userRoles: USER_ROLES,
  userEndDates: USER_END_DATES,
} = loadRoleConfig();

// ─── Build HTML ─────────────────────────────────────────────────────────────

const logoSvg = fs.existsSync(logoFile)
  ? fs.readFileSync(logoFile, 'utf8')
  : '';

const bjmFaviconFile = path.join(__dirname, 'assets', 'bjm-favicon-white.png');
const bjmFaviconB64 = fs.existsSync(bjmFaviconFile)
  ? fs.readFileSync(bjmFaviconFile).toString('base64')
  : '';

// Dark-on-transparent variant, used by the light theme where the white mark
// would otherwise be invisible against the page background.
const bjmFaviconDarkFile = path.join(__dirname, 'assets', 'bjm-favicon.png');
const bjmFaviconDarkB64 = fs.existsSync(bjmFaviconDarkFile)
  ? fs.readFileSync(bjmFaviconDarkFile).toString('base64')
  : bjmFaviconB64;

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
<script>
/* Resolve the theme before first paint so a saved light theme never flashes
   dark. Mirrors the bjm-www model: the natural theme follows the clock, and a
   manual override only survives while the same time window is still active. */
(function () {
  try {
    var KEY = 'repo-hero-color-scheme';
    var hour = new Date().getHours();
    var natural = hour >= 7 && hour < 17 ? 'light' : 'dark';
    var theme = natural;
    var raw = window.localStorage.getItem(KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && saved.window === natural &&
          (saved.override === 'light' || saved.override === 'dark')) {
        theme = saved.override;
      } else {
        window.localStorage.removeItem(KEY);
      }
    }
    window.__RH_THEME_KEY = KEY;
    window.__RH_THEME = theme;
    window.__RH_NATURAL = natural;
    if (theme === 'light') document.documentElement.classList.add('light-mode');
  } catch (e) {
    window.__RH_THEME = 'dark';
    window.__RH_NATURAL = 'dark';
    window.__RH_THEME_KEY = 'repo-hero-color-scheme';
  }
})();
</script>
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
  --shadow: rgba(0, 0, 0, 0.5);
  --overlay-backdrop: rgba(0, 0, 0, 0.85);
  --scanline: rgba(0, 0, 0, 0.03);
  --font: 'IBM Plex Mono', 'Courier New', 'Consolas', monospace;
  --radius: 4px;
  --glow-cyan: 0 0 8px rgba(0, 221, 204, 0.3);
  --glow-info: 0 0 8px rgba(0, 170, 255, 0.3);
}

/* ─── Light Theme ────────────────────────────────────────────────────────── */
/* Same variable contract as the dark default, so every existing rule adapts
   without modification. Accent hues are kept but darkened for contrast on a
   light background. */

html.light-mode {
  --bg: #f4f5f7;
  --bg-card: #ffffff;
  --bg-card-hover: #eceef1;
  --fg: #2b2f36;
  --fg-dim: #7c838d;
  --fg-bright: #0b0d10;
  --fg-muted: #5c636d;
  --fg-error: #c62828;
  --fg-warn: #9a6100;
  --fg-success: #0f7a30;
  --fg-info: #0062b8;
  --fg-cyan: #00736e;
  --fg-magenta: #7326c4;
  --fg-orange: #b8481a;
  --border: #d9dde3;
  --border-focus: #a9b1bb;
  --shadow: rgba(15, 20, 30, 0.16);
  --scanline: rgba(0, 0, 0, 0.015);
  --overlay-backdrop: rgba(24, 26, 30, 0.55);
  --glow-cyan: 0 0 8px rgba(0, 115, 110, 0.18);
  --glow-info: 0 0 8px rgba(0, 98, 184, 0.18);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.6;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

#app {
  max-width: 1440px;
  margin: 0 auto;
  padding: 20px 24px 60px;
  width: 100%;
  box-sizing: border-box;
  flex: 1;
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
  white-space: nowrap;
}

.logo .logo-space { display: inline-block; font-size: 1rem; }

.logo .accent { color: var(--fg-cyan); }

.subtitle {
  color: var(--fg-dim);
  font-size: 12px;
  letter-spacing: 1px;
  margin-top: 8px;
}

@media (max-width: 600px) {
  .logo { font-size: 28px; letter-spacing: 3px; }
  .logo-icon { width: 36px; height: 36px; }
  .logo-row { gap: 10px; }
  header { gap: 8px; }
}

@media (max-width: 400px) {
  .logo { font-size: 22px; letter-spacing: 2px; }
  .logo-icon { width: 28px; height: 28px; }
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
  gap: 0;
  margin-bottom: 20px;
  font-size: 12px;
  position: relative;
}

.filter-bar .label {
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-right: 8px;
  flex-shrink: 0;
}

.scrollable-btns {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
  scroll-behavior: smooth;
}

.scrollable-btns::-webkit-scrollbar { display: none; }

.scroll-arrow {
  display: none;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-dim);
  width: 24px;
  height: 28px;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: var(--radius);
  font-size: 14px;
  z-index: 2;
  transition: color 0.15s, border-color 0.15s;
  padding: 0;
  font-family: var(--font);
}

.scroll-arrow:hover { color: var(--fg-bright); border-color: var(--fg-dim); }

.scroll-arrow.visible { display: flex; }

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
  cursor: pointer;
  vertical-align: baseline;
  position: relative;
}

.user-role-block {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}

.user-role-badge {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--fg-muted);
  background: var(--bg-card-hover);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 2px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.role-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.role-bar-track {
  position: relative;
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(to right, var(--fg-error), var(--fg-warn) 50%, var(--fg-success));
  opacity: 0.85;
}

.role-bar-dot {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--fg-bright);
  border: 2px solid var(--bg-card);
  box-shadow: 0 0 0 1px var(--border);
  transform: translate(-50%, -50%);
}

.role-bar-emoji {
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}

/* ─── Profile Modal: Role Attainment Breakdown ──────────────────────────── */
.profile-role-panel {
  margin: 12px 0 18px;
  padding: 12px 16px;
  background: var(--bg-card-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.profile-role-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 8px;
}

.profile-role-overall-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
}

.profile-sentiment {
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.6;
  margin-bottom: 12px;
}

.profile-sentiment strong {
  color: var(--fg-bright);
}

.profile-role-overall-row {
  margin-bottom: 12px;
}

.profile-metric-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.profile-metric-row:last-child { margin-bottom: 0; }

.profile-metric-label {
  width: 150px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--fg-muted);
  white-space: nowrap;
}

.profile-metric-row .role-bar-track { flex: 1; height: 6px; }

.profile-metric-value {
  width: 70px;
  flex-shrink: 0;
  text-align: right;
  font-size: 11px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.popularity-badge {
  display: inline;
  font-size: 0.85em;
  margin-left: 4px;
  filter: drop-shadow(0 0 4px rgba(255, 200, 0, 0.5));
  cursor: pointer;
  vertical-align: baseline;
}

.fire-popup {
  position: fixed;
  z-index: 2000;
  background: var(--bg);
  border: 1px solid var(--fg-dim);
  border-radius: var(--radius);
  padding: 12px 16px;
  font-size: 12px;
  color: var(--fg);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  max-width: 260px;
  box-shadow: 0 4px 20px var(--shadow);
  line-height: 1.5;
}

.fire-popup.visible {
  opacity: 1;
  pointer-events: auto;
}

.fire-popup-title {
  color: var(--fg-cyan);
  font-weight: 700;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 4px;
}

.fire-popup-value {
  color: var(--fg-bright);
  font-weight: 700;
}

.user-stat .stat-label {
  font-size: 9px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* ─── Repos Tab ──────────────────────────────────────────────────────────── */

.repos-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

.repo-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.repo-card:hover {
  border-color: var(--fg-info);
  box-shadow: var(--glow-info);
}

.repo-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.repo-card-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--fg-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.repo-card-pct {
  font-size: 18px;
  font-weight: 700;
  color: var(--fg-cyan);
  white-space: nowrap;
  margin-left: 8px;
}

.repo-card-bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  margin-bottom: 14px;
  overflow: hidden;
}

.repo-card-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--fg-cyan);
  transition: width 0.3s ease;
}

.repo-card-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.repo-card-contributors {
  margin-top: 12px;
  font-size: 10px;
  color: var(--fg-dim);
  letter-spacing: 0.5px;
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
  background: var(--overlay-backdrop);
  z-index: 1000;
  overflow-y: auto;
  backdrop-filter: blur(4px);
}

.overlay.visible { display: flex; justify-content: center; align-items: flex-start; padding: 40px 20px; }

.profile-panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-width: 960px;
  width: 100%;
  padding: 32px;
  position: relative;
  margin-bottom: 40px;
  flex-shrink: 0;
  min-width: 0;
  overflow-x: hidden;
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
  margin-bottom: 6px;
}

.profile-touchpoints {
  color: var(--fg-dim);
  font-size: 12px;
  margin-bottom: 24px;
}

.profile-touchpoints strong {
  color: var(--fg-muted);
  font-weight: 600;
}

.profile-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr));
  gap: 12px;
  margin-bottom: 28px;
  min-width: 0;
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
  /* min() keeps the track from forcing a 380px floor wider than the panel on
     narrow screens, which pushed the charts outside the modal on mobile. */
  grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr));
  gap: 16px;
  min-width: 0;
}

.profile-chart-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  min-width: 0;
  overflow: hidden;
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
  max-height: none;
  /* The panel clips horizontal overflow, so let the wide nowrap table scroll
     on its own rather than being cut off on narrow screens. */
  overflow-x: auto;
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

.breakdown-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 12px;
  padding: 8px 0;
}

.pager-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  font-family: var(--font);
  font-size: 11px;
  padding: 5px 14px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.pager-btn:hover:not(:disabled) { color: var(--fg-bright); border-color: var(--fg-dim); }
.pager-btn:disabled { opacity: 0.3; cursor: default; }

.pager-info {
  font-size: 11px;
  color: var(--fg-dim);
  letter-spacing: 0.5px;
}

/* ─── Pull Request List ──────────────────────────────────────────────────── */

.pr-list-wrap {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.pr-list-wrap.open {
  /* Roughly 10 rows tall (~36px each) before an inline scrollbar kicks in,
     so the modal doesn't grow unbounded for prolific contributors. */
  max-height: 360px;
  overflow-y: auto;
}

.pr-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.pr-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: var(--fg);
  text-decoration: none;
  transition: background 0.15s;
}

.pr-list-item:hover { background: var(--bg-card-hover); }

.pr-list-title {
  font-size: 12px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.pr-list-meta {
  font-size: 11px;
  color: var(--fg-dim);
  white-space: nowrap;
  flex-shrink: 0;
}

.pr-list-empty {
  font-size: 12px;
  color: var(--fg-dim);
  padding: 10px 0;
}

/* ─── Repository Breakdown Pie Charts ────────────────────────────────────── */

.profile-repo-breakdown {
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}

.repo-pie-grid {
  display: flex;
  justify-content: center;
}

.repo-pie-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  min-width: 0;
}

.repo-pie-box canvas { max-width: 100%; }

.repo-pie-box.repo-pie-score {
  max-width: 380px;
  width: 100%;
}

.repo-pie-label {
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--fg-dim);
  text-align: center;
  margin-bottom: 8px;
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
  display: flex;
  align-items: center;
  gap: 10px;
  scroll-margin-top: 16px;
}

.meth-heading:first-child { margin-top: 8px; }

.meth-subheading {
  color: var(--fg-cyan);
  font-size: 15px;
  font-weight: 500;
  margin: 28px 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  scroll-margin-top: 16px;
}

.meth-anchor-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  opacity: 0.35;
  transition: opacity 0.15s ease;
  flex-shrink: 0;
}

.meth-heading:hover .meth-anchor-btn,
.meth-subheading:hover .meth-anchor-btn,
.meth-anchor-btn:focus {
  opacity: 0.9;
}

.meth-anchor-btn.copied { opacity: 1; }

@keyframes methAnchorFlash {
  0%, 100% { background: transparent; }
  25%, 75% { background: rgba(255, 214, 0, 0.18); }
}

.meth-anchor-flash {
  animation: methAnchorFlash 1.6s ease-in-out;
  border-radius: 4px;
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

/* ─── Chart Full-Screen Modal ────────────────────────────────────────────── */

.chart-expand {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  font-family: var(--font);
  font-size: 12px;
  line-height: 1;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: var(--radius);
  transition: color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.chart-expand:hover { color: var(--fg-bright); border-color: var(--fg-dim); }

/* The distribution panel has no header row, so anchor its button to the corner. */
.dist-section { position: relative; }
.dist-section .chart-expand { position: absolute; top: 18px; right: 20px; }

.overlay-chart.visible {
  align-items: center;
  justify-content: center;
  padding: 3vh 3vw;
  overflow: hidden;
}

.chart-modal {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  width: 94vw;
  height: 90vh;
  padding: 18px 24px 24px;
  display: flex;
  flex-direction: column;
  position: relative;
}

.chart-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  flex-shrink: 0;
}

.chart-modal-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 1.5px;
}

.chart-modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.chart-modal-body > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: auto;
  position: relative;
}

/* ID selectors so these beat the '!important' sizing on .widget-chart canvas
   and .dist-chart-wrap canvas, including inside the max-width:900px query. */
#chart-modal-body canvas {
  width: 100% !important;
  height: 100% !important;
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
    var(--scanline) 2px,
    var(--scanline) 4px
  );
}

/* ─── Theme Toggle ───────────────────────────────────────────────────────── */

.theme-toggle {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 10000;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--fg);
  cursor: pointer;
  box-shadow: 0 2px 6px var(--shadow);
  transition:
    background 0.3s,
    color 0.3s,
    border-color 0.3s,
    box-shadow 0.3s,
    opacity 0.15s;
}

.theme-toggle:hover { opacity: 0.75; }

.theme-toggle svg {
  width: 1.1rem;
  height: 1.1rem;
  display: block;
  user-select: none;
}

/* Show the icon representing the CURRENT theme, matching bjm-www. */
.theme-toggle .icon-sun { display: none; }
html.light-mode .theme-toggle .icon-sun { display: block; }
html.light-mode .theme-toggle .icon-moon { display: none; }

@media print {
  .theme-toggle { display: none; }
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
  .users-grid { grid-template-columns: 1fr; }
  .repos-grid { grid-template-columns: 1fr; }
  .summary-row { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
}

@media (max-width: 500px) {
  .summary-row { grid-template-columns: 1fr 1fr; }
  .nav-btn { padding: 10px 12px; font-size: 11px; letter-spacing: 1px; }
}

/* Mobile: give the profile modal more usable width and stack the role
   report-card rows so every bar renders at the same (full) width instead of
   being squeezed to whatever the fixed-width label leaves behind. */
@media (max-width: 640px) {
  .overlay.visible { padding: 16px 10px; }
  .profile-panel { padding: 20px 16px; }
  .profile-close { top: 10px; right: 12px; }
  .profile-name { font-size: 22px; padding-right: 90px; }

  .profile-role-panel { padding: 12px; }

  .profile-metric-row {
    flex-wrap: wrap;
    gap: 6px 8px;
  }

  /* Full-width label on its own line above the bar. */
  .profile-metric-label {
    width: 100%;
    white-space: normal;
  }

  .profile-metric-value {
    width: auto;
    min-width: 56px;
  }
}

/* ─── Users Sort Bar ─────────────────────────────────────────────────────── */

.users-sort-bar {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 16px;
  font-size: 12px;
  position: relative;
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
  white-space: nowrap;
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

/* The BJM mark ships in white and dark variants; show the readable one. */
.footer-icon-light-theme { display: none; }
html.light-mode .footer-icon-light-theme { display: inline-block; }
html.light-mode .footer-icon-dark-theme { display: none; }

</style>
</head>
<body>
<div id="app">

  <!-- Header -->
  <header>
    <div>
      <div class="logo-row">
        <div class="logo-icon">${logoSvg}</div>
        <div class="logo">Repo<span class="logo-space">&nbsp;</span><span class="accent">Hero</span></div>
      </div>
      <div class="subtitle" id="data-range"></div>
    </div>
  </header>

  <!-- Navigation -->
  <nav class="nav-bar">
    <button class="nav-btn active" data-tab="dashboard" onclick="switchTab('dashboard')">METRICS</button>
    <button class="nav-btn" data-tab="users" onclick="switchTab('users')">USERS</button>
    <button class="nav-btn" data-tab="repos" onclick="switchTab('repos')">REPOS</button>
    <button class="nav-btn" data-tab="methodology" onclick="switchTab('methodology')">METHODOLOGY</button>
  </nav>

  <!-- ═══ Dashboard Tab ═══ -->
  <div class="tab-panel active" id="tab-dashboard">

    <!-- Filter bar -->
    <div class="filter-bar" id="dash-filter-bar">
      <span class="label">Scope:</span>
      <button class="scroll-arrow scroll-left" onclick="scrollBtns(this)" aria-label="Scroll left">◂</button>
      <div class="scrollable-btns">
        <button class="scope-btn active" data-scope="7" onclick="setScope(7)">1W</button>
        <button class="scope-btn" data-scope="14" onclick="setScope(14)">2W</button>
        <button class="scope-btn" data-scope="21" onclick="setScope(21)">3W</button>
        <button class="scope-btn" data-scope="30" onclick="setScope(30)">1M</button>
        <button class="scope-btn" data-scope="60" onclick="setScope(60)">2M</button>
        <button class="scope-btn" data-scope="90" onclick="setScope(90)">3M</button>
        <button class="scope-btn" data-scope="180" onclick="setScope(180)">6M</button>
        <button class="scope-btn" data-scope="365" onclick="setScope(365)">1Y</button>
        <button class="scope-btn" data-scope="ytd" onclick="setScope('ytd')">YTD</button>
        <button class="scope-btn" data-scope="0" onclick="setScope(0)">All</button>
      </div>
      <button class="scroll-arrow scroll-right" onclick="scrollBtns(this)" aria-label="Scroll right">▸</button>
    </div>

    <!-- Summary cards -->
    <div class="summary-row" id="summary-row"></div>

    <!-- Trend widgets -->
    <div class="widget-grid" id="widget-grid"></div>
  </div>

  <!-- ═══ Users Tab ═══ -->
  <div class="tab-panel" id="tab-users">
    <div class="filter-bar" id="users-filter-bar">
      <span class="label">Scope:</span>
      <button class="scroll-arrow scroll-left" onclick="scrollBtns(this)" aria-label="Scroll left">◂</button>
      <div class="scrollable-btns">
        <button class="scope-btn users-scope-btn active" data-scope="7" onclick="setScope(7)">1W</button>
        <button class="scope-btn users-scope-btn" data-scope="14" onclick="setScope(14)">2W</button>
        <button class="scope-btn users-scope-btn" data-scope="21" onclick="setScope(21)">3W</button>
        <button class="scope-btn users-scope-btn" data-scope="30" onclick="setScope(30)">1M</button>
        <button class="scope-btn users-scope-btn" data-scope="60" onclick="setScope(60)">2M</button>
        <button class="scope-btn users-scope-btn" data-scope="90" onclick="setScope(90)">3M</button>
        <button class="scope-btn users-scope-btn" data-scope="180" onclick="setScope(180)">6M</button>
        <button class="scope-btn users-scope-btn" data-scope="365" onclick="setScope(365)">1Y</button>
        <button class="scope-btn users-scope-btn" data-scope="ytd" onclick="setScope('ytd')">YTD</button>
        <button class="scope-btn users-scope-btn" data-scope="0" onclick="setScope(0)">All</button>
      </div>
      <button class="scroll-arrow scroll-right" onclick="scrollBtns(this)" aria-label="Scroll right">▸</button>
    </div>
    <div class="users-sort-bar" id="users-sort-bar">
      <span class="label">Sort by:</span>
      <button class="scroll-arrow scroll-left" onclick="scrollBtns(this)" aria-label="Scroll left">◂</button>
      <div class="scrollable-btns">
        <button class="sort-btn active" data-sort="score" onclick="setUserSort('score')">Score</button>
        <button class="sort-btn" data-sort="commits" onclick="setUserSort('commits')">Commits</button>
        <button class="sort-btn" data-sort="pullRequests" onclick="setUserSort('pullRequests')">PRs</button>
        <button class="sort-btn" data-sort="feedback" onclick="setUserSort('feedback')">Feedback</button>
        <button class="sort-btn" data-sort="approvals" onclick="setUserSort('approvals')">Approvals</button>
${hasIssueResolutions ? `<button class="sort-btn" data-sort="issueResolutions" onclick="setUserSort('issueResolutions')">Issue Resolutions</button>` : ''}
        <button class="sort-btn" data-sort="loc" onclick="setUserSort('loc')">LOC</button>
        <button class="sort-btn" data-sort="filesTouched" onclick="setUserSort('filesTouched')">Files</button>
        <button class="sort-btn" data-sort="churn" onclick="setUserSort('churn')" title="Lower is better">Churn</button>
      </div>
      <button class="scroll-arrow scroll-right" onclick="scrollBtns(this)" aria-label="Scroll right">▸</button>
    </div>
    <div class="users-grid" id="users-grid"></div>

    <!-- Score Distribution -->
    <div class="dist-section" id="dist-section">
      <button class="chart-expand" type="button" title="Expand to full screen" aria-label="Expand chart to full screen" data-chart="dist-chart-wrap" data-title-src="dist-title">&#9974;</button>
      <div class="dist-title" id="dist-title">SCORE DISTRIBUTION</div>
      <div class="dist-subtitle" id="dist-subtitle"></div>
      <div class="dist-chart-wrap" id="dist-chart-wrap">
        <canvas id="dist-chart"></canvas>
      </div>
      <div class="dist-legend" id="dist-legend"></div>
    </div>
  </div>

  <!-- ═══ Repos Tab ═══ -->
  <div class="tab-panel" id="tab-repos">
    <div class="filter-bar" id="repos-filter-bar">
      <span class="label">Scope:</span>
      <button class="scroll-arrow scroll-left" onclick="scrollBtns(this)" aria-label="Scroll left">◂</button>
      <div class="scrollable-btns">
        <button class="scope-btn repos-scope-btn active" data-scope="7" onclick="setScope(7)">1W</button>
        <button class="scope-btn repos-scope-btn" data-scope="14" onclick="setScope(14)">2W</button>
        <button class="scope-btn repos-scope-btn" data-scope="21" onclick="setScope(21)">3W</button>
        <button class="scope-btn repos-scope-btn" data-scope="30" onclick="setScope(30)">1M</button>
        <button class="scope-btn repos-scope-btn" data-scope="60" onclick="setScope(60)">2M</button>
        <button class="scope-btn repos-scope-btn" data-scope="90" onclick="setScope(90)">3M</button>
        <button class="scope-btn repos-scope-btn" data-scope="180" onclick="setScope(180)">6M</button>
        <button class="scope-btn repos-scope-btn" data-scope="365" onclick="setScope(365)">1Y</button>
        <button class="scope-btn repos-scope-btn" data-scope="ytd" onclick="setScope('ytd')">YTD</button>
        <button class="scope-btn repos-scope-btn" data-scope="0" onclick="setScope(0)">All</button>
      </div>
      <button class="scroll-arrow scroll-right" onclick="scrollBtns(this)" aria-label="Scroll right">▸</button>
    </div>
    <div class="repos-grid" id="repos-grid"></div>
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
        score = ${Object.entries(WEIGHTS)
          .filter(([key]) => hasIssueResolutions || key !== 'issueResolutions')
          .map(([key, w]) => {
            const label =
              key === 'loc'
                ? 'LOC'
                : key === 'filesTouched'
                  ? 'Files Touched'
                  : key === 'pullRequests'
                    ? 'Pull Requests'
                    : key === 'predictedPullRequests'
                      ? 'Predicted PRs'
                      : key === 'commits'
                        ? 'Commits'
                        : key === 'feedback'
                          ? 'Feedback'
                          : key === 'approvals'
                            ? 'Approvals'
                            : key === 'issueResolutions'
                              ? 'Issue Resolutions'
                              : key;
            if (w >= 1) return label + ' × ' + w;
            return (
              label +
              ' × ' +
              w
                .toFixed(w < 0.001 ? 4 : 4)
                .replace(/0+$/, '')
                .replace(/\\.$/, '')
            );
          })
          .join(' + ')}
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
            <td>Feedback</td>
            <td class="meth-mono">${WEIGHTS.feedback}</td>
            <td>High weight — actionable feedback (comments and change requests) drives code quality.</td>
          </tr>
          <tr>
            <td>Approvals</td>
            <td class="meth-mono">${WEIGHTS.approvals}</td>
            <td>Moderate-high weight — code reviews approving PRs maintain team velocity.</td>
          </tr>
${
  hasIssueResolutions
    ? `<tr>
            <td>Issue Resolutions</td>
            <td class="meth-mono">${WEIGHTS.issueResolutions}</td>
            <td>Moderate weight — resolved issues capture delivered work that has no PR, but sit below Feedback and PRs because an issue is often resolved by a PR that is already counted.</td>
          </tr>`
    : ''
}
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

      <h2 class="meth-heading">Churn (Negative Metric)</h2>
      <p class="meth-text">
        Churn is the only metric that <em>subtracts</em> from score instead of adding to it, and is
        already netted into the score shown everywhere else in the dashboard. It's computed from a PR
        that was merged, has 1+ reviews, and has at least one approval — a stricter subset than the
        Pull Requests metric above. On the Churn chart and "Sort by" control, <strong>lower is
        better</strong>: it ranks and charts ascending (least churn first), unlike every other metric.
      </p>
      <table class="meth-table">
        <thead>
          <tr><th>Sub-metric</th><th>Weight</th><th>Notes</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>PR Open Duration</td>
            <td class="meth-mono">&minus;${CHURN_WEIGHTS.openDurationDays}</td>
            <td>Per 24hrs a qualifying PR was open (merged_at − created_at).</td>
          </tr>
          <tr>
            <td>Feedback Reviews Received</td>
            <td class="meth-mono">&minus;${CHURN_WEIGHTS.feedbackReviews}</td>
            <td>Per review with changes requested or non-empty comment text on a qualifying PR.</td>
          </tr>
          <tr>
            <td>Non-Bot Comments</td>
            <td class="meth-mono">&minus;${CHURN_WEIGHTS.nonBotComments}</td>
            <td>Per conversation comment (not tied to a review) from a non-bot user.</td>
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
${
  hasIssueResolutions
    ? `
      <h2 class="meth-heading">Issue Resolutions</h2>
      <p class="meth-text">
        Not all delivered work leaves a trace in source control. Support requests, configuration fixes,
        data corrections, and investigations often close a ticket without ever producing a commit.
        <strong>Issue Resolutions</strong> captures that work by counting the issues each contributor
        resolved during a period, pulled from the configured Jira projects.
      </p>

      <h3 class="meth-subheading">What Counts as Resolved</h3>
      <p class="meth-text">
        An issue counts toward a period when it carries a <strong>resolution date inside that period</strong>
        and currently sits in the <strong>Resolved</strong> status category. Using the resolution date — rather
        than the last-updated timestamp — means an issue is credited to the period in which the work
        actually finished, and reopening an issue later does not silently move history.
      </p>
      <div class="meth-formula">
        resolved = statusCategory(Done) AND resolutiondate ∈ [periodStart, periodEnd]
      </div>

      <h3 class="meth-subheading">Who Gets Credit</h3>
      <p class="meth-text">
        Credit goes to the issue's <strong>assignee</strong> at the time it is counted, not the reporter.
      </p>

      <h3 class="meth-subheading">How It Affects Scoring</h3>
      <p class="meth-text">
        Each resolution is worth <strong>${WEIGHTS.issueResolutions}</strong>, placing it below Feedback
        (${WEIGHTS.feedback}) and Pull Requests (${WEIGHTS.pullRequests}), but above Approvals (${WEIGHTS.approvals}).
        That gap is deliberate: a great many issues
        are resolved <em>by</em> a pull request that is already being counted, so weighting resolutions equally
        would double-count the same work. The weight is high enough to make ticket-driven contribution visible,
        but low enough that it cannot outrun sustained engineering output.
      </p>
      <p class="meth-text">
        This metric only appears when Jira is configured. Without it, the dashboard hides Issue Resolutions
        entirely rather than showing a column of zeroes that would misrepresent everyone equally.
      </p>
`
    : ''
}

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
          <tr><td>Pull Requests</td><td>Real PRs merged/opened with 1+ reviews, or predicted PRs when real data is unavailable.</td></tr>
          <tr><td>Feedback</td><td>Pull request reviews that requested changes or added text comments.</td></tr>
          <tr><td>Approvals</td><td>Pull request reviews with approval state.</td></tr>
${hasIssueResolutions ? `<tr><td>Issue Resolutions</td><td>Jira issues resolved in the period, credited to their assignee via the alias map. Captures delivered work that leaves no commit behind.</td></tr>` : ''}
          <tr><td>Commits</td><td>Total git commits authored across all tracked repositories.</td></tr>
          <tr><td>Lines of Code</td><td>Net lines added (insertions − deletions) across all commits.</td></tr>
          <tr><td>Files Touched</td><td>Unique files modified across all commits in the period.</td></tr>
          <tr><td>Churn</td><td>How much friction a user has while delivering code. A score of 0 is perfect.</td></tr>
          <tr><td>Active Contributors</td><td>Unique users with any commits, PRs, feedback, or approvals${hasIssueResolutions ? ', or issue resolutions' : ''} in the scope.</td></tr>
        </tbody>
      </table>
${
  Object.keys(ROLES).length > 0
    ? `
      <h2 class="meth-heading">Team Roles &amp; Targets</h2>
      <p class="meth-text">
        Each configured role defines a <strong>satisfactory</strong> and <strong>goal</strong>
        weekly rate for the metrics tracked below. A user's assigned role is shown on their
        tile in the Users tab, alongside a bar indicating how their current activity compares —
        left of center is below satisfactory (❗), centered through the right edge is satisfactory
        through goal (🙂), and past the right edge means every applicable metric is at or beyond
        goal (🤩). The overall verdict allows a small tolerance below satisfactory (down to -0.25
        on the blended scale) before it's marked Failing, so someone who's strong on most metrics
        with only a minor shortfall elsewhere still reads as Meets Expectations overall — the
        per-metric breakdown in each user's profile still flags that specific shortfall.
      </p>
${Object.entries(ROLES)
  .filter(([, roleDef]) => {
    // Skip roles where every tracked metric is a degenerate 0/0 target —
    // these provide no meaningful satisfactory/goal information and would
    // just render an all-zero table.
    const keys = [
      'pullRequests',
      'feedback',
      'approvals',
      ...(hasIssueResolutions ? ['issueResolutions'] : []),
    ];
    return keys.some(key => {
      const t = roleDef[key];
      return (
        t &&
        ((typeof t.satisfactory === 'number' && t.satisfactory !== 0) ||
          (typeof t.goal === 'number' && t.goal !== 0))
      );
    });
  })
  .map(([roleName, roleDef]) => {
    const metricRows = [
      ['Pull Requests', 'pullRequests'],
      ['Feedback', 'feedback'],
      ['Approvals', 'approvals'],
      ...(hasIssueResolutions
        ? [['Issue Resolutions', 'issueResolutions']]
        : []),
    ]
      .map(([label, key]) => {
        const t = roleDef[key];
        const satisfactory =
          t && typeof t.satisfactory === 'number' ? t.satisfactory : '—';
        const goal = t && typeof t.goal === 'number' ? t.goal : '—';
        return `<tr><td>${label}</td><td class="meth-mono">${satisfactory}</td><td class="meth-mono">${goal}</td></tr>`;
      })
      .join('\n          ');
    return `
      <h3 class="meth-subheading">${roleName}</h3>
      <table class="meth-table">
        <thead>
          <tr><th>Metric</th><th>Satisfactory / wk</th><th>Goal / wk</th></tr>
        </thead>
        <tbody>
          ${metricRows}
        </tbody>
      </table>`;
  })
  .join('\n')}
`
    : ''
}

      <h2 class="meth-heading">⚠ Disclaimer</h2>
      <p class="meth-text" style="opacity:0.85;">
        These scores reflect <strong>${hasIssueResolutions ? 'source control and tracked issue activity only' : 'source control activity only'}</strong> and do not provide a complete
        picture of overall job performance. Many valuable contributions fall outside the scope of this
        tool, including but not limited to: ${hasIssueResolutions ? 'support work that never gets ticketed' : 'handling support ticket requests'}, architectural design work,
        IT tasks such as security reviews or company system management, mentoring, documentation,
        project planning, and cross-team collaboration. Scores should be used as one data point among
        many — not as a sole measure of individual contribution.
      </p>
    </div>
  </div>
</div>

<!-- User Profile Overlay -->
<div class="overlay" id="profile-overlay" onclick="if(event.target===this)closeProfile()">
  <div class="profile-panel" id="profile-panel"></div>
</div>

<!-- Full-Screen Chart Overlay -->
<div class="overlay overlay-chart" id="chart-overlay" onclick="if(event.target===this)closeChartModal()">
  <div class="chart-modal" id="chart-modal">
    <div class="chart-modal-header">
      <span class="chart-modal-title" id="chart-modal-title"></span>
      <button class="profile-close" type="button" onclick="closeChartModal()">&#10005; CLOSE</button>
    </div>
    <div class="chart-modal-body" id="chart-modal-body"></div>
  </div>
</div>

<!-- Theme Toggle -->
<button class="theme-toggle" id="theme-toggle" type="button" title="Switch theme" aria-label="Switch theme">
  <svg class="icon-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>
  <svg class="icon-sun" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM4.22 5.64l1.42-1.42 2.12 2.12-1.41 1.41zM16.24 17.66l1.41-1.41 2.12 2.12-1.41 1.41zM5.64 19.78l-1.42-1.42 2.12-2.12 1.41 1.41zM17.66 7.76l-1.41-1.41 2.12-2.12 1.41 1.41z"/></svg>
</button>

<!-- Footer -->
<footer class="site-footer">
  <div class="footer-inner">
    <a href="https://www.github.com/bmartinson/repo-hero" target="_blank" rel="noopener">
      <svg class="footer-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Feedback &amp; Source
    </a>
    <span class="footer-sep">|</span>
    <a href="https://www.brianmartinson.com" target="_blank" rel="noopener">
      <img class="footer-icon footer-icon-dark-theme" src="data:image/png;base64,${bjmFaviconB64}" alt="BJM">
      <img class="footer-icon footer-icon-light-theme" src="data:image/png;base64,${bjmFaviconDarkB64}" alt="BJM">
      By Brian Martinson
    </a>
  </div>
</footer>

<div id="fire-popup" class="fire-popup">
  <div class="fire-popup-title">🔥 OUTLIER DETECTED</div>
  <div id="fire-popup-body"></div>
</div>

<script>
// ─── Data ───────────────────────────────────────────────────────────────────
window.__REPO_HERO_DATA__ = ${JSON.stringify(dashboardData)};

(function() {
  'use strict';

  const DATA = window.__REPO_HERO_DATA__;
  const GENERATED_AT = '${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}';
  const ALL_PERIODS = DATA.periods; // [{id, startDate, endDate}, ...]
  const ALL_PERIOD_IDS = ALL_PERIODS.map(p => p.id);
  const HAS_ISSUE_RESOLUTIONS = !!DATA.hasIssueResolutions;
  const METRICS = [
    { key: 'score',        label: 'Score',         color: '#00ddcc', format: v => v.toFixed(0) },
    { key: 'effectivePRs', label: 'Pull Requests',  color: '#00aaff', format: v => v.toFixed(0), dataKey: 'effectivePR' },
    { key: 'feedback',     label: 'Feedback',       color: '#cc66ff', format: v => v.toFixed(0) },
    { key: 'approvals',    label: 'Approvals',      color: '#00d084', format: v => v.toFixed(0) },
${hasIssueResolutions ? `    { key: 'issueResolutions', label: 'Issue Resolutions', color: '#4477ff', format: v => v.toFixed(0) },` : ''}
    { key: 'commits',      label: 'Commits',        color: '#22cc44', format: v => v.toFixed(0) },
    { key: 'loc',          label: 'Lines of Code',  color: '#ff8844', format: v => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0) },
    { key: 'filesTouched', label: 'Files Touched',  color: '#ffaa00', format: v => v.toFixed(0) },
    // Churn is repo-hero's only "negative" metric — lower is better, so every
    // ranking/sort/leaderboard for this key must invert direction (see
    // lowerIsBetter checks throughout).
    { key: 'churn',        label: 'Churn',          color: '#ff4d6d', format: v => v.toFixed(1), lowerIsBetter: true },
  ];

  // ─── Theming ───────────────────────────────────────────────────────────
  // Per-theme override for the fixed METRICS accent colors. The dark values on
  // METRICS are bright neons that wash out against a white background.
  const METRIC_LIGHT_COLORS = {
    score: '#00807a',
    effectivePRs: '#0069c2',
    feedback: '#7b2ecc',
    approvals: '#059669',
    issueResolutions: '#2f52c9',
    commits: '#0f8a35',
    loc: '#c2521a',
    filesTouched: '#a86b00',
    churn: '#c22b47',
  };

  function metricColor(m) {
    return currentTheme === 'light' ? METRIC_LIGHT_COLORS[m.key] || m.color : m.color;
  }

  // Chart.js cannot read CSS custom properties, so chart "chrome" colors are
  // mirrored here per theme and re-applied whenever the theme changes.

  const PALETTES = {
    dark:  ['#00ddcc','#00aaff','#cc66ff','#22cc44','#ff8844','#ffaa00','#ff3333','#88ff88','#ff66aa','#aaddff'],
    light: ['#00807a','#0069c2','#7b2ecc','#0f8a35','#c2521a','#a86b00','#c62828','#2e9e4f','#c2367d','#3d7ea6'],
  };

  const PIE_PALETTES = {
    dark:  ['#00ddcc','#00aaff','#cc66ff','#22cc44','#ff8844','#ffaa00','#ff3333','#88ff88','#ff66aa','#aaddff','#ff9999','#66ffcc','#bb88ff','#ffcc00','#44ddff','#ff6666','#99ff99','#dd88ff','#ffdd44','#88ccff'],
    light: ['#00807a','#0069c2','#7b2ecc','#0f8a35','#c2521a','#a86b00','#c62828','#2e9e4f','#c2367d','#3d7ea6','#b5484a','#0d8f7a','#6b3fb5','#9a7400','#0f7fa6','#b03a3a','#3f8f4a','#8a3fb5','#96760d','#2f6f9e'],
  };

  const CHART_THEME = {
    dark: {
      tick: '#777777', tickDim: '#555555', border: '#2a2a2a',
      grid: '#1a1a1a', gridSoft: 'rgba(255,255,255,0.04)',
      tooltipBg: '#1a1a1a', tooltipBorder: '#333333',
      tooltipTitle: '#e6edf3', tooltipBody: '#b0b8c4',
      legendText: '#b0b8c4',
      pieTooltipBg: '#161b22', pieTooltipTitle: '#e6edf3',
      pieTooltipBody: '#b0b8c4', pieTooltipBorder: '#30363d',
      pieBorder: '#0d1117',
      curve: 'rgba(255,255,255,0.5)',
      annMean: 'rgba(255,255,255,0.4)', annMeanLabel: 'rgba(255,255,255,0.7)',
      annSd: 'rgba(255,255,255,0.15)', annSdLabel: 'rgba(255,255,255,0.35)',
      annLabelBg: 'rgba(0,0,0,0.6)',
      distTooltipBg: 'rgba(0,0,0,0.85)', distTooltipBorder: 'rgba(255,255,255,0.1)',
      distTooltipTitle: '#e6edf3', distTooltipBody: '#b0b8c4',
      rank: ['rgba(255,170,0,0.15);color:#ffaa00','rgba(200,200,200,0.1);color:#cccccc','rgba(205,127,50,0.12);color:#cd7f32'],
      rankRest: 'background:rgba(85,85,85,0.15);color:var(--fg-dim)',
    },
    light: {
      tick: '#5c636d', tickDim: '#7c838d', border: '#d9dde3',
      grid: '#e6e9ee', gridSoft: 'rgba(0,0,0,0.06)',
      tooltipBg: '#ffffff', tooltipBorder: '#c9cfd7',
      tooltipTitle: '#0b0d10', tooltipBody: '#2b2f36',
      legendText: '#2b2f36',
      pieTooltipBg: '#ffffff', pieTooltipTitle: '#0b0d10',
      pieTooltipBody: '#2b2f36', pieTooltipBorder: '#c9cfd7',
      pieBorder: '#ffffff',
      curve: 'rgba(20,25,35,0.45)',
      annMean: 'rgba(20,25,35,0.45)', annMeanLabel: 'rgba(20,25,35,0.75)',
      annSd: 'rgba(20,25,35,0.18)', annSdLabel: 'rgba(20,25,35,0.4)',
      annLabelBg: 'rgba(255,255,255,0.85)',
      distTooltipBg: 'rgba(255,255,255,0.95)', distTooltipBorder: 'rgba(0,0,0,0.12)',
      distTooltipTitle: '#0b0d10', distTooltipBody: '#2b2f36',
      rank: ['rgba(154,97,0,0.15);color:#9a6100','rgba(90,98,110,0.14);color:#5c636d','rgba(150,90,35,0.15);color:#8a5320'],
      rankRest: 'background:rgba(120,128,138,0.14);color:var(--fg-dim)',
    },
  };

  let currentTheme = window.__RH_THEME === 'light' ? 'light' : 'dark';
  function chartColors() { return PALETTES[currentTheme]; }
  function pieColors() { return PIE_PALETTES[currentTheme]; }
  function CT() { return CHART_THEME[currentTheme]; }

  const SCORE_WEIGHTS = ${JSON.stringify(WEIGHTS)};
  const CHURN_WEIGHTS = ${JSON.stringify(CHURN_WEIGHTS)};
  const ROLES = ${JSON.stringify(ROLES)};
  const USER_ROLES = ${JSON.stringify(USER_ROLES)};
  const USER_END_DATES = ${JSON.stringify(USER_END_DATES)};

  function repoScore(rb) {
    const prs = rb.pullRequests || 0;
    return (rb.loc || 0) * SCORE_WEIGHTS.loc
      + (rb.filesTouched || 0) * SCORE_WEIGHTS.filesTouched
      + prs * SCORE_WEIGHTS.pullRequests
      + (rb.commits || 0) * SCORE_WEIGHTS.commits
      + (rb.feedback || 0) * SCORE_WEIGHTS.feedback
      + (rb.approvals || 0) * SCORE_WEIGHTS.approvals;
  }

  // Composite churn value from the raw sub-metric totals. Mirrors
  // calculateChurn() in score.js — kept in sync manually since the sub-metric
  // fields (not the pre-computed composite) are what's persisted per period.
  function calculateChurnValue(totals) {
    return (totals.churnOpenDurationDays || 0) * CHURN_WEIGHTS.openDurationDays
      + (totals.churnFeedbackReviews || 0) * CHURN_WEIGHTS.feedbackReviews
      + (totals.churnNonBotComments || 0) * CHURN_WEIGHTS.nonBotComments;
  }

  let currentScope = 7; // days (0 = all)
  let currentSort = 'score';
  let charts = {};
  let profileCharts = {};
  let distChart = null;
  let userColorMap = {}; // name → color (stable across metrics)
  let breakdownState = null; // { periods, userName, ud, totals, page }
  const BREAKDOWN_PAGE_SIZE = 100;

  // Build a stable user→color map from score-ranked users so the same
  // person keeps the same color regardless of their rank in each metric.
  function buildUserColorMap(periods) {
    const scored = Object.keys(DATA.users).map(name => ({
      name,
      value: getUserTotals(name, periods).score,
    }));
    scored.sort((a, b) => b.value - a.value);
    const map = {};
    scored.forEach((u, i) => {
      map[u.name] = chartColors()[i % chartColors().length];
    });
    return map;
  }

  function getUserColor(name) {
    return userColorMap[name] || chartColors()[0];
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  function parseDate(str) { return new Date(str + 'T00:00:00'); }
  function formatPRDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getScopedPeriods() {
    if (ALL_PERIODS.length === 0) return [];
    if (currentScope === 0) return ALL_PERIOD_IDS; // All time

    // YTD: from Jan 1 of the latest period's year through end
    if (currentScope === 'ytd') {
      const latest = parseDate(ALL_PERIODS[ALL_PERIODS.length - 1].endDate);
      const jan1 = new Date(latest.getFullYear(), 0, 1);
      return ALL_PERIODS
        .filter(p => parseDate(p.startDate) >= jan1)
        .map(p => p.id);
    }

    const latest = parseDate(ALL_PERIODS[ALL_PERIODS.length - 1].endDate);
    const cutoff = new Date(latest);
    cutoff.setDate(cutoff.getDate() - currentScope);

    return ALL_PERIODS
      .filter(p => parseDate(p.endDate) > cutoff)
      .map(p => p.id);
  }

  function formatPeriodLabel(periodId) {
    const p = ALL_PERIODS.find(x => x.id === periodId);
    if (!p) return periodId;
    const s = parseDate(p.startDate);
    const e = parseDate(p.endDate);
    const span = daysBetween(s, e);
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const yr = " '" + String(s.getFullYear()).slice(2);
    if (span <= 7) {
      return mo[s.getMonth()] + ' ' + s.getDate() + yr;
    } else if (span <= 31) {
      return mo[s.getMonth()] + yr;
    } else {
      // Yearly or custom: "2024"
      return String(s.getFullYear());
    }
  }

  function getUserTotals(userName, periods) {
    const ud = DATA.users[userName];
    if (!ud) return { score:0, commits:0, pullRequests:0, predictedPullRequests:0, effectivePRs:0, feedback:0, approvals:0, issueResolutions:0, loc:0, filesTouched:0, churnOpenDurationDays:0, churnFeedbackReviews:0, churnNonBotComments:0, churn:0 };
    const totals = { score:0, commits:0, pullRequests:0, predictedPullRequests:0, effectivePRs:0, feedback:0, approvals:0, issueResolutions:0, loc:0, filesTouched:0, churnOpenDurationDays:0, churnFeedbackReviews:0, churnNonBotComments:0 };
    periods.forEach(p => {
      const d = ud.data[p];
      if (d) {
        totals.score += d.score;
        totals.commits += d.commits;
        totals.pullRequests += d.pullRequests;
        totals.predictedPullRequests += d.predictedPullRequests || 0;
        totals.effectivePRs += d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
        totals.feedback += d.feedback || 0;
        totals.approvals += d.approvals || 0;
        totals.issueResolutions += d.issueResolutions || 0;
        totals.loc += d.loc;
        totals.filesTouched += d.filesTouched;
        totals.churnOpenDurationDays += d.churnOpenDurationDays || 0;
        totals.churnFeedbackReviews += d.churnFeedbackReviews || 0;
        totals.churnNonBotComments += d.churnNonBotComments || 0;
      }
    });
    totals.churn = calculateChurnValue(totals);
    return totals;
  }

  // ─── Team Roles / Attainment ─────────────────────────────────────────────
  // Entirely optional: only produces output when the user has an assigned
  // role (USER_ROLES) that matches a defined role (ROLES). Thresholds in
  // config.json are expressed as weekly rates, so scoped totals are first
  // normalized to a weekly rate using the span of the currently selected
  // periods before being compared.

  const ROLE_ATTAINMENT_METRICS = ['score', 'pullRequests', 'feedback', 'approvals', 'issueResolutions'];

  // DATA.users keys are lowercase canonical names (e.g. "nick pasto"), but
  // USER_ROLES keys come straight from config.json in their original
  // capitalization (e.g. "Nick Pasto") to match the "aliases" keys there.
  // Build a lowercase-keyed lookup once so the two line up regardless of case.
  const USER_ROLES_LC = {};
  Object.keys(USER_ROLES).forEach(name => {
    USER_ROLES_LC[name.toLowerCase()] = USER_ROLES[name];
  });

  // Explicit, opt-in end dates for departed/offboarded contributors (canonical
  // name -> "YYYY-MM-DD"). Deliberately NOT inferred from trailing silence —
  // a quiet stretch near the end of a scope is ambiguous (left vs. still here
  // but coasting), so only users named here get their evaluation window
  // clamped early; everyone else is judged through the scope's actual end.
  const USER_END_DATES_LC = {};
  Object.keys(USER_END_DATES).forEach(name => {
    USER_END_DATES_LC[name.toLowerCase()] = USER_END_DATES[name];
  });

  // Earliest period (across ALL history, not just the current scope) where a
  // user shows any tracked activity — their "first touch point". Used to keep
  // the weekly-rate normalization below fair for users who joined partway
  // through the currently selected scope (e.g. a new hire viewed over YTD
  // shouldn't have their totals divided by months they weren't here for).
  const _firstActivityCache = new Map();
  function getUserFirstActivityDate(userName) {
    if (_firstActivityCache.has(userName)) return _firstActivityCache.get(userName);
    const ud = DATA.users[userName];
    let result = null;
    if (ud) {
      for (const p of ALL_PERIODS) { // ALL_PERIODS is sorted ascending by startDate
        const d = ud.data[p.id];
        if (d && (
          (d.score || 0) > 0 || (d.commits || 0) > 0 || (d.pullRequests || 0) > 0 ||
          (d.predictedPullRequests || 0) > 0 || (d.feedback || 0) > 0 || (d.approvals || 0) > 0 ||
          (d.issueResolutions || 0) > 0 || (d.loc || 0) > 0 || (d.filesTouched || 0) > 0
        )) {
          result = parseDate(p.startDate);
          break;
        }
      }
    }
    _firstActivityCache.set(userName, result);
    return result;
  }

  // Mirror of getUserFirstActivityDate() for the *last* tracked activity
  // (across ALL history, not just the current scope) — the end date of the
  // most recent period where the user shows any activity. Used to show
  // "first touch point" / "last touch point" dates in the profile modal.
  const _lastActivityCache = new Map();
  function getUserLastActivityDate(userName) {
    if (_lastActivityCache.has(userName)) return _lastActivityCache.get(userName);
    const ud = DATA.users[userName];
    let result = null;
    if (ud) {
      for (let i = ALL_PERIODS.length - 1; i >= 0; i--) { // ALL_PERIODS is sorted ascending by startDate
        const p = ALL_PERIODS[i];
        const d = ud.data[p.id];
        if (d && (
          (d.score || 0) > 0 || (d.commits || 0) > 0 || (d.pullRequests || 0) > 0 ||
          (d.predictedPullRequests || 0) > 0 || (d.feedback || 0) > 0 || (d.approvals || 0) > 0 ||
          (d.issueResolutions || 0) > 0 || (d.loc || 0) > 0 || (d.filesTouched || 0) > 0
        )) {
          result = parseDate(p.endDate);
          break;
        }
      }
    }
    _lastActivityCache.set(userName, result);
    return result;
  }

  function toISODateString(d) {
    if (!d || isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Returns { weeks, effectiveEnd } — effectiveEnd is only set (non-null) when
  // the trailing window was clamped by an explicit userEndDates entry, so
  // callers can surface it for tooltip transparency.
  function getWeeksInScope(userName, periods) {
    if (!periods || periods.length === 0) return { weeks: 1, effectiveEnd: null };
    let minStart = null;
    let maxEnd = null;
    periods.forEach(pid => {
      const p = ALL_PERIODS.find(x => x.id === pid);
      if (!p) return;
      const s = parseDate(p.startDate);
      const e = parseDate(p.endDate);
      if (minStart === null || s < minStart) minStart = s;
      if (maxEnd === null || e > maxEnd) maxEnd = e;
    });
    if (minStart === null || maxEnd === null) return { weeks: 1, effectiveEnd: null };

    // Clamp the effective start forward to the user's first touch point when
    // it falls later than the scope start, so someone who joined partway
    // through the window isn't penalized for weeks they weren't active.
    const firstActivity = getUserFirstActivityDate(userName);
    const effectiveStart = firstActivity && firstActivity > minStart ? firstActivity : minStart;

    // Clamp the effective end backward to an explicit, opt-in departure date
    // when one is configured and it falls before the scope end — so time
    // after someone left doesn't keep silently deflating their rate.
    let effectiveEnd = maxEnd;
    let clampedEnd = null;
    const endDateStr = USER_END_DATES_LC[String(userName).toLowerCase()];
    if (endDateStr) {
      const parsedEnd = parseDate(endDateStr);
      if (!isNaN(parsedEnd) && parsedEnd < maxEnd) {
        effectiveEnd = parsedEnd < effectiveStart ? effectiveStart : parsedEnd;
        clampedEnd = endDateStr;
      }
    }

    const days = Math.max(daysBetween(effectiveStart, effectiveEnd), 1);
    return { weeks: Math.max(days / 7, 1), effectiveEnd: clampedEnd };
  }

  // Human-readable labels for the role-attainment metric keys — used both
  // for the profile modal's per-metric breakdown and its sentiment summary.
  const ROLE_METRIC_LABELS = { score: 'Score', pullRequests: 'Pull Requests', feedback: 'Feedback', approvals: 'Approvals', issueResolutions: 'Issue Resolutions' };

  // Shared thresholds so the tile bar, profile overall bar, and profile
  // per-metric bars all agree on what counts as Failing/Meets/Exceeding.
  // Per-metric categorization stays strict at 0 (a specific metric is either
  // at/above its satisfactory rate or it isn't). The blended overall score
  // gets a small tolerance band below 0 (see OVERALL_MEETS_TOLERANCE) so a
  // user who's strong on some metrics and only slightly short on others
  // isn't tipped into "Failing" overall by minor shortfalls averaging out.
  function categorizeAttainment(position) {
    if (position < 0) return { category: 'Failing', emoji: '❗' };
    if (position < 1) return { category: 'Meets Expectations', emoji: '🙂' };
    return { category: 'Exceeding', emoji: '🤩' };
  }

  // How far below 0 the blended overall score can fall and still count as
  // "Meets Expectations" rather than "Failing" — e.g. mostly-strong metrics
  // with one modest shortfall shouldn't tip the overall verdict to Failing.
  const OVERALL_MEETS_TOLERANCE = -0.25;
  function categorizeOverallAttainment(overall) {
    if (overall < OVERALL_MEETS_TOLERANCE) return { category: 'Failing', emoji: '❗' };
    if (overall < 1) return { category: 'Meets Expectations', emoji: '🙂' };
    return { category: 'Exceeding', emoji: '🤩' };
  }

  function getRoleAttainment(userName, totals, periods) {
    const roleName = USER_ROLES_LC[String(userName).toLowerCase()];
    if (!roleName) return null;
    const roleDef = ROLES[roleName];
    if (!roleDef) return { role: roleName, overall: null, barPercent: null, category: null, emoji: null, evaluatedThrough: null, metrics: {} };

    const { weeks, effectiveEnd } = getWeeksInScope(userName, periods);
    const values = {
      score: totals.score,
      pullRequests: totals.effectivePRs,
      feedback: totals.feedback,
      approvals: totals.approvals,
      issueResolutions: totals.issueResolutions,
    };

    const positions = [];
    const metrics = {};
    ROLE_ATTAINMENT_METRICS.forEach(metric => {
      if (metric === 'issueResolutions' && !HAS_ISSUE_RESOLUTIONS) return;
      const target = roleDef[metric];
      if (!target || typeof target.satisfactory !== 'number' || typeof target.goal !== 'number') return;
      const { satisfactory, goal } = target;
      if (goal === satisfactory) return; // avoid divide-by-zero on a degenerate config
      const weeklyValue = (values[metric] || 0) / weeks;
      const position = (weeklyValue - satisfactory) / (goal - satisfactory);
      positions.push(position);
      const cat = categorizeAttainment(position);
      metrics[metric] = {
        position,
        barPercent: 50 + Math.max(-1, Math.min(1, position)) * 50,
        weeklyValue, satisfactory, goal,
        category: cat.category, emoji: cat.emoji,
      };
    });

    if (positions.length === 0) return { role: roleName, overall: null, barPercent: null, category: null, emoji: null, evaluatedThrough: null, metrics };

    const overall = positions.reduce((a, b) => a + b, 0) / positions.length;
    const barPercent = 50 + Math.max(-1, Math.min(1, overall)) * 50;
    const overallCat = categorizeOverallAttainment(overall);

    return { role: roleName, overall, barPercent, category: overallCat.category, emoji: overallCat.emoji, evaluatedThrough: effectiveEnd, metrics };
  }

  // Builds a short, plain-language summary sentence (e.g. "🤩 Excelling in
  // Pull Requests. 🙂 On track with Reviews. ❗ Falling behind in Score.")
  // from a getRoleAttainment() result's per-metric breakdown.
  function buildSentimentSummary(attainment) {
    if (!attainment || !attainment.role || attainment.overall === null) return '';
    const exceeding = [], meeting = [], failing = [];
    Object.keys(attainment.metrics).forEach(key => {
      const m = attainment.metrics[key];
      const label = ROLE_METRIC_LABELS[key] || key;
      if (m.category === 'Exceeding') exceeding.push(label);
      else if (m.category === 'Failing') failing.push(label);
      else meeting.push(label);
    });
    const parts = [];
    if (exceeding.length) parts.push('🤩 <strong>Excelling</strong> in ' + exceeding.join(', ') + '.');
    if (meeting.length) parts.push('🙂 <strong>On track</strong> with ' + meeting.join(', ') + '.');
    if (failing.length) parts.push('❗ <strong>Falling behind</strong> in ' + failing.join(', ') + '.');
    return parts.join(' ');
  }

  function getTopUsers(metricKey, periods, limit) {
    const metricDef = METRICS.find(m => m.key === metricKey);
    const lowerIsBetter = !!(metricDef && metricDef.lowerIsBetter);
    const userNames = Object.keys(DATA.users);
    const scored = userNames.map(name => {
      const totals = getUserTotals(name, periods);
      return { name, value: totals[metricKey], score: totals.score };
    });
    // Normal metrics: only rank users with a positive value, highest first.
    // Churn (lowerIsBetter): 0 is the best possible value, so it's kept on
    // the leaderboard — only drop a user when they have BOTH 0 churn and
    // 0 score, since that combination means there's nothing meaningful to
    // rank (no real activity at all), not a "perfect" churn score.
    const filtered = lowerIsBetter
      ? scored.filter(u => !(u.value === 0 && u.score === 0))
      : scored.filter(u => u.value > 0);
    filtered.sort((a, b) => lowerIsBetter ? a.value - b.value : b.value - a.value);
    return filtered.slice(0, limit);
  }

  // Compute positive outliers: users > mean + 1.5*stdDev for each metric
  function computeOutliers(periods) {
    const userNames = Object.keys(DATA.users);
    const allTotals = userNames.map(name => ({ name, totals: getUserTotals(name, periods) }));
    const active = allTotals.filter(u => u.totals.score > 0);
    if (active.length < 3) return {};

    const outliers = {};
    // Churn is lowerIsBetter — a high value is bad, not a 🔥-worthy positive
    // outlier, so it's excluded from this "exceeding expectations" detector.
    const metricKeys = METRICS.filter(m => !m.lowerIsBetter).map(m => m.key);

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
    if (filtered.length === 0) return { teamScore:0, activeUsers:0, totalPullRequests:0, totalFeedback:0, totalApprovals:0, totalCommits:0 };
    const avg = (key) => filtered.reduce((s,t) => s + t[key], 0) / filtered.length;

    // Count unique users who had any activity across all scoped periods
    const activeSet = new Set();
    let totalFeedback = 0;
    let totalApprovals = 0;
    Object.keys(DATA.users).forEach(name => {
      const ud = DATA.users[name];
      for (const pid of periods) {
        const d = ud.data[pid];
        if (d) {
          totalFeedback += d.feedback || 0;
          totalApprovals += d.approvals || 0;
          if (d.commits > 0 || d.pullRequests > 0 || (d.feedback || 0) > 0 || (d.approvals || 0) > 0) {
            activeSet.add(name);
          }
        }
      }
    });

    return {
      teamScore: avg('teamScore'),
      activeUsers: activeSet.size,
      totalPullRequests: filtered.reduce((s,t) => s + t.totalPullRequests, 0),
      totalFeedback,
      totalApprovals,
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

  Chart.defaults.color = CT().tick;
  Chart.defaults.borderColor = CT().border;
  // Chart.js defaults tooltip text to white, which is invisible on the light theme.
  Chart.defaults.plugins.tooltip.titleColor = CT().tooltipTitle;
  Chart.defaults.plugins.tooltip.bodyColor = CT().tooltipBody;
  Chart.defaults.plugins.tooltip.footerColor = CT().tooltipBody;
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
            backgroundColor: CT().tooltipBg,
            borderColor: CT().tooltipBorder,
            titleColor: CT().tooltipTitle,
            bodyColor: CT().tooltipBody,
            borderWidth: 1,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            callbacks: yFormat ? { label: ctx => ctx.dataset.label + ': ' + yFormat(ctx.parsed.y) } : {}
          }
        },
        scales: {
          x: { grid: { color: CT().grid }, ticks: { maxRotation: 45, font: { size: 10 } } },
          y: { grid: { color: CT().grid }, ticks: { callback: yFormat || (v => v), font: { size: 10 } }, beginAtZero: true }
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
            backgroundColor: CT().tooltipBg,
            borderColor: CT().tooltipBorder,
            titleColor: CT().tooltipTitle,
            bodyColor: CT().tooltipBody,
            borderWidth: 1,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            callbacks: yFormat
              ? { label: ctx => yFormat(ctx.parsed.y) }
              : {}
          }
        },
        scales: {
          x: { grid: { color: CT().grid }, ticks: { maxRotation: 35, font: { size: 10 } } },
          y: { grid: { color: CT().grid }, ticks: { callback: yFormat || (v => v), font: { size: 10 } }, beginAtZero: true }
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
    if (currentScope === 'ytd' && ALL_PERIODS.length > 0) {
      // YTD comparison: same Jan 1 – same day-of-year from previous year
      const latest = parseDate(ALL_PERIODS[ALL_PERIODS.length - 1].endDate);
      const prevYearJan1 = new Date(latest.getFullYear() - 1, 0, 1);
      const prevYearSameDay = new Date(latest.getFullYear() - 1, latest.getMonth(), latest.getDate());
      prevPeriods = ALL_PERIODS
        .filter(p => {
          const s = parseDate(p.startDate);
          return s >= prevYearJan1 && s <= prevYearSameDay;
        })
        .map(p => p.id);
    } else if (currentScope > 0 && ALL_PERIODS.length > 0) {
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
      { label: 'Total Feedback', value: summary.totalFeedback, prev: prevSummary.totalFeedback, fmt: formatNum },
      { label: 'Total Approvals', value: summary.totalApprovals, prev: prevSummary.totalApprovals, fmt: formatNum },
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
          + '<div class="widget-header"><span class="widget-title" id="widget-title-' + m.key + '">' + m.label + ' Trends</span>'
            + '<button class="chart-expand" type="button" title="Expand to full screen" aria-label="Expand chart to full screen" data-chart="chart-wrap-' + m.key + '" data-title-src="widget-title-' + m.key + '">&#9974;</button>'
          + '</div>'
          + '<div class="widget-body">'
            + '<div class="widget-chart" id="chart-wrap-' + m.key + '"><canvas id="chart-' + m.key + '"></canvas></div>'
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
        // Bar chart: all active users sorted by value descending, on x-axis.
        // Churn is lowerIsBetter, so it's ranked ascending (lowest churn
        // first / best). A user is only dropped when they have BOTH 0 churn
        // and 0 score (nothing meaningful to rank) — a 0-churn user with a
        // real score stays on the chart since that's a genuinely good result.
        const allUsers = Object.keys(DATA.users)
          .map(name => {
            const totals = getUserTotals(name, periods);
            const value = metric.key === 'effectivePRs' ? totals.effectivePRs : (totals[metric.key] || 0);
            return { name, value, score: totals.score };
          })
          .filter(u => metric.lowerIsBetter ? !(u.value === 0 && u.score === 0) : u.value > 0)
          .sort((a, b) => metric.lowerIsBetter ? a.value - b.value : b.value - a.value);

        const userLabels = allUsers.map(u => u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '));
        const values = allUsers.map(u => u.value);
        const colors = allUsers.map(u => getUserColor(u.name));

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
          const color = getUserColor(user.name);
          return {
            label: user.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
            data: periods.map(p => {
              const d = ud.data[p];
              if (!d) return 0;
              if (metric.key === 'effectivePRs') return d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
              if (metric.key === 'churn') return calculateChurnValue(d);
              return d[metric.key] || 0;
            }),
            borderColor: color,
            backgroundColor: color + '15',
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

    // Churn is lowerIsBetter — lowest churn ranks first when sorted by it.
    const currentSortMetric = METRICS.find(m => m.key === currentSort);
    const sortAscending = !!(currentSortMetric && currentSortMetric.lowerIsBetter);
    usersWithTotals.sort((a, b) => sortAscending
      ? a.totals[currentSort] - b.totals[currentSort]
      : b.totals[currentSort] - a.totals[currentSort]);

    // Filter to users with any activity
    const active = usersWithTotals.filter(u => u.totals.score > 0);

    // Compute positive outliers
    const outliers = computeOutliers(periods);

    const grid = document.getElementById('users-grid');
    grid.innerHTML = active.map((u, i) => {
      const t = u.totals;
      const o = outliers[u.name] || {};
      const displayName = u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      const rankColors = CT().rank;
      const rankStyle = i < 3 ? 'background:' + rankColors[i] : CT().rankRest;
      const fire = (key) => o[key] ? '<span class="fire-badge" onclick="event.stopPropagation();showFirePopup(event,\\'' + key + '\\',+' + o[key].zScore + ')">🔥</span>' : '';

      const attainment = getRoleAttainment(u.name, t, periods);
      let roleBlock = '';
      if (attainment && attainment.role) {
        const roleLabel = escapeHtml(attainment.role);
        const tooltip = attainment.category
          ? attainment.category + (attainment.evaluatedThrough ? ' (evaluated through ' + attainment.evaluatedThrough + ')' : '')
          : '';
        const bar = attainment.barPercent === null ? '' :
          '<div class="role-bar-row">'
            + '<div class="role-bar-track" title="' + escapeHtml(tooltip) + '">'
              + '<div class="role-bar-dot" style="left:' + attainment.barPercent.toFixed(1) + '%"></div>'
            + '</div>'
            + '<span class="role-bar-emoji" title="' + escapeHtml(tooltip) + '">' + attainment.emoji + '</span>'
          + '</div>';
        roleBlock = '<div class="user-role-block">'
          + '<span class="user-role-badge">' + roleLabel + '</span>'
          + bar
        + '</div>';
      }

      return '<div class="user-card" onclick="openProfile(\\'' + u.name.replace(/'/g, "\\\\'") + '\\')">'
        + '<div class="user-card-header">'
          + '<span class="user-card-name">' + displayName + '</span>'
          + '<span class="user-card-rank" style="' + rankStyle + '">#' + (i + 1) + '</span>'
        + '</div>'
        + '<div class="user-card-stats">'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.score) + fire('score') + '</div><div class="stat-label">Score</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.commits) + fire('commits') + '</div><div class="stat-label">Commits</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.effectivePRs) + fire('effectivePRs') + '</div><div class="stat-label">PRs</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.feedback) + fire('feedback') + '</div><div class="stat-label">Feedback</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.approvals) + fire('approvals') + '</div><div class="stat-label">Approvals</div></div>'
          + (HAS_ISSUE_RESOLUTIONS ? '<div class="user-stat"><div class="stat-value">' + formatNum(t.issueResolutions) + fire('issueResolutions') + '</div><div class="stat-label">Issue Res.</div></div>' : '')
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.loc) + fire('loc') + '</div><div class="stat-label">LOC</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(t.filesTouched) + fire('filesTouched') + '</div><div class="stat-label">Files</div></div>'
          + roleBlock
        + '</div>'
      + '</div>';
    }).join('');

    // ─── Score Distribution Chart ────────────────────────────────────────
    lastActiveUsers = active;
    renderDistribution(active, sortKeyToDistMetric(currentSort));
  }

  // ─── Repos Tab ──────────────────────────────────────────────────────────

  function renderRepos() {
    const periods = getScopedPeriods();
    const repoTotals = {};

    // Aggregate all user contributions per repo across scoped periods
    for (const [userName, u] of Object.entries(DATA.users)) {
      periods.forEach(pid => {
        const d = u.data[pid];
        if (!d || !d.repoBreakdown) return;
        for (const [repo, rb] of Object.entries(d.repoBreakdown)) {
          if (!repoTotals[repo]) repoTotals[repo] = { pullRequests: 0, feedback: 0, approvals: 0, commits: 0, loc: 0, filesTouched: 0, contributors: new Set() };
          repoTotals[repo].pullRequests += rb.pullRequests || 0;
          repoTotals[repo].feedback += rb.feedback || 0;
          repoTotals[repo].approvals += rb.approvals || 0;
          repoTotals[repo].commits += rb.commits || 0;
          repoTotals[repo].loc += rb.loc || 0;
          repoTotals[repo].filesTouched += rb.filesTouched || 0;
          if ((rb.pullRequests || 0) + (rb.feedback || 0) + (rb.approvals || 0) + (rb.commits || 0) > 0) {
            repoTotals[repo].contributors.add(userName);
          }
        }
      });
    }

    // Compute a weighted contribution score per repo (same weights as user scoring)
    const repoList = Object.entries(repoTotals).map(([repo, t]) => {
      const score = (t.pullRequests * (SCORE_WEIGHTS.pullRequests || 0))
        + (t.feedback * (SCORE_WEIGHTS.feedback || 0))
        + (t.approvals * (SCORE_WEIGHTS.approvals || 0))
        + (t.commits * (SCORE_WEIGHTS.commits || 0))
        + (t.loc * (SCORE_WEIGHTS.loc || 0))
        + (t.filesTouched * (SCORE_WEIGHTS.filesTouched || 0));
      return { repo, score, ...t, contributors: t.contributors.size };
    }).filter(r => r.score > 0);

    repoList.sort((a, b) => b.score - a.score);

    const totalScore = repoList.reduce((s, r) => s + r.score, 0);
    const shortName = (r) => r.replace(/^@[^/]+\\//, '');

    // Compute popularity outliers (repos with score ≥ mean + 1.5σ)
    const popularRepos = {};
    if (repoList.length >= 3) {
      const scores = repoList.map(r => r.score);
      const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
      const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        repoList.forEach(r => {
          const z = (r.score - mean) / stdDev;
          if (z >= 1.0) popularRepos[r.repo] = z.toFixed(1);
        });
      }
    }

    const grid = document.getElementById('repos-grid');
    grid.innerHTML = repoList.map((r, i) => {
      const pct = totalScore > 0 ? (r.score / totalScore * 100) : 0;
      const rankColors = CT().rank;
      const rankStyle = i < 3 ? 'background:' + rankColors[i] : CT().rankRest;
      const star = popularRepos[r.repo] ? ' <span class="popularity-badge" onclick="event.stopPropagation();showPopularityPopup(event,' + popularRepos[r.repo] + ')">⭐</span>' : '';
      return '<div class="repo-card">'
        + '<div class="repo-card-header">'
          + '<span class="repo-card-name" title="' + r.repo + '">' + shortName(r.repo) + star + '</span>'
          + '<span class="repo-card-pct">' + pct.toFixed(1) + '%</span>'
        + '</div>'
        + '<div class="repo-card-bar"><div class="repo-card-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>'
        + '<div class="repo-card-stats">'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(r.pullRequests) + '</div><div class="stat-label">PRs</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(r.feedback) + '</div><div class="stat-label">Feedback</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(r.approvals) + '</div><div class="stat-label">Approvals</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(r.commits) + '</div><div class="stat-label">Commits</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(r.loc) + '</div><div class="stat-label">LOC</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + formatNum(r.filesTouched) + '</div><div class="stat-label">Files</div></div>'
          + '<div class="user-stat"><div class="stat-value">' + r.contributors + '</div><div class="stat-label">Contributors</div></div>'
        + '</div>'
      + '</div>';
    }).join('');
  }

  let lastActiveUsers = [];

  function renderDistribution(activeUsers, metricKey) {
    if (!metricKey) metricKey = 'score';
    const metricDef = METRICS.find(m => m.key === metricKey) || METRICS[0];

    if (distChart) { distChart.destroy(); distChart = null; }

    const values = activeUsers.map(u => {
      if (metricKey === 'effectivePRs') {
        return u.totals.effectivePRs || 0;
      }
      return u.totals[metricKey] || 0;
    });
    if (values.length < 2) return;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    document.getElementById('dist-title').textContent = metricDef.label.toUpperCase() + ' DISTRIBUTION';
    document.getElementById('dist-subtitle').textContent =
      'μ = ' + mean.toFixed(1) + '   σ = ' + stdDev.toFixed(1) + '   n = ' + values.length;

    const sorted = activeUsers
      .map((u, i) => ({
        name: u.name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
        value: values[i],
        z: stdDev > 0 ? (values[i] - mean) / stdDev : 0
      }))
      .sort((a, b) => a.value - b.value);

    // Gaussian PDF
    function gaussPDF(x) {
      if (stdDev === 0) return 0;
      const exp = -0.5 * ((x - mean) / stdDev) ** 2;
      return (1 / (stdDev * Math.sqrt(2 * Math.PI))) * Math.pow(Math.E, exp);
    }

    // Generate smooth bell curve points from μ-3.5σ to μ+3.5σ
    const xMin = Math.max(0, mean - 3.5 * stdDev);
    const xMax = mean + 3.5 * stdDev;
    const steps = 200;
    const curvePoints = [];
    for (let i = 0; i <= steps; i++) {
      const x = xMin + (xMax - xMin) * (i / steps);
      curvePoints.push({ x, y: gaussPDF(x) });
    }

    // σ band color mapping
    const bandDefs = [
      { min: -Infinity, max: -2, bg: 'rgba(255, 51, 51, 0.12)',  border: '#ff3333', label: '< −2σ' },
      { min: -2,        max: -1, bg: 'rgba(255, 136, 68, 0.15)', border: '#ff8844', label: '−2σ to −1σ' },
      { min: -1,        max:  1, bg: 'rgba(0, 170, 255, 0.15)',  border: '#00aaff', label: '−1σ to +1σ' },
      { min:  1,        max:  2, bg: 'rgba(0, 221, 204, 0.15)',  border: '#00ddcc', label: '+1σ to +2σ' },
      { min:  2,        max: Infinity, bg: 'rgba(204, 102, 255, 0.15)', border: '#cc66ff', label: '> +2σ' },
    ];

    function getBandForZ(z) {
      return bandDefs.find(b => z > b.min && z <= b.max) || bandDefs[2];
    }

    // Create filled region datasets for each σ band
    const bandDatasets = bandDefs.map(band => {
      const lo = band.min === -Infinity ? xMin : Math.max(xMin, mean + band.min * stdDev);
      const hi = band.max ===  Infinity ? xMax : Math.min(xMax, mean + band.max * stdDev);
      const pts = curvePoints
        .filter(p => p.x >= lo - 0.01 && p.x <= hi + 0.01)
        .map(p => ({ x: p.x, y: p.y }));
      // Add boundary points at y=0 for clean fill
      if (pts.length > 0) {
        pts.unshift({ x: pts[0].x, y: 0 });
        pts.push({ x: pts[pts.length - 1].x, y: 0 });
      }
      return {
        type: 'line',
        data: pts,
        backgroundColor: band.bg,
        borderColor: 'transparent',
        borderWidth: 0,
        fill: true,
        pointRadius: 0,
        tension: 0.4,
        order: 3,
      };
    });

    // Bell curve line
    const curveDataset = {
      type: 'line',
      data: curvePoints,
      borderColor: CT().curve,
      borderWidth: 2,
      fill: false,
      pointRadius: 0,
      tension: 0.4,
      order: 2,
    };

    // Scatter points for each user on the curve
    const userPoints = sorted.map(u => ({
      x: u.value,
      y: gaussPDF(u.value),
      name: u.name,
      z: u.z,
      value: u.value,
    }));

    const userDataset = {
      type: 'scatter',
      data: userPoints,
      backgroundColor: userPoints.map(u => getBandForZ(u.z).border),
      borderColor: userPoints.map(u => getBandForZ(u.z).border),
      pointRadius: 6,
      pointHoverRadius: 9,
      pointStyle: 'circle',
      order: 1,
    };

    // σ marker annotations (vertical dashed lines)
    const annotations = {};
    const lineStyle = { type: 'line', borderDash: [6, 4], borderWidth: 1, label: { display: true, position: 'start', font: { size: 10, family: 'IBM Plex Mono' }, padding: 3 } };

    annotations.mean = {
      ...lineStyle,
      xMin: mean, xMax: mean,
      borderColor: CT().annMean,
      label: { ...lineStyle.label, content: 'μ', color: CT().annMeanLabel, backgroundColor: CT().annLabelBg }
    };
    [-2, -1, 1, 2].forEach(n => {
      const val = mean + n * stdDev;
      if (val >= xMin && val <= xMax) {
        annotations['sd' + n] = {
          ...lineStyle,
          xMin: val, xMax: val,
          borderColor: CT().annSd,
          label: { ...lineStyle.label, content: (n > 0 ? '+' : '') + n + 'σ', color: CT().annSdLabel, backgroundColor: CT().annLabelBg }
        };
      }
    });

    const canvas = document.getElementById('dist-chart');
    distChart = new Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [...bandDatasets, curveDataset, userDataset]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          annotation: { annotations },
          tooltip: {
            filter: function(item) { return item.datasetIndex === bandDatasets.length + 1; },
            callbacks: {
              title: function(items) {
                if (!items.length) return '';
                return userPoints[items[0].dataIndex].name;
              },
              label: function(ctx) {
                const u = userPoints[ctx.dataIndex];
                return metricDef.label + ': ' + metricDef.format(u.value) + ' (' + (u.z >= 0 ? '+' : '') + u.z.toFixed(2) + 'σ)';
              }
            },
            titleFont: { family: 'IBM Plex Mono', size: 12 },
            bodyFont: { family: 'IBM Plex Mono', size: 11 },
            backgroundColor: CT().distTooltipBg,
            borderColor: CT().distTooltipBorder,
            titleColor: CT().distTooltipTitle,
            bodyColor: CT().distTooltipBody,
            borderWidth: 1,
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: xMin,
            max: xMax,
            ticks: { color: CT().tickDim, font: { family: 'IBM Plex Mono', size: 10 }, callback: function(v) { return v.toFixed(0); } },
            grid: { color: CT().gridSoft },
            title: { display: true, text: metricDef.label, color: CT().tickDim, font: { family: 'IBM Plex Mono', size: 11 } }
          },
          y: {
            beginAtZero: true,
            ticks: { display: false },
            grid: { color: CT().gridSoft },
            title: { display: true, text: 'Density', color: CT().tickDim, font: { family: 'IBM Plex Mono', size: 11 } }
          }
        }
      }
    });

    // Legend
    const legendEl = document.getElementById('dist-legend');
    const usedBands = new Set(sorted.map(u => {
      const b = getBandForZ(u.z);
      return bandDefs.indexOf(b);
    }));
    legendEl.innerHTML = bandDefs
      .filter((_, i) => usedBands.has(i))
      .map(b =>
        '<div class="dist-legend-item">'
          + '<div class="dist-legend-swatch" style="background:' + b.border + '"></div>'
          + '<span>' + b.label + '</span>'
        + '</div>'
      ).join('');
  }

  // ─── Fire Badge Popup ─────────────────────────────────────────────────

  const METRIC_LABELS = {};
  METRICS.forEach(m => { METRIC_LABELS[m.key] = m.label; });

  window.showFirePopup = function(e, metricKey, zScore) {
    const popup = document.getElementById('fire-popup');
    const body = document.getElementById('fire-popup-body');
    const label = METRIC_LABELS[metricKey] || metricKey;
    body.innerHTML = 'This contributor\\'s <span class="fire-popup-value">' + label + '</span> is '
      + '<span class="fire-popup-value">+' + zScore + 'σ</span> above the team average — '
      + 'placing them in the top tier for this metric during the selected time range.';
    popup.classList.add('visible');

    const rect = e.target.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - 130;
    let top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + 260 > window.innerWidth) left = window.innerWidth - 268;
    if (top + 100 > window.innerHeight) top = rect.top - 8 - popup.offsetHeight;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  };

  window.showPopularityPopup = function(e, zScore) {
    const popup = document.getElementById('fire-popup');
    const body = document.getElementById('fire-popup-body');
    body.innerHTML = 'This repository\\'s contribution score is '
      + '<span class="fire-popup-value">+' + zScore + 'σ</span> above average — '
      + 'making it one of the most active repos during the selected time range.';
    popup.classList.add('visible');

    const rect = e.target.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - 130;
    let top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + 260 > window.innerWidth) left = window.innerWidth - 268;
    if (top + 100 > window.innerHeight) top = rect.top - 8 - popup.offsetHeight;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  };

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.fire-badge') && !e.target.closest('.popularity-badge')) {
      document.getElementById('fire-popup').classList.remove('visible');
    }
  });

  // ─── User Profile ──────────────────────────────────────────────────────

  window.openProfile = function(userName, resetScroll) {
    if (resetScroll === undefined) resetScroll = true;
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

    // First/last tracked activity across ALL history (not just the current
    // scope) — the same "touch point" dates used to normalize the weekly
    // attainment rate, surfaced here for transparency.
    const firstTouch = toISODateString(getUserFirstActivityDate(userName));
    const lastTouch = toISODateString(getUserLastActivityDate(userName));

    let html = '<button class="profile-close" onclick="closeProfile()">✕ CLOSE</button>';
    html += '<div class="profile-name">' + displayName + '</div>';
    html += '<div class="profile-subtitle">Rank #' + rank + ' of ' + allUsers.filter(u => u.score > 0).length + ' active contributors &mdash; ' + rangeLabel + '</div>';
    if (firstTouch || lastTouch) {
      html += '<div class="profile-touchpoints">First activity: <strong>' + (firstTouch || '—') + '</strong>'
        + ' &nbsp;&middot;&nbsp; Last activity: <strong>' + (lastTouch || '—') + '</strong></div>';
    }

    // ─── Role Attainment Breakdown (optional — only for users with an
    // assigned role that resolves to a defined config.json role) ──────────
    const attainment = getRoleAttainment(userName, totals, periods);
    if (attainment && attainment.role) {
      const overallTooltip = attainment.category
        ? attainment.category + (attainment.evaluatedThrough ? ' (evaluated through ' + attainment.evaluatedThrough + ')' : '')
        : '';
      const sentiment = buildSentimentSummary(attainment);

      html += '<div class="profile-role-panel">';
      html += '<div class="profile-role-header">'
        + '<span class="user-role-badge">' + escapeHtml(attainment.role) + '</span>'
        + (attainment.category ? '<span class="profile-role-overall-label">Overall: ' + escapeHtml(attainment.category) + ' ' + attainment.emoji + '</span>' : '')
      + '</div>';

      if (sentiment) html += '<div class="profile-sentiment">' + sentiment + '</div>';

      if (attainment.barPercent !== null) {
        html += '<div class="role-bar-row profile-role-overall-row">'
          + '<div class="role-bar-track" title="' + escapeHtml(overallTooltip) + '">'
            + '<div class="role-bar-dot" style="left:' + attainment.barPercent.toFixed(1) + '%"></div>'
          + '</div>'
          + '<span class="role-bar-emoji" title="' + escapeHtml(overallTooltip) + '">' + attainment.emoji + '</span>'
        + '</div>';
      }

      ROLE_ATTAINMENT_METRICS.forEach(key => {
        const md = attainment.metrics[key];
        if (!md) return;
        const label = ROLE_METRIC_LABELS[key] || key;
        const metricTooltip = md.category + ' \u2014 ' + md.weeklyValue.toFixed(1) + '/wk (satisfactory ' + md.satisfactory + ', goal ' + md.goal + ')'
          + (attainment.evaluatedThrough ? ' (evaluated through ' + attainment.evaluatedThrough + ')' : '');
        html += '<div class="profile-metric-row">'
          + '<span class="profile-metric-label">' + escapeHtml(label) + '</span>'
          + '<div class="role-bar-track" title="' + escapeHtml(metricTooltip) + '">'
            + '<div class="role-bar-dot" style="left:' + md.barPercent.toFixed(1) + '%"></div>'
          + '</div>'
          + '<span class="role-bar-emoji" title="' + escapeHtml(metricTooltip) + '">' + md.emoji + '</span>'
          + '<span class="profile-metric-value">' + md.weeklyValue.toFixed(1) + '/wk</span>'
        + '</div>';
      });

      html += '</div>';
    }

    const outliers = computeOutliers(periods);
    const userOutliers = outliers[userName] || {};

    html += '<div class="profile-stats">';
    METRICS.forEach(m => {
      const fire = userOutliers[m.key] ? '<span class="fire-badge" onclick="event.stopPropagation();showFirePopup(event,\\'' + m.key + '\\',' + userOutliers[m.key].zScore + ')">🔥</span>' : '';
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

    // ─── Per-period breakdown table (paginated) ─────────────────────────
    breakdownState = { periods: periods.slice().reverse(), userName, ud, totals, page: 0 };

    html += '<div class="profile-breakdown">';
    html += '<button class="breakdown-toggle" onclick="this.classList.toggle(\\'open\\');this.nextElementSibling.classList.toggle(\\'open\\')">'
      + '<span class="caret">▶</span> CONTRIBUTION BREAKDOWN (' + periods.length + ' periods)</button>';
    html += '<div class="breakdown-table-wrap">';
    html += '<div id="breakdown-content"></div>';
    html += '</div></div>';

    // ─── Pull request list (same PRs counted toward the Pull Requests metric) ──
    // A PR only counts toward that metric once it has 1+ reviews (see
    // gather-and-rank.js) — pullRequestList is populated under that exact
    // condition, so this list always matches what's being scored.
    const prList = [];
    periods.forEach(pid => {
      const d = ud && ud.data[pid];
      if (d && Array.isArray(d.pullRequestList)) prList.push(...d.pullRequestList);
    });
    prList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    html += '<div class="profile-breakdown">';
    html += '<button class="breakdown-toggle" onclick="this.classList.toggle(\\'open\\');this.nextElementSibling.classList.toggle(\\'open\\')">'
      + '<span class="caret">▶</span> PULL REQUESTS (' + prList.length + ')</button>';
    html += '<div class="pr-list-wrap">';
    if (prList.length === 0) {
      html += '<div class="pr-list-empty">No pull requests counted for this window.</div>';
    } else {
      html += '<ul class="pr-list">';
      html += prList.map(pr => {
        const meta = [pr.repo, formatPRDate(pr.createdAt)].filter(Boolean).join(' · ');
        return '<li>'
          + '<a class="pr-list-item" href="' + escapeHtml(pr.url) + '" target="_blank" rel="noopener noreferrer">'
            + '<span class="pr-list-title">' + escapeHtml(pr.title || ('#' + pr.number)) + '</span>'
            + '<span class="pr-list-meta">' + escapeHtml(meta) + '</span>'
          + '</a>'
        + '</li>';
      }).join('');
      html += '</ul>';
    }
    html += '</div></div>';

    // ─── Repository breakdown pie chart ──────────────────────────────────
    const repoTotals = {};
    periods.forEach(pid => {
      const d = ud && ud.data[pid];
      if (!d || !d.repoBreakdown) return;
      Object.keys(d.repoBreakdown).forEach(repo => {
        if (!repoTotals[repo]) repoTotals[repo] = { pullRequests: 0, feedback: 0, approvals: 0, commits: 0, loc: 0, filesTouched: 0 };
        const rb = d.repoBreakdown[repo];
        repoTotals[repo].pullRequests += rb.pullRequests || 0;
        repoTotals[repo].feedback += rb.feedback || 0;
        repoTotals[repo].approvals += rb.approvals || 0;
        repoTotals[repo].commits += rb.commits || 0;
        repoTotals[repo].loc += rb.loc || 0;
        repoTotals[repo].filesTouched += rb.filesTouched || 0;
      });
    });

    const activeRepos = Object.keys(repoTotals).filter(r =>
      repoTotals[r].pullRequests > 0 || repoTotals[r].feedback > 0 || repoTotals[r].approvals > 0 || repoTotals[r].commits > 0
    );

    if (activeRepos.length > 0) {
      html += '<div class="profile-repo-breakdown">';
      html += '<div class="pchart-title" style="text-align:center;margin-bottom:8px;">REPOSITORY BREAKDOWN</div>';
      html += '<div class="repo-pie-grid">';
      html += '<div class="repo-pie-box repo-pie-score"><div class="repo-pie-label">Score</div><canvas id="pie-score"></canvas></div>';
      html += '</div></div>';
    }

    panel.innerHTML = html;
    renderBreakdownPage();
    overlay.classList.add('visible');
    // The overlay itself is the scroll container; without resetting it, a
    // scroll position left over from a previous profile view (or from a long
    // profile scrolled down before closing) would carry over, opening the
    // next profile already scrolled past its top. Skipped only for the
    // in-place theme-refresh re-render, which shouldn't jump the user's
    // current scroll position while they're actively viewing a profile.
    if (resetScroll) overlay.scrollTop = 0;
    pushState();

    // Render profile charts
    Object.values(profileCharts).forEach(c => c.destroy());
    profileCharts = {};

    METRICS.forEach(m => {
      const canvas = document.getElementById('pchart-' + m.key);
      const data = periods.map(p => {
        const d = ud && ud.data[p];
        if (!d) return 0;
        if (m.key === 'effectivePRs') return d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
        if (m.key === 'churn') return calculateChurnValue(d);
        return d[m.key] || 0;
      });
      profileCharts[m.key] = new Chart(canvas, makeChartConfig(
        labels,
        [{
          label: m.label,
          data,
          borderColor: metricColor(m),
          backgroundColor: metricColor(m) + '20',
          fill: true
        }],
        m.format
      ));
    });

    // Render repository breakdown pie charts
    if (activeRepos.length > 0) {
      const PIE_COLORS = pieColors();
      const shortName = (r) => r.replace(/^@[^/]+\\//, '');

      const pieOpts = (fmt) => ({
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: CT().legendText, font: { family: '\\'JetBrains Mono\\',monospace', size: 10 }, padding: 8, boxWidth: 12 }
          },
          tooltip: {
            backgroundColor: CT().pieTooltipBg,
            titleColor: CT().pieTooltipTitle,
            bodyColor: CT().pieTooltipBody,
            borderColor: CT().pieTooltipBorder,
            borderWidth: 1,
            callbacks: {
              label: function(ctx) {
                const total = ctx.dataset.data.reduce((a,b) => a+b, 0);
                const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
                return ' ' + ctx.label + ': ' + (fmt ? fmt(ctx.raw) : ctx.raw) + ' (' + pct + '%)';
              }
            }
          }
        }
      });

      // Score breakdown by repo
      const scoreCanvas = document.getElementById('pie-score');
      if (scoreCanvas) {
        const repoScores = {};
        activeRepos.forEach(r => { repoScores[r] = repoScore(repoTotals[r]); });
        const scoredRepos = activeRepos.filter(r => repoScores[r] > 0);
        if (scoredRepos.length > 0) {
          profileCharts['repo-score'] = new Chart(scoreCanvas, {
            type: 'doughnut',
            data: {
              labels: scoredRepos.map(shortName),
              datasets: [{
                data: scoredRepos.map(r => parseFloat(repoScores[r].toFixed(1))),
                backgroundColor: scoredRepos.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]),
                borderColor: CT().pieBorder,
                borderWidth: 2
              }]
            },
            options: pieOpts(v => v.toFixed(1))
          });
        } else {
          scoreCanvas.parentElement.style.display = 'none';
        }
      }
    }
  };

  function renderBreakdownPage() {
    const s = breakdownState;
    if (!s) return;
    const container = document.getElementById('breakdown-content');
    if (!container) return;

    const totalPages = Math.max(1, Math.ceil(s.periods.length / BREAKDOWN_PAGE_SIZE));
    const page = Math.min(s.page, totalPages - 1);
    const start = page * BREAKDOWN_PAGE_SIZE;
    const pageItems = s.periods.slice(start, start + BREAKDOWN_PAGE_SIZE);

    let t = '<table class="breakdown-table"><thead><tr><th>Period</th>';
    METRICS.forEach(m => { t += '<th>' + m.label + '</th>'; });
    t += '</tr></thead><tbody>';

    pageItems.forEach(pid => {
      const p = ALL_PERIODS.find(x => x.id === pid);
      const d = s.ud && s.ud.data[pid];
      const periodLabel = formatPeriodLabel(pid);
      const dateRange = p ? p.startDate + ' → ' + p.endDate : pid;
      t += '<tr title="' + dateRange + '"><td>' + periodLabel + '</td>';
      METRICS.forEach(m => {
        let val = 0;
        if (d) {
          if (m.key === 'effectivePRs') val = d.pullRequests > 0 ? d.pullRequests : (d.predictedPullRequests || 0);
          else if (m.key === 'churn') val = calculateChurnValue(d);
          else val = d[m.key] || 0;
        }
        t += '<td>' + m.format(val) + '</td>';
      });
      t += '</tr>';
    });

    t += '<tr class="total-row"><td>TOTAL</td>';
    METRICS.forEach(m => { t += '<td>' + m.format(s.totals[m.key]) + '</td>'; });
    t += '</tr></tbody></table>';

    if (totalPages > 1) {
      const showing = 'Showing ' + (start + 1) + '–' + (start + pageItems.length) + ' of ' + s.periods.length + ' periods';
      t += '<div class="breakdown-pager">';
      t += '<button class="pager-btn" onclick="setBreakdownPage(' + (page - 1) + ')"' + (page === 0 ? ' disabled' : '') + '>◂ Prev</button>';
      t += '<span class="pager-info">' + showing + '</span>';
      t += '<button class="pager-btn" onclick="setBreakdownPage(' + (page + 1) + ')"' + (page >= totalPages - 1 ? ' disabled' : '') + '>Next ▸</button>';
      t += '</div>';
    }

    container.innerHTML = t;
  }

  window.setBreakdownPage = function(page) {
    if (!breakdownState) return;
    breakdownState.page = Math.max(0, page);
    renderBreakdownPage();
  };

  window.closeProfile = function() {
    document.getElementById('profile-overlay').classList.remove('visible');
    Object.values(profileCharts).forEach(c => c.destroy());
    profileCharts = {};
    pushState();
  };

  // ─── Full-Screen Chart Modal ───────────────────────────────────────────

  // Rather than building a second Chart.js instance, the existing chart
  // container is physically moved into the modal and moved back on close. That
  // keeps a single live chart per canvas, so re-renders triggered while the
  // modal is open (scope/sort changes) still target the right element.
  let expandedChart = null;

  function resizeAllCharts() {
    Object.values(charts).forEach(c => c.resize());
    if (distChart) distChart.resize();
  }

  window.openChartModal = function(containerId, title) {
    if (expandedChart) return;

    const node = document.getElementById(containerId);
    if (!node) return;

    // Anchor the original slot so the node returns to the exact same position.
    const placeholder = document.createComment('chart-slot:' + containerId);
    node.parentNode.insertBefore(placeholder, node);

    document.getElementById('chart-modal-title').textContent = title || '';
    document.getElementById('chart-modal-body').appendChild(node);
    document.getElementById('chart-overlay').classList.add('visible');
    document.body.style.overflow = 'hidden';

    expandedChart = { node, placeholder };
    resizeAllCharts();
  };

  window.closeChartModal = function() {
    if (!expandedChart) return;

    const { node, placeholder } = expandedChart;
    placeholder.parentNode.insertBefore(node, placeholder);
    placeholder.remove();
    expandedChart = null;

    document.getElementById('chart-overlay').classList.remove('visible');
    document.body.style.overflow = '';
    resizeAllCharts();
  };

  // Delegated so widgets rendered after load still get the behavior.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.chart-expand');
    if (!btn) return;
    const titleEl = btn.dataset.titleSrc
      ? document.getElementById(btn.dataset.titleSrc)
      : null;
    openChartModal(btn.dataset.chart, titleEl ? titleEl.textContent : '');
  });

  // ─── Tab switching ─────────────────────────────────────────────────────

  // ─── URL State Persistence ─────────────────────────────────────────────

  function pushState() {
    const params = new URLSearchParams();
    if (currentScope !== 7) params.set('scope', currentScope);
    if (currentSort !== 'score') params.set('sort', currentSort);
    const activeTab = document.querySelector('.nav-btn.active');
    const tab = activeTab ? activeTab.dataset.tab : 'dashboard';
    if (tab !== 'dashboard') params.set('tab', tab);
    if (document.getElementById('profile-overlay').classList.contains('open')) {
      const nameEl = document.querySelector('.profile-name');
      if (nameEl) params.set('profile', nameEl.textContent.toLowerCase());
    }
    const qs = params.toString();
    const url = window.location.pathname + (qs ? '?' + qs : '');
    window.history.replaceState(null, '', url);
  }

  function readState() {
    const params = new URLSearchParams(window.location.search);
    const scope = params.get('scope');
    if (scope === 'ytd') {
      currentScope = 'ytd';
    } else if (scope !== null && !isNaN(+scope)) {
      currentScope = +scope;
    }
    const sort = params.get('sort');
    if (sort && ['score','commits','pullRequests','feedback','approvals','issueResolutions','loc','filesTouched','churn'].includes(sort)) currentSort = sort;
    return {
      tab: params.get('tab') || 'dashboard',
      profile: params.get('profile') || null,
      section: params.get('section') || (window.location.hash ? window.location.hash.slice(1) : null),
    };
  }

  // ─── Methodology Section Permalinks ────────────────────────────────────
  // Gives every heading in the Methodology tab a stable id (derived from its
  // text) and a small 🔗 button that copies a shareable deep link
  // (?tab=methodology&section=<id>#<id>) so someone can send a link that
  // opens straight to a specific section.

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  }

  function initMethodologyAnchors() {
    const panel = document.getElementById('tab-methodology');
    if (!panel) return;
    const usedSlugs = {};
    panel.querySelectorAll('.meth-heading, .meth-subheading').forEach(heading => {
      let slug = slugify(heading.textContent);
      if (usedSlugs[slug]) {
        usedSlugs[slug]++;
        slug = slug + '-' + usedSlugs[slug];
      } else {
        usedSlugs[slug] = 1;
      }
      heading.id = slug;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'meth-anchor-btn';
      btn.title = 'Copy link to this section';
      btn.setAttribute('aria-label', 'Copy link to "' + heading.textContent + '"');
      btn.innerHTML = '🔗';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        copySectionLink(slug, btn);
      });
      heading.appendChild(btn);
    });
  }

  function copySectionLink(slug, btn) {
    const url = window.location.origin + window.location.pathname + '?tab=methodology&section=' + slug + '#' + slug;

    const showCopied = () => {
      if (!btn) return;
      const original = btn.innerHTML;
      btn.innerHTML = '✅';
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = original; btn.classList.remove('copied'); }, 1500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(showCopied).catch(() => fallbackCopy(url, showCopied));
    } else {
      fallbackCopy(url, showCopied);
    }
  }

  function fallbackCopy(text, onDone) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* no-op */ }
    document.body.removeChild(ta);
    if (onDone) onDone();
  }

  function scrollToMethodologySection(slug) {
    if (!slug) return;
    const el = document.getElementById(slug);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('meth-anchor-flash');
    setTimeout(() => el.classList.remove('meth-anchor-flash'), 1600);
  }

  // ─── Theme Toggle ──────────────────────────────────────────────────────
  // Chart.js bakes colors into each instance at construction time, so a theme
  // change has to rebuild every chart rather than just swap CSS variables.

  function naturalTheme() {
    const hour = new Date().getHours();
    return hour >= 7 && hour < 17 ? 'light' : 'dark';
  }

  function applyTheme(theme, persist) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.classList.toggle('light-mode', currentTheme === 'light');

    const btn = document.getElementById('theme-toggle');
    if (btn) {
      const label = 'Switch to ' + (currentTheme === 'light' ? 'dark' : 'light') + ' mode';
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }

    Chart.defaults.color = CT().tick;
    Chart.defaults.borderColor = CT().border;
    Chart.defaults.plugins.tooltip.titleColor = CT().tooltipTitle;
    Chart.defaults.plugins.tooltip.bodyColor = CT().tooltipBody;
    Chart.defaults.plugins.tooltip.footerColor = CT().tooltipBody;

    if (persist) {
      try {
        localStorage.setItem(
          window.__RH_THEME_KEY,
          JSON.stringify({ override: currentTheme, window: window.__RH_NATURAL })
        );
      } catch (e) { /* storage unavailable — theme still applies for this session */ }
    }

    renderAll();

    // The distribution chart only renders with the Users tab, and profile
    // charts live in an overlay; refresh whichever is currently on screen.
    const profileOverlay = document.getElementById('profile-overlay');
    if (profileOverlay && profileOverlay.classList.contains('visible')) {
      const nameEl = document.querySelector('.profile-name');
      const key = nameEl ? nameEl.textContent.trim().toLowerCase() : null;
      if (key && DATA.users[key]) openProfile(key, false);
    }
  }

  window.toggleTheme = function() {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light', true);
  };

  // Mirrors bjm-www: when the clock crosses into a new window, drop the manual
  // override and follow the natural theme again.
  setInterval(function() {
    const natural = naturalTheme();
    if (natural === window.__RH_NATURAL) return;
    window.__RH_NATURAL = natural;
    try { localStorage.removeItem(window.__RH_THEME_KEY); } catch (e) {}
    applyTheme(natural, false);
  }, 60000);

  // ─── Tab switching ────────────────────────────────────────────────────

  window.switchTab = function(tab) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
    if (tab === 'users') renderUsers();
    if (tab === 'repos') renderRepos();
    pushState();
  };

  // ─── Scope filter ──────────────────────────────────────────────────────

  window.setScope = function(days) {
    currentScope = days;
    document.querySelectorAll('.scope-btn').forEach(b => {
      const val = b.dataset.scope;
      b.classList.toggle('active', val === String(days));
    });
    renderAll();
    pushState();
  };

  // ─── User sort ─────────────────────────────────────────────────────────

  // Map sort keys (used in "Sort by" bar) to distribution metric keys
  function sortKeyToDistMetric(sortKey) {
    if (sortKey === 'pullRequests') return 'effectivePRs';
    return sortKey;
  }

  window.setUserSort = function(key) {
    currentSort = key;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
    renderUsers();
    pushState();
  };

  // ─── Render all ────────────────────────────────────────────────────────

  function renderAll() {
    userColorMap = buildUserColorMap(getScopedPeriods());
    renderSummary();
    renderWidgets();
    if (document.getElementById('tab-users').classList.contains('active')) {
      renderUsers();
    }
    if (document.getElementById('tab-repos').classList.contains('active')) {
      renderRepos();
    }
  }

  // ─── Scrollable button bars ────────────────────────────────────────────

  window.scrollBtns = function(arrow) {
    const bar = arrow.parentElement;
    const container = bar.querySelector('.scrollable-btns');
    if (!container) return;
    const dir = arrow.classList.contains('scroll-left') ? -1 : 1;
    container.scrollBy({ left: dir * 120, behavior: 'smooth' });
  };

  function updateScrollArrows() {
    document.querySelectorAll('.filter-bar, .users-sort-bar').forEach(bar => {
      const container = bar.querySelector('.scrollable-btns');
      if (!container) return;
      const leftArrow = bar.querySelector('.scroll-left');
      const rightArrow = bar.querySelector('.scroll-right');
      if (!leftArrow || !rightArrow) return;

      const canScrollLeft = container.scrollLeft > 1;
      const canScrollRight = container.scrollLeft < container.scrollWidth - container.clientWidth - 1;

      leftArrow.classList.toggle('visible', canScrollLeft);
      rightArrow.classList.toggle('visible', canScrollRight);
    });
  }

  // Update arrows on scroll and resize
  document.querySelectorAll('.scrollable-btns').forEach(el => {
    el.addEventListener('scroll', updateScrollArrows);
  });
  window.addEventListener('resize', updateScrollArrows);

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

    // Restore state from URL query parameters
    const urlState = readState();
    document.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', b.dataset.scope === String(currentScope)));
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === currentSort));
    if (urlState.tab !== 'dashboard') {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === urlState.tab));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + urlState.tab));
    }

    // Wire the theme toggle and sync its label with the pre-paint theme.
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => toggleTheme());
      const label = 'Switch to ' + (currentTheme === 'light' ? 'dark' : 'light') + ' mode';
      themeBtn.title = label;
      themeBtn.setAttribute('aria-label', label);
    }

    renderAll();

    // Methodology section permalinks: assign ids + copy-link buttons once,
    // then scroll to the requested section if the URL asked for one.
    initMethodologyAnchors();
    if (urlState.tab === 'methodology' && urlState.section) {
      setTimeout(() => scrollToMethodologySection(urlState.section), 50);
    }

    // Open profile if specified in URL (must happen after render so user data exists)
    if (urlState.profile && DATA.users[urlState.profile]) {
      openProfile(urlState.profile);
    }

    setTimeout(updateScrollArrows, 100);
  }

  // Handle escape key to close the topmost overlay
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (expandedChart) {
      closeChartModal();
      return;
    }
    closeProfile();
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

// Email the portable dashboard to the configured recipients. Opt-in, and never
// fatal — a delivery problem must not fail a run that already wrote the report.
const firstPeriod = dashboardData.periods[0];
const lastPeriod = dashboardData.periods[dashboardData.periods.length - 1];

sendDashboardEmail({
  startDate: firstPeriod?.startDate,
  endDate: lastPeriod?.endDate,
  periods: dashboardData.periods.length,
  generatedAt: new Date().toISOString().split('T')[0],
}).catch(error => {
  console.warn(`Failed to email the dashboard: ${error.message}`);
});
