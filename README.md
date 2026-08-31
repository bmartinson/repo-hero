# Repo Hero

A configurable CLI toolkit for analyzing the health of git repositories and their contributors over time. Point it at a directory of repos, configure your team, and Repo Hero gathers commit, pull request, review, and code-change data from the GitHub API and local git history — then produces a self-contained, interactive HTML dashboard you can open in any browser.

> **Status:** Beta — actively developed for real-world use. Contributions welcome.

---

## Features

- **Weekly data gathering** — date ranges are automatically split into 7-day windows for granular trend analysis
- **Interactive dashboard** — terminal-themed single-file HTML with Chart.js visualizations; no server required
- **Flexible time scoping** — filter by 1W / 2W / 3W / 1M / 2M / 3M / 6M / 1Y / All directly in the dashboard (default: 1W)
- **Smart overlap detection** — when weekly and monthly data coexist, the dashboard automatically prefers the more granular data
- **Scoring engine** — configurable weighted formula across PRs, commits, feedback, approvals, issue resolutions, LOC, and files touched (see [`score.js`](score.js))
- **Issue resolution tracking** — optionally pull resolved issues from one or more Jira projects and attribute them to contributors through the same alias map used for git and GitHub identities
- **PR prediction enrichment** — for historical periods without pull requests, Repo Hero learns each user's commits-per-PR ratio and synthesizes predicted PR counts
- **Positive outlier detection** — users performing > 1.5σ above the mean on any metric are flagged with a 🔥 badge; click the badge to see the exact z-score and explanation
- **Repository popularity** — repos with contribution scores > 1σ above the mean are flagged with a ⭐ badge on the Repos tab
- **Bell curve distribution** — Gaussian curve visualization of team score distribution with σ-band shading and individual user markers; follows the active Sort By metric
- **Repository breakdown** — per-user doughnut charts showing contribution distribution across repositories, plus a dedicated Repos tab ranking all repositories by contribution share
- **Consistent user colors** — chart colors are assigned by overall score rank, so the same person keeps the same color across all metric widgets
- **Full-screen chart expansion** — any chart tile can be expanded into a near-fullscreen modal for detailed reading, without rebuilding the chart or losing its current scope
- **Light / dark theme toggle** — a sun/moon button in the bottom-right corner switches between the light and dark palettes. The theme defaults to the time of day (light 7am–5pm, dark otherwise); your manual choice is remembered until the next natural changeover. Charts are re-rendered with a matching palette on every switch
- **URL state persistence** — tab, scope, sort, and open profile are stored in URL query parameters so a page refresh restores your exact view
- **Methodology page** — built-in documentation tab explaining scoring formulas, PR prediction, and outlier detection (auto-synced with `score.js` weights)
- **Alias consolidation** — map multiple git identities to a single person
- **Re-indexer** — retroactively apply alias or ignore-user changes to all historical result files
- **Future date capping** — if the configured end date extends past today, it is automatically clamped to the current date
- **CSV export** — per-user and team-level CSV files for use in spreadsheets or external tools
- **Email delivery** — optionally attach the portable dashboard to an email and send it to a list of recipients on every run

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

Create a `config.json` in the project root (it is gitignored). All top-level properties are required except `aliases`, `ignoreUsers`, `botUsers`, `commitsPerPullRequest`, `roles`, `userRoles`, and `userEndDates`.

