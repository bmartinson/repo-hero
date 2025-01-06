# repo-hero

A configurable product management analysis toolkit for analyzing the health of git repositories and their contributors. You may consider this project in an **alpha** state. It is actively being developed in accordance with real world needs. Contributions are welcome.

## Application Configuration

A CLI-based configuration wizard will be included as part of the package in the future to help you build your application config. This configuration is stored at the same directory level as `gather-and-rank.js` and is named `config.json`. Here is an example of a usable application configuration:

_All top level properties are required, except for `aliases`, `ignoreUsers`, `commitsPerPullRequest`, `resultsName`_

```javascript
{
  "tokens": {
    "github": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxx" // use a personal access token for GitHub API access
  },
  "directory": "/Users/bmartinson/Development", // where to look for .git projects
  "startDate": "2023-09-01", // the starting range for analysis
  "endDate": "2024-09-01", // the ending range for analysis
  "resultsName": "2024-09", // the name of the results json file, this is optional
  "commitsPerPullRequest": 12.5, // if your projects don't use pull requests and rely mostly on commits, use this to synthesize deliverables (pseudo-PRs)
  "projects": [
    "@bmartinson/repo-hero" // these are all of the project including owner name owner/repo - @ handles should be included
  ],
  "aliases": {
    "User A": [ // the resulting name for a user we care about
      "user-a", // a known alias that we want to turn into "User A"
      "usera"
    ],
    "Brian Martinson": [
      "bmartinson",
      "bmartinson13",
    ]
  },
  "ignoreUsers": [
    "DevOps" // user names that we will remove from the results output
  ]
}
```

## Running The Application

These tools are a work in progress. You can expect a more single run e2e tool that will generate webpages and utilize chart.js, etc. in order to visualize your data gathering. For now, use these various steps to aggregate data.

```sh
#
# Gather data based on your config.json file. Continually adjust your config
# for new date ranges to gather all of the information you need.
#
npm start # repeat for each config.json mod

# now, combine all of your .results_history output
npm run combine

# once combined, generate useful csv files so you may plot and graph
npm run chart
```
