# repo-hero
A configurable product management analysis tool for analyzing the health of git repositories and their contributors.

## Application Configuration
A CLI-based configuration wizard will be included as part of the package in the future to help you build your application config. This configuration is stored at the same directory level as `index.js` and is named `config.json`. Here is an example of a usable application configuration:

*All top level properties are required, except for `aliases`, `ignoreUsers`*

```json
{
  "tokens": {
    "github": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "directory": "/Users/bmartinson/Development",
  "projects": [
    "repo-hero"
  ],
  "aliases": {
    "User A": [
      "user-a",
      "usera"
    ],
    "Brian Martinson": [
      "bmartinson",
      "bmartinson13",
    ]
  },
  "ignoreUsers": [
    "DevOps"
  ]
}
```

## Running The Application
For now, it's as simple as running the entry script and passing a year.

```sh
node index.js --year=YYYY
```