```jsonc
{
  "tokens": {
    "github": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxx", // GitHub personal access token
    "jira": {
      // optional — omit the whole block to disable Jira metrics
      "email": "you@yourcompany.com", // Atlassian account email
      "apiToken": "ATATTxxxxxxxxxxxxxxxxxxxxxxx", // Atlassian API token
    },
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
  "botUsers": [
    // optional — alias names (matching "aliases" keys, not raw logins) whose
    // comments are excluded from the churn metric's non-bot comment count
    "DevOps Deployment",
    "AI Bots",
  ],
  "roles": {
    // optional — omit entirely to disable role badges and the Methodology role tables
    "Software Engineer": {
      // each metric's targets are expressed as a per-week rate; omit a metric to exclude
      // it from that role's attainment calculation (and from its Methodology table row)
      "score": { "satisfactory": 20, "goal": 35 },
      "pullRequests": { "satisfactory": 1, "goal": 2 },
      "feedback": { "satisfactory": 1, "goal": 3 },
      "approvals": { "satisfactory": 2, "goal": 4 },
      "issueResolutions": { "satisfactory": 0.5, "goal": 1 },
    },
    "Senior Software Engineer": {
      "score": { "satisfactory": 40, "goal": 60 },
      "pullRequests": { "satisfactory": 2, "goal": 3 },
      "feedback": { "satisfactory": 2, "goal": 4 },
      "approvals": { "satisfactory": 4, "goal": 6 },
      "issueResolutions": { "satisfactory": 1, "goal": 2 },
    },
  },
  "userRoles": {
    // optional — maps a canonical name (matching the "aliases" keys) to a "roles" entry
    "Jane Smith": "Senior Software Engineer",
    "Brian Martinson": "Software Engineer",
  },
  "userEndDates": {
    // optional and opt-in — only set this for contributors who have left/been offboarded.
    // Clamps the weekly-rate normalization window used by the attainment bar so time after
    // someone's departure doesn't keep silently deflating their rating. Leaving a currently
    // active person's entry out means silence still counts against them as expected — this is
    // never inferred automatically from inactivity.
    "Jane Smith": "2026-03-15",
  },
  "jira": {
    // optional — omit to disable Jira metrics
    "baseUrl": "https://yourorg.atlassian.net", // Jira Cloud site URL
    "projects": ["ENG", "OPS"], // project keys to pull completed issues from
    "completedJql": null, // optional override for the "completed" definition
    "excludeIssueTypes": ["Epic"], // optional issue types to skip
  },
}
```

### Email Delivery

Optionally email the generated dashboard to one or more recipients. When the
dashboard is regenerated it is opened in your browser **and** sent to everyone on
the list, so a recurring `npm start` doubles as a scheduled report.

Add a `tokens.smtp` credential pair and an `email` block:

```jsonc
{
  "tokens": {
    "smtp": {
      "user": "reports@yourcompany.com", // SMTP username
      "pass": "xxxxxxxxxxxxxxxx", // SMTP password or app password
    },
  },
  "email": {
    "to": ["lead@yourcompany.com", "vp@yourcompany.com"], // one or more recipients
    "cc": [], // optional
    "bcc": [], // optional
    "from": "Repo Hero <reports@yourcompany.com>", // optional, defaults to tokens.smtp.user
    "subject": "Repo Hero Dashboard — {range}", // optional, supports placeholders
    "compress": false, // optional, attach dashboard.html.gz instead
    "maxAttachmentMB": 20, // optional, skip send above this encoded size
    "enabled": true, // optional, set false to disable without deleting the block
    "smtp": {
      "host": "smtp.gmail.com", // required
      "port": 587, // optional, defaults to 587
      "secure": false, // optional, inferred from the port
    },
  },
}
```

`to` accepts either a single address string or an array. Addresses may be bare
(`you@company.com`) or include a display name (`You <you@company.com>`).

**Subject placeholders** — `{range}`, `{startDate}`, `{endDate}`, `{periods}`,
and `{date}`.

**Ports** — `secure` defaults to `true` on port 465 (implicit TLS) and `false`
on 587 or 25 (STARTTLS). Set it explicitly to override.

**Attachment size** — the dashboard inlines all of its data, so it grows with
your history and can exceed a mail server's message limit. Base64 encoding adds
another third on the wire. Setting `"compress": true` attaches a gzipped
dashboard, which typically shrinks it by more than 10x. Recipients on macOS and
Linux can open the `.gz` by double-clicking it.

