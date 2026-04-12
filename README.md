# Repo Hero

A configurable CLI toolkit for analyzing the health of git repositories and their contributors over time. Point it at a directory of repos, configure your team, and Repo Hero gathers commit, pull request, review, and code-change data from the GitHub API and local git history — then produces a self-contained, interactive HTML dashboard you can open in any browser.

> **Status:** Beta — actively developed for real-world use. Contributions welcome.

---

## Features

- **Weekly data gathering** — date ranges are automatically split into 7-day windows for granular trend analysis
- **Interactive dashboard** — dark, terminal-themed single-file HTML with Chart.js visualizations; no server required
- **Flexible time scoping** — filter by 1W / 2W / 3W / 1M / 2M / 3M / 6M / 1Y / All directly in the dashboard (default: 1W)
- **Smart overlap detection** — when weekly and monthly data coexist, the dashboard automatically prefers the more granular data
- **Scoring engine** — configurable weighted formula across PRs, commits, reviews, LOC, and files touched (see [`score.js`](score.js))
- **PR prediction enrichment** — for historical periods without pull requests, Repo Hero learns each user's commits-per-PR ratio and synthesizes predicted PR counts
- **Positive outlier detection** — users performing > 1.5σ above the mean on any metric are flagged with a 🔥 badge; click the badge to see the exact z-score and explanation
- **Bell curve distribution** — Gaussian curve visualization of team score distribution with σ-band shading and individual user markers
- **Repository breakdown** — per-user doughnut charts showing contribution distribution across repositories (PRs, reviews, commits)
- **Methodology page** — built-in documentation tab explaining scoring formulas, PR prediction, and outlier detection (auto-synced with `score.js` weights)
- **Alias consolidation** — map multiple git identities to a single person
- **Re-indexer** — retroactively apply alias or ignore-user changes to all historical result files
- **Future date capping** — if the configured end date extends past today, it is automatically clamped to the current date
- **CSV export** — per-user and team-level CSV files for use in spreadsheets or external tools

---

## Quick Start

```sh
# 1. Clone the repo
git clone https://github.com/bmartinson/repo-hero.git
cd repo-hero

# 2. Install dependencies
npm install

# 3. Create your config
cp sample-configs/sample-config.json config.json
# Edit config.json with your GitHub token, repo list, date range, etc.

# 4. Run the full pipeline (gather weekly → enrich → combine → charts → dashboard)
npm start
```

The dashboard opens automatically in your default browser.

---

## Configuration

Create a `config.json` in the project root (it is gitignored). All top-level properties are required except `aliases`, `ignoreUsers`, and `commitsPerPullRequest`.

```jsonc
{
  "tokens": {
    "github": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxx", // GitHub personal access token
  },
  "directory": "/Users/you/Development", // parent directory containing .git repos
  "startDate": "2024-01-01", // analysis start (YYYY-MM-DD)
  "endDate": "2025-01-01", // analysis end (YYYY-MM-DD, capped at today)
  "commitsPerPullRequest": 12.5, // optional: fallback ratio for PR prediction
  "projects": [
    "@yourorg/repo-one", // owner/repo — include the @ for orgs
    "@yourorg/repo-two",
  ],
  "aliases": {
    "Jane Smith": ["jsmith", "jane.smith"], // consolidate git identities
    "Brian Martinson": ["bmartinson", "bmartinson13"],
  },
  "ignoreUsers": [
    "DevOps", // names to exclude from results
    "dependabot[bot]",
  ],
}
```

### Quick Reconfigure

```sh
# Focus on a calendar year
npm run config 2024

# Focus on a specific month
npm run config 2024-06
```

---

## Commands

| Command                 | Description                                                                    |
| ----------------------- | ------------------------------------------------------------------------------ |
| `npm start`             | **Full pipeline** — gather weekly data → enrich → combine → charts → dashboard |
| `npm run gather`        | Gather data for a single date range (one output file)                          |
| `npm run gather-weekly` | Split the configured date range into weeks and gather each                     |
| `npm run enrich`        | Enrich historical data with predicted PR counts and recalculate scores         |
| `npm run combine`       | Merge all `.results_history/*.json` into `combined_results.json`               |
| `npm run chart`         | Regenerate CSV files and dashboard from combined results                       |
| `npm run dashboard`     | Regenerate only the HTML dashboard                                             |
| `npm run reindex`       | Re-apply alias and ignore-user changes to all result files                     |
| `npm run config <date>` | Quick-reconfigure `config.json` for a year or month                            |
| `npm run help`          | Show the command reference in the terminal                                     |

### CLI Overrides

Both `gather` and `gather-weekly` accept `--start` and `--end` flags:

```sh
npm run gather -- --start 2024-06-01 --end 2024-06-30
npm run gather-weekly -- --start 2024-01-01 --end 2024-12-31
```

If `--end` is later than today's date, it is automatically capped at today.

---

## Pipeline Overview

```
npm start
  │
  ├─ gather-weekly.js     Split date range into 7-day chunks; run gather-and-rank
  │    └─ gather-and-rank.js   Query GitHub API + local git log per repo per week
  │         └─ score.js        Calculate weighted user scores
  │
  ├─ results-enrich.js    Learn commits/PR ratios → synthesize predicted PRs
  ├─ results-combiner.js  Merge all .json results into combined_results.json
  ├─ results-charter.js   Generate per-user CSV trend files
  ├─ results-team-charter.js  Generate team-level CSV
  ├─ active-users-by-date.js  Generate active-user-count CSV
  └─ results-dashboard.js     Generate self-contained dashboard.html
       └─ Opens in default browser
```

