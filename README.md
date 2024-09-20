# repo-hero
A configurable product management analysis tool for analyzing the health of git repositories and their contributors.

## Application Configuration
A CLI-based configuration wizard will be included as part of the package in the future to help you build your application config. This configuration is stored at the same directory level as `index.js` and is named `config.json`. Here is an example of a usable application configuration:

*All top level properties are required, except for `aliases`, `ignoreUsers`*

```javascript
{
  "tokens": {
    "github": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxx" // use a personal access token for GitHub API access
  },
  "directory": "/Users/bmartinson/Development", // where to look for .git projects
  "startDate": "2023-09-01", // the starting range for analysis
  "endDate": "2024-09-01", // the ending range for analysis
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
For now, it's as simple as running the entry script and passing a year.

```sh
node index.js --year=YYYY
```