**Gmail** — use an [app password](https://myaccount.google.com/apppasswords)
rather than your account password.

Email delivery is entirely optional. With no `email` block Repo Hero behaves
exactly as before. If the block is present but unusable, the problem is reported
and the run still finishes — a mail outage never costs you the dashboard.

To email the dashboard already on disk without regenerating it:

```sh
npm run email
```

### Jira Integration

Jira support is entirely optional and powers the **Issue Resolutions** metric. When `jira`
or `tokens.jira` is missing or incomplete, Repo Hero warns once and continues with
GitHub-only metrics — and the dashboard hides the metric rather than showing empty zeroes.

**Generating an API token:** create one at
[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
and pair it with the email address of the same Atlassian account.

**What counts as a resolution:** by default, an issue counts toward a period when it sits in
the `Done` status category and its `resolutiondate` falls inside that period's date range.
Boards that do not follow that convention can supply their own predicate via `completedJql` —
the project and date-range clauses are still applied on top so weekly bucketing stays correct:

```jsonc
"completedJql": "status in (Shipped, Released)"
```

**Assignee mapping:** resolutions are attributed to the issue's assignee, resolved through the
existing `aliases` map so a person's issues roll up into the same record as their commits,
PRs, feedback, and approvals. Resolution is attempted in this order:

1. Jira display name (e.g. `"Jane Smith"`) — matches the canonical alias keys
2. Assignee email address, then its local part (e.g. `jsmith`) — matches alias entries
3. Atlassian account ID — last resort so the issue is still counted

Most Jira Cloud sites hide email addresses for privacy, so the **display name is usually the
value that has to match**. If a teammate's Jira display name differs from their canonical
alias key, add it to their `aliases` array. Unassigned issues are skipped and reported in the
run summary.

### Quick Reconfigure

```sh
# Focus on a calendar year
npm run config 2024

# Focus on a specific month
npm run config 2024-06
```

---

## Commands

| Command                 | Description                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `npm start`             | **Full pipeline** — gather weekly data → enrich → combine → charts → dashboard                     |
| `npm run refresh`       | Re-index alias/ignoreUsers changes, then re-enrich → combine → chart → dashboard (no re-gathering) |
| `npm run gather`        | Gather data for a single date range (one output file)                                              |
| `npm run gather-weekly` | Split the configured date range into weeks and gather each                                         |
| `npm run enrich`        | Enrich historical data with predicted PR counts and recalculate scores                             |
| `npm run combine`       | Merge all `.results_history/*.json` into `combined_results.json`                                   |
| `npm run chart`         | Regenerate CSV files and dashboard from combined results                                           |
| `npm run dashboard`     | Regenerate only the HTML dashboard                                                                 |
| `npm run email`         | Email the existing dashboard without regenerating it                                               |
| `npm run reindex`       | Re-apply alias and ignore-user changes to all result files                                         |
| `npm run cleanup`       | Remove orphaned cache files (use `-- --dry` to preview)                                            |
| `npm run config <date>` | Quick-reconfigure `config.json` for a year or month                                                |
| `npm run help`          | Show the command reference in the terminal                                                         |

### CLI Overrides

Both `gather` and `gather-weekly` accept `--start` and `--end` flags:

```sh
npm run gather -- --start 2024-06-01 --end 2024-06-30
npm run gather-weekly -- --start 2024-01-01 --end 2024-12-31
```

You can bypass API response cache reads for a run with `--skip-cache`:

```sh
npm run gather -- --skip-cache
npm run gather-weekly -- --skip-cache
npm start -- --skip-cache
```

If `skipCache` is set in `config.json`, you can force cache usage for a run with `--no-skip-cache`.

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

1. **Gather** — For each week in the date range, queries the GitHub API for pull requests, reviews, and pending commits, and runs `git log` locally for commit counts, LOC, and files touched. When Jira is configured, it also queries each configured Jira project for issues resolved in the window and attributes those resolutions to their assignee. Per-user contribution breakdowns are tracked by repository (and by Jira project). Results are saved as `.results_history/YYYY-MM-DD_YYYY-MM-DD.json`. Weeks that already have result files are skipped (idempotent).

2. **Enrich** — Two-pass process: first learns each user's historical commits-per-PR ratio from periods where real PR data exists, then fills in `predictedPullRequests` for periods where PRs are zero. Recalculates all user scores.

3. **Combine** — Reads all `.json` files in `.results_history/` and merges them into a single `combined_results.json`, sorted by start date.

4. **Dashboard** — Reads `combined_results.json` and generates a single `dashboard.html` with all data, styles, and scripts inlined. No external dependencies at runtime. If monthly and weekly data overlap, the dashboard automatically drops the coarser period.

---

## Scoring

Scores are calculated per user per period using the weights defined in [`score.js`](score.js):

| Metric                  | Weight   | Notes                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| Feedback                | × 17     | PR reviews with changes requested or non-empty comment text          |
| Pull Requests           | × 15     | Uses real PRs (with at least one approval); falls back to predicted PRs if zero |
| Predicted Pull Requests | × 15     | Synthesized from commits-per-PR ratio (used as fallback)             |
| Issue Resolutions       | × 10     | Jira issues resolved by the user (when Jira is configured)           |
| Approvals               | × 8      | PR reviews with approval state                                       |
| Commits                 | × 0.01   | Raw commit count                                                     |
| Lines of Code           | × 0.0001 | Net lines changed (additions + deletions)                            |
| Files Touched           | × 0.0001 | Unique files modified                                                |

The team score is the average of all non-ignored users' scores for a given period.

### Churn

Churn is repo-hero's first *negative* metric — it subtracts from a user's overall score rather than
adding to it. It only considers PRs that are **merged** and have **at least one
approval** (the same approval requirement as the "Pull Requests" metric above, plus the additional
requirement that the PR was merged).
Its sub-metrics are gathered but not individually displayed — only the composite churn deduction shows
up as a reduction to the overall score:

| Sub-metric               | Weight | Notes                                                                          |
| ------------------------- | ------ | ------------------------------------------------------------------------------- |
| PR Open Duration          | − 1    | Per 24hrs a qualifying PR was open (`merged_at - created_at`)                   |
| Feedback Reviews Received | − 3    | Per review with changes requested or non-empty comment text on a qualifying PR |
| Non-Bot Comments          | − 0.5  | Per conversation comment (not tied to a review) from a non-bot user            |

A comment's author counts as a "bot" if their resolved alias (see `aliases` in `config.json`) is listed
in the optional `botUsers` config array. The final score is clamped at 0 — churn can offset earned
credit down to nothing, but never pushes a score negative.

### Outlier Detection

For each metric, the dashboard computes the mean and standard deviation across all active users. Any user exceeding **mean + 1.5σ** is flagged as a positive outlier with a 🔥 badge. Clicking the badge opens a themed popup showing the exact z-score and explanation.

### Score Distribution

The Users tab includes a Gaussian bell curve visualization showing where each contributor falls on the team's score distribution. The curve displays:

- σ-band fill regions (color-coded by standard deviation range)
- Scatter points for each user plotted on the curve
- Vertical reference lines for μ and ±1σ / ±2σ

---

## Dashboard

The dashboard is a self-contained HTML file with a console-style theme inspired by NASA mission control interfaces, available in both dark and light palettes. It includes four tabs:

### Dashboard Tab

- **Trend charts** — Score, Pull Requests, Feedback, Approvals, Issue Resolutions (when configured), Commits, LOC, Files Touched, Active Users, Team Score
- **Full-screen charts** — Every chart tile has a ⛶ expand button that opens the chart in a near-fullscreen modal; close with the CLOSE button, a click outside, or `Esc`
- **Theme toggle** — A floating sun/moon button in the bottom-right corner switches between light and dark mode from any tab. The choice is stored in `localStorage` and applied before first paint, so reloading never flashes the wrong theme
- **Top 5 leaderboards** — Per metric, updated when the time scope changes

### Users Tab

- **Contributor grid** — All active users ranked by the selected Sort By metric, with outlier badges
- **Consistent colors** — Each user keeps the same color across all chart widgets based on their overall score rank
- **Role badge & attainment bar** — When a user has an assigned role (see `roles`/`userRoles` in [Configuration](#configuration)), their tile shows the role name plus a thin bar with a dot indicating how their current-scope activity compares to that role's satisfactory/goal targets — far left is below satisfactory (❗), the middle is right at satisfactory (🙂), and the far right is at or beyond goal on every applicable metric (🤩). The blended overall verdict allows a small tolerance below satisfactory (down to -0.25 on the blended scale) before flipping to Failing, so a user who's strong on most metrics with only a minor shortfall elsewhere still reads as Meets Expectations overall. Targets are weekly rates, so the bar stays meaningful no matter which time scope is selected. The weekly rate is normalized to the user's actual active window: it never starts before their first tracked activity (so new hires viewed over a wide scope like YTD aren't penalized for weeks before they joined), and it stops at an explicit `userEndDates` entry when one is configured (so departed contributors aren't penalized for weeks after they left) — hover the bar to see the exact window it was evaluated over
- **User profiles** — Click any user card to see:
  - First/last activity dates — the earliest and most recent tracked-activity dates across all history, for quick context on tenure/recency
  - Role attainment breakdown (when the user has an assigned role) — a plain-language sentiment summary of where they're excelling/on track/falling behind, an overall attainment bar, and a per-metric bar (Pull Requests, Feedback, Approvals, Issue Resolutions, Score) each with its own weekly rate, ❗/🙂/🤩 indicator, and hover tooltip showing the satisfactory/goal targets and evaluation window used
  - Full history with per-metric line charts
  - Paginated per-period contribution breakdown table (100 per page, newest first)
  - Collapsible pull request list — every PR counted toward that user's Pull Requests metric (real PRs with at least one approval) for the currently selected time scope, newest first, each linking out to GitHub in a new tab. Scrolls internally past 10 entries so the modal doesn't grow unbounded for prolific contributors.
  - Repository breakdown doughnut charts (PRs, feedback, approvals, commits by repo)
- **Score distribution** — Bell curve showing where each user falls relative to the team, synced to the active Sort By metric (also expandable to full screen)

### Repos Tab

- **Repository grid** — All repositories ranked by weighted contribution share across the selected scope
- **Contribution percentage** — Each card shows its share of total engineering effort with a visual progress bar
- **Metric breakdown** — PRs, Feedback, Approvals, Commits, LOC, Files Touched, and contributor count per repo
- **Popularity badges** — Repos with contribution scores > 1σ above average are flagged with a ⭐ badge

### Methodology Tab

- **Scoring formula** — Exact weights and calculation logic (auto-synced from `score.js`)
- **Predicted pull requests** — How the two-pass prediction algorithm works
- **Issue resolutions** — What counts as resolved, how assignees are credited through the alias map, and why the weight sits below Feedback and PRs (only shown when Jira is configured)
- **Outlier detection** — Statistical approach and thresholds
- **Dashboard metrics** — Reference for all displayed data points
- **Team roles & targets** — One table per configured role listing the satisfactory/goal weekly rate for each tracked metric (only shown when `roles` is configured; roles where every metric is 0/0 are skipped)
- **Section permalinks** — Every heading has a small 🔗 button that copies a shareable deep link (`?tab=methodology&section=<id>`) which opens straight to that section and scrolls it into view

### Time Scope Filter

Available on all tabs: **1W** (default) / 2W / 3W / 1M / 2M / 3M / 6M / 1Y / All

The x-axis labels adapt automatically: weekly for short ranges (e.g. "Apr 1 '25"), monthly for longer ranges, yearly for multi-year views.

### URL State Persistence

Tab, scope, sort, and open user profile are persisted in URL query parameters. Refreshing the page restores your exact view. Parameters at default values are omitted to keep URLs clean.

Example: `?tab=users&scope=90&sort=feedback` — Users tab, 3M scope, sorted by feedback.

### Header & Footer

- Header shows the Repo Hero logo, period count, and last-generated timestamp
- Footer links to the [project repository](https://github.com/bmartinson/repo-hero) and the developer's website

---

## Re-indexing

If you update `aliases` or `ignoreUsers` in your config after gathering data, run:

```sh
npm run refresh
```

This re-indexes every `.json` file in `.results_history/` (merging newly-aliased users, removing newly-ignored users, and recalculating scores), then re-runs enrich → combine → chart → dashboard so the change is fully reflected everywhere — including the generated `dashboard.html`. This is the easiest way to fix a user (e.g. a bot account like "Aws") still showing up after adding it to `ignoreUsers` or aliasing it into another name — those changes only affect newly-gathered data until the historical files are re-indexed.

If you only want to re-index without re-running the rest of the pipeline (e.g. you're about to re-gather anyway), you can run the re-indexer alone:

```sh
npm run reindex
```

This walks every `.json` file in `.results_history/`, merges aliased users, removes ignored users, and recalculates scores. Use `--dry` to preview changes without writing files. Note that `npm run reindex` alone does **not** rebuild `combined_results.json` or `dashboard.html` — follow it with `npm run combine && npm run dashboard` (or just use `npm run refresh` instead).

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
├── email-dashboard.js        Emails the dashboard to configured recipients
├── results-reindexer.js      Retroactive alias/ignore re-indexer
├── results-cache-cleanup.js  Prune orphaned result files from cache
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