### Data Flow

1. **Gather** — For each week in the date range, queries the GitHub API for pull requests, reviews, and pending commits, and runs `git log` locally for commit counts, LOC, and files touched. Per-user contribution breakdowns are tracked by repository. Results are saved as `.results_history/YYYY-MM-DD_YYYY-MM-DD.json`. Weeks that already have result files are skipped (idempotent).

2. **Enrich** — Two-pass process: first learns each user's historical commits-per-PR ratio from periods where real PR data exists, then fills in `predictedPullRequests` for periods where PRs are zero. Recalculates all user scores.

3. **Combine** — Reads all `.json` files in `.results_history/` and merges them into a single `combined_results.json`, sorted by start date.

4. **Dashboard** — Reads `combined_results.json` and generates a single `dashboard.html` with all data, styles, and scripts inlined. No external dependencies at runtime. If monthly and weekly data overlap, the dashboard automatically drops the coarser period.

---

## Scoring

Scores are calculated per user per period using the weights defined in [`score.js`](score.js):

| Metric                 | Weight   | Notes                                                      |
| ---------------------- | -------- | ---------------------------------------------------------- |
| Pull Requests          | × 15     | Uses real PRs; falls back to predicted PRs if zero         |
| Predicted Pull Requests| × 15     | Synthesized from commits-per-PR ratio (used as fallback)   |
| Reviews                | × 17     | Code reviews authored — weighted highest as a team multiplier |
| Commits                | × 0.01   | Raw commit count                                           |
| Lines of Code          | × 0.0001 | Net lines changed (additions + deletions)                  |
| Files Touched          | × 0.0001 | Unique files modified                                      |

The team score is the average of all non-ignored users' scores for a given period.

### Outlier Detection

For each metric, the dashboard computes the mean and standard deviation across all active users. Any user exceeding **mean + 1.5σ** is flagged as a positive outlier with a 🔥 badge. Clicking the badge opens a themed popup showing the exact z-score and explanation.

### Score Distribution

The Users tab includes a Gaussian bell curve visualization showing where each contributor falls on the team's score distribution. The curve displays:

- σ-band fill regions (color-coded by standard deviation range)
- Scatter points for each user plotted on the curve
- Vertical reference lines for μ and ±1σ / ±2σ

---

## Dashboard

The dashboard is a self-contained HTML file with a dark, console-style theme inspired by NASA mission control interfaces. It includes three tabs:

### Dashboard Tab
- **Trend charts** — Score, Pull Requests, Reviews, Commits, LOC, Files Touched, Active Users, Team Score
- **Top 5 leaderboards** — Per metric, updated when the time scope changes

### Users Tab
- **Contributor grid** — All active users ranked by score with outlier badges
- **User profiles** — Click any user card to see:
  - Full history with per-metric line charts
  - Collapsible per-period contribution breakdown table
  - Repository breakdown doughnut charts (PRs, reviews, commits by repo)
- **Score distribution** — Bell curve showing where each user falls relative to the team

### Methodology Tab
- **Scoring formula** — Exact weights and calculation logic (auto-synced from `score.js`)
- **Predicted pull requests** — How the two-pass prediction algorithm works
- **Outlier detection** — Statistical approach and thresholds
- **Dashboard metrics** — Reference for all displayed data points

### Time Scope Filter
Available on all tabs: **1W** (default) / 2W / 3W / 1M / 2M / 3M / 6M / 1Y / All

The x-axis labels adapt automatically: daily for week ranges, monthly for longer ranges, yearly for multi-year views.

### Header & Footer
- Header shows the Repo Hero logo, period count, and last-generated timestamp
- Footer links to the [project repository](https://github.com/bmartinson/repo-hero) and the developer's website

---

## Re-indexing

If you update `aliases` or `ignoreUsers` in your config after gathering data, run:

```sh
npm run reindex
```

This walks every `.json` file in `.results_history/`, merges aliased users, removes ignored users, and recalculates scores. Use `--dry` to preview changes without writing files.

---

## Project Structure

```
repo-hero/
├── gather-and-rank.js       Core data gathering + scoring (single range)
├── gather-weekly.js          Weekly chunk orchestrator
├── score.js                  Shared scoring weights and calculateScore()
├── results-enrich.js         PR prediction enrichment (two-pass)
├── results-combiner.js       Merge JSON results into combined file
├── results-charter.js        Per-user CSV generation
├── results-team-charter.js   Team CSV generation
├── active-users-by-date.js   Active user count CSV
├── results-dashboard.js      HTML dashboard generator
├── results-reindexer.js      Retroactive alias/ignore re-indexer
├── configurator.js           Quick date reconfiguration CLI
├── help.js                   Terminal command reference
├── runner.sh                 Shell runner script
├── config.json               Your configuration (gitignored)
├── assets/
│   ├── logo.svg              Git-branching logo (dashboard header + favicon)
│   ├── bjm-favicon.png       BJM favicon (original)
│   └── bjm-favicon-white.png BJM favicon (white, used in dashboard footer)
├── sample-configs/           Example configuration files
└── .results_history/         Generated results (gitignored)
    ├── YYYY-MM-DD_YYYY-MM-DD.json   Per-period result files
    ├── combined_results.json         Merged results
    ├── dashboard.html                Interactive dashboard
    └── *.csv                         Chart data exports
```

---

## License

[MIT](LICENSE)
