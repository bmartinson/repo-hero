const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const exec = require('child_process').exec;
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { calculateScore } = require('./score');

// ----- nodejs helper variables -----
_cReset = '\x1b[0m';
_cBright = '\x1b[1m';
_cDim = '\x1b[2m';
_cUnderscore = '\x1b[4m';
_cBlink = '\x1b[5m';
_cReverse = '\x1b[7m';
_cHidden = '\x1b[8m';
_cFgBlack = '\x1b[30m';
_cFgRed = '\x1b[31m';
_cFgGreen = '\x1b[32m';
_cFgYellow = '\x1b[33m';
_cFgBlue = '\x1b[34m';
_cFgMagenta = '\x1b[35m';
_cFgCyan = '\x1b[36m';
_cFgWhite = '\x1b[37m';
_cFgGray = '\x1b[90m';
_cBgBlack = '\x1b[40m';
_cBgRed = '\x1b[41m';
_cBgGreen = '\x1b[42m';
_cBgYellow = '\x1b[43m';
_cBgBlue = '\x1b[44m';
_cBgMagenta = '\x1b[45m';
_cBgCyan = '\x1b[46m';
_cBgWhite = '\x1b[47m';
_cBgGray = '\x1b[100m';

// ----- global variables -----
let _START_DATE = null; // string | null (YYYY-MM-DD)
let _END_DATE = null; // string | null (YYYY-MM-DD)
let _CONFIG = null; // any (config.json)
let _ALIASES = {}; // { key: [value: string[]] }
let _BOT_ALIASES = new Set(); // Set<string> of lower-cased alias names flagged as bots (config.json botUsers)
let _RESULTS = {}; // any (results_timestamp.json)
let _GITHUB_API = null; // axios instance for the GitHub API
let _GITHUB_SEARCH_API = null; // axios instance for the GitHub API
let _JIRA_API = null; // axios instance for the Jira Cloud API
let _JIRA_ENABLED = false; // whether the Jira pass should run for this session
let _CACHE = null; // any (cache.json)

// ----- helper functions -----

/**
 * Check to see if a given directory path is valid or not.
 *
 * @param {string} dirPath
 * @returns {boolean} Whether the directory is valid or not.
 */
function isValidDirectoryPath(dirPath) {
  try {
    // Resolve the absolute path
    const resolvedPath = path.resolve(dirPath);

    // Check if the path exists
    if (!fs.existsSync(resolvedPath)) {
      return false;
    }

    // Check if the path is a directory
    const stat = fs.lstatSync(resolvedPath);
    return stat.isDirectory();
  } catch (error) {
    // If any error occurs, the path is not valid
    return false;
  }
}

/**
 * Get a package name to ensure that scope information is removed and that
 * no trailing .git identifiers are present.
 *
 * @param {string} packageName The name of the package including scope (if relevant).
 * @returns The name of the package.
 */
function getPackageName(packageName) {
  // Remove scope if available
  const withoutScope = packageName.replace(/^@[^/]+\//, '');

  // Remove trailing .git if present
  return withoutScope.replace(/\.git$/, '');
}

/**
 * Extracts the scope name from an npm package name.
 *
 * @param {string} packageName The name of the package including scope (if relevant).
 * @returns {string} The scope name if present, otherwise an empty string.
 */
function getScopeName(packageName) {
  const match = packageName.match(/^@([^/]+)\//);
  return match ? match[1] : '';
}

/**
 * Removes the email account enclosed in angle brackets from a string.
 *
 * @param {string} input The input string containing the email account.
 * @returns {string} The string without the email account.
 */
function removeEmailAccount(input) {
  return input.replace(/<[^>]+>/, '').trim();
}

/**
 * Extract a display-friendly repository name from a GitHub PR search result.
 * Uses repository_url (e.g. https://api.github.com/repos/TreeRing/cambium)
 * and returns "@Owner/repo" format.
 */
function extractRepoName(pr) {
  const url = pr.repository_url || '';
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (match) return '@' + match[1] + '/' + match[2];
  return '';
}

/**
 * Get the standard alias based on a specific user name provided. This assumes
 * that the _ALIASES global object has been configured based on application
 * parameters.
 *
 * @param {string} user The user name that we want to normalize to a standard alias.
 */
function getAliasForUser(user) {
  if (!user) {
    user = '';
  } else {
    user = user.toLowerCase();
  }

  user = removeEmailAccount(user);

  return _ALIASES[user]?.toLowerCase().trim() || user.trim();
}

/**
 * Resolve a Jira assignee object down to the same normalized alias that the
 * git/GitHub side of the pipeline uses, so a person's tickets land on the same
 * user record as their commits, pull requests, and reviews.
 *
 * Jira exposes a display name, and (depending on the account's GDPR privacy
 * settings) possibly an email address. Resolution is attempted in order of how
 * likely each value is to already appear in the configured aliases:
 *
 *   1. displayName        — matches the canonical alias keys, e.g. "Jane Smith"
 *   2. emailAddress       — matches alias entries written as full addresses
 *   3. email local part   — matches alias entries written as usernames/logins
 *   4. accountId          — stable last resort so the issue is still counted
 *
 * @param {{ displayName?: string, emailAddress?: string, accountId?: string }} assignee
 * @returns {string | null} The normalized alias, or null when unassigned.
 */
function getAliasForJiraUser(assignee) {
  if (!assignee) {
    return null;
  }

  const candidates = [];

  if (assignee.displayName) {
    candidates.push(assignee.displayName);
  }

  if (assignee.emailAddress) {
    candidates.push(assignee.emailAddress);
    candidates.push(assignee.emailAddress.split('@')[0]);
  }

  // Prefer a candidate that is explicitly mapped by the configured aliases
  for (const candidate of candidates) {
    const normalized = removeEmailAccount(candidate.toLowerCase()).trim();

    if (_ALIASES[normalized]) {
      return _ALIASES[normalized].toLowerCase().trim();
    }
  }

  // Otherwise fall back to the display name, which matches canonical alias keys
  if (candidates.length > 0) {
    return getAliasForUser(candidates[0]);
  }

  return assignee.accountId ? assignee.accountId.toLowerCase().trim() : null;
}

/**
 * Executes a shell command and returns a promise that resolves with the response.
 *
 * @param {string} command The command to execute.
 * @param {string} directory The directory to execute the script in.
 * @returns {Promise<string>} A promise that resolves with the command's standard output.
 */
async function executeCommand(command, directory) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd: directory, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(`Error executing command: ${error.message}`);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Lazily populate the in-memory response cache from the on-disk cache files.
 *
 * Shared by every API layer (GitHub and Jira) so that whichever one issues the
 * first request pays the load cost and the rest reuse the same map.
 */
function _loadCache() {
  const cacheDir = path.join(__dirname, '.results_cache');

  if (!_CACHE && _CONFIG?.skipCache) {
    console.log(`\n${_cFgYellow}Cache reading disabled. ${_cReset}\n`);
  }

  if (_CACHE) {
    return;
  }

  _CACHE = {};

  // If the skip cache flag is enabled, don't bother reading in cache files
  if (_CONFIG?.skipCache) {
    return;
  }

  console.log(
    `\n${_cFgYellow}Populating results cache. This might take a while...${_cReset}\n`
  );

  try {
    const files = fs.readdirSync(cacheDir);
    // Sort alphabetically so that cache_{timestamp}_... files are read in
    // chronological order — the last entry for any given key wins.
    const jsonFiles = files
      .filter(file => path.extname(file) === '.json')
      .sort();

    if (jsonFiles.length > 0) {
      jsonFiles.forEach(file => {
        try {
          const filePath = path.join(cacheDir, file);
          const fileContent = fs.readFileSync(filePath, 'utf8');

          const data = JSON.parse(fileContent);
          // Extract write timestamp from filename: cache_{timestamp}_{uuid}.json
          const fileTs = parseInt(file.split('_')[1], 10) || 0;
          Object.keys(data).forEach(dataKey => {
            // Preserve any _written_at already stored in the value, or
            // fall back to the timestamp embedded in the filename.
            _CACHE[dataKey] = {
              ...data[dataKey],
              _written_at: data[dataKey]._written_at ?? fileTs,
            };
          });
        } catch (cacheError) {
          `  ${_cFgGray}Error parsing a cache file. Consider removal of ${path.join(cacheDir, file)}${_cReset}`;
        }
      });
    }
  } catch (error) {
    console.error('An error occurred while processing cache files:', error);
    _CACHE = {};
  }
}

/**
 *
 * @param {string} req The path of the endpoint to fetch data from.
 * @param {any} options The request options.
 * @returns
 */
async function getFromGitHubAPI(req, options) {
  const cacheDir = path.join(__dirname, '.results_cache');

  let key = req;
  if (options) {
    key += `--qps--${JSON.stringify(options)}`;
  }

  _loadCache();

  if (!_CONFIG?.skipCache && _CACHE[key]) {
    // Staleness check: for GitHub search queries with a `created:START..END` date
    // range, skip the cache if it was written before the search window ended.
    // This prevents zero-result cache entries from when the week was in the future.
    const rangeMatch = key.match(
      /created:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/
    );
    if (rangeMatch) {
      const searchEndMs = new Date(rangeMatch[2] + 'T23:59:59Z').getTime();
      if ((_CACHE[key]._written_at ?? 0) < searchEndMs) {
        delete _CACHE[key]; // stale — fall through to make a fresh API call
      }
    }
  }

  if (!_CONFIG?.skipCache && _CACHE[key]) {
    // Return cache hit without the internal _written_at metadata
    const { _written_at, ...cacheVal } = _CACHE[key];
    if (options) {
      console.log(
        `Re-using cached data from GitHub API: ${_cFgYellow}${req}${_cReset} with options: ${JSON.stringify(options)}`
      );
    } else {
      console.log(
        `Re-using cached data from GitHub API: ${_cFgYellow}${req}${_cReset}`
      );
    }

    return cacheVal;
  }

  try {
    if (options) {
      console.log(
        `Fetching data from GitHub API: ${_cFgBlue}${req}${_cReset} with options: ${JSON.stringify(options)}`
      );
    } else {
      console.log(`Fetching data from GitHub API: ${_cFgBlue}${req}${_cReset}`);
    }

    const response = req.startsWith('/search/')
      ? await _GITHUB_SEARCH_API.get(req, options)
      : await _GITHUB_API.get(req, options);

    if (response?.status !== 200) {
      return response;
    }

    _CACHE[key] = {
      data: response.data,
      headers: response.headers,
      _written_at: Date.now(),
    };

    const timestamp = Date.now();
    const uuid = uuidv4();
    const filename = `cache_${timestamp}_${uuid}.json`;

    const saveData = {};
    saveData[key] = _CACHE[key];

    // Convert _CACHE to JSON string
    const cacheData = JSON.stringify(saveData, null, 2);

    // Check if the .results_cache folder exists, if not, create it
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir);
    }

    console.log(
      `  ${_cFgGray}Cached at: ./results_cache/${filename}${_cReset}\n`
    );

    // Write the JSON string to cache_xxx_yyy.json
    fs.writeFile(path.join(cacheDir, filename), cacheData, () => {});

    return response;
  } catch (error) {
    throw error;
  }
}

/**
 * Perform a GET against the Jira Cloud REST API, transparently reading from and
 * writing to the same on-disk response cache used for GitHub requests.
 *
 * Cache keys are prefixed with `jira:` so they never collide with GitHub paths,
 * and entries are considered stale when they were written before the end of the
 * resolution window they describe. That mirrors the GitHub `created:` staleness
 * check and prevents an empty result — cached while the week was still in the
 * future — from being reused forever.
 *
 * @param {string} req The Jira API path, e.g. '/rest/api/3/search/jql'.
 * @param {object} [options] Axios request options (params, etc).
 * @returns {Promise<any>} The axios response (or the cached equivalent).
 */
async function getFromJiraAPI(req, options) {
  const cacheDir = path.join(__dirname, '.results_cache');

  let key = `jira:${req}`;
  if (options) {
    key += `--qps--${JSON.stringify(options)}`;
  }

  _loadCache();

  if (!_CONFIG?.skipCache && _CACHE[key]) {
    // Staleness check: JQL queries carry a `resolutiondate <= "END"` bound. If
    // the entry was cached before that window closed, the data is incomplete.
    const rangeMatch = key.match(/resolutiondate <= \\"(\d{4}-\d{2}-\d{2})/);

    if (rangeMatch) {
      const searchEndMs = new Date(rangeMatch[1] + 'T23:59:59Z').getTime();

      if ((_CACHE[key]._written_at ?? 0) < searchEndMs) {
        delete _CACHE[key]; // stale — fall through to make a fresh API call
      }
    }
  }

  if (!_CONFIG?.skipCache && _CACHE[key]) {
    const { _written_at, ...cacheVal } = _CACHE[key];

    console.log(
      `Re-using cached data from Jira API: ${_cFgYellow}${req}${_cReset}`
    );

    return cacheVal;
  }

  console.log(`Fetching data from Jira API: ${_cFgBlue}${req}${_cReset}`);

  const response = await _JIRA_API.get(req, options);

  if (response?.status !== 200) {
    return response;
  }

  _CACHE[key] = {
    data: response.data,
    headers: response.headers,
    _written_at: Date.now(),
  };

  const filename = `cache_${Date.now()}_${uuidv4()}.json`;

  const saveData = {};
  saveData[key] = _CACHE[key];

  // Check if the .results_cache folder exists, if not, create it
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }

  console.log(
    `  ${_cFgGray}Cached at: ./results_cache/${filename}${_cReset}\n`
  );

  fs.writeFile(
    path.join(cacheDir, filename),
    JSON.stringify(saveData, null, 2),
    () => {}
  );

  return response;
}

/**
 * Build the JQL used to find issues completed inside the reporting window for a
 * single Jira project.
 *
 * By default an issue counts as completed when it carries a resolution date
 * inside the window and currently sits in the "Done" status category. Teams
 * whose boards do not follow that convention can supply `jira.completedJql` in
 * the configuration; the project and date clauses are still applied so that
 * weekly bucketing stays correct.
 *
 * @param {string} projectKey The Jira project key, e.g. 'ENG'.
 * @returns {string} The JQL query string.
 */
function buildCompletedIssuesJql(projectKey) {
  const clauses = [`project = "${projectKey}"`];

  if (_CONFIG?.jira?.completedJql) {
    clauses.push(`(${_CONFIG.jira.completedJql})`);
  } else {
    clauses.push('statusCategory = Done');
  }

  clauses.push(`resolutiondate >= "${_START_DATE}"`);
  clauses.push(`resolutiondate <= "${_END_DATE} 23:59"`);

  const excluded = _CONFIG?.jira?.excludeIssueTypes;
  if (Array.isArray(excluded) && excluded.length > 0) {
    clauses.push(
      `issuetype not in (${excluded.map(t => `"${t}"`).join(', ')})`
    );
  }

  return clauses.join(' AND ');
}

/**
 * Fetch every issue completed within the reporting window for a Jira project.
 *
 * Uses the `/rest/api/3/search/jql` endpoint, which paginates with an opaque
 * `nextPageToken` rather than `startAt` and returns no total count, so pages are
 * walked until no further token is returned.
 *
 * @param {string} projectKey The Jira project key, e.g. 'ENG'.
 * @returns {Promise<any[]>} All matching issues.
 */
async function fetchCompletedJiraIssues(projectKey) {
  const jql = buildCompletedIssuesJql(projectKey);
  const issues = [];

  let nextPageToken = null;
  let hasMorePages = true;

  while (hasMorePages) {
    const params = {
      jql,
      maxResults: 100,
      fields: 'assignee,resolutiondate,issuetype,summary',
    };

    if (nextPageToken) {
      params.nextPageToken = nextPageToken;
    }

    const response = await getFromJiraAPI('/rest/api/3/search/jql', { params });

    if (Array.isArray(response?.data?.issues)) {
      issues.push(...response.data.issues);
    }

    nextPageToken = response?.data?.nextPageToken || null;
    hasMorePages = !!nextPageToken && !response?.data?.isLast;
  }

  return issues;
}

/**
 * Checks if a date string is a valid date.
 * @param {string} dateString The date string to validate.
 * @returns {boolean} True if the date string is valid, false otherwise.
 */
function isValidDate(dateString) {
  const date = new Date(dateString);
  return !isNaN(date.getTime());
}

/**
 * Fetch all known contributors for a given project.
 *
 * @param {string} project The GitHub project that we want to fetch contributors for.
 * @returns An array of all contributors for the project.
 */
async function fetchAllContributors(project) {
  let contributors = [];
  let page = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    try {
      const response = await getFromGitHubAPI(
        `/repos/${project.replace('@', '')}/contributors`,
        {
          params: {
            per_page: 100, // Maximum number of results per page
            page: page,
          },
        }
      );

      contributors = contributors.concat(response.data);

      // Check if there are more pages
      const linkHeader = response.headers.link;
      hasMorePages = linkHeader && linkHeader.includes('rel="next"');
      page++;
    } catch (error) {
      console.error(
        `Error fetching contributors for ${project}:`,
        error.message
      );
      hasMorePages = false;
    }
  }

  return contributors;
}

/**
 * Fetch all pull requests for a given repository.
 *
 * @param {string} repo The repository to fetch pull requests for.
 * @returns An array of all pull requests for the repository.
 */
async function fetchAllPullRequests(repo) {
  let pullRequests = [];
  let page = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    try {
      const response = await getFromGitHubAPI(
        `/search/issues?q=repo:${repo.replace('@', '')}+draft:false+is:pr+created:${_START_DATE}..${_END_DATE}`,
        {
          params: {
            per_page: 100,
            page: page,
          },
        }
      );

      // Handle rate-limit or non-200 responses with retry
      if (response?.status === 403 || response?.status === 429) {
        const retryAfter = parseInt(
          response.headers?.['retry-after'] || '60',
          10
        );
        console.warn(
          `${_cFgYellow}Search rate limit hit for ${repo}, waiting ${retryAfter}s...${_cReset}`
        );
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue; // retry same page
      }

      if (!response?.data?.items) {
        console.warn(
          `${_cFgYellow}Unexpected search response for ${repo} page ${page}, skipping${_cReset}`
        );
        hasMorePages = false;
        continue;
      }

      pullRequests = pullRequests.concat(response.data.items);

      // Check if there are more pages
      const linkHeader = response.headers?.link;
      hasMorePages = linkHeader && linkHeader.includes('rel="next"');
      page++;
    } catch (error) {
      // Retry once on rate-limit errors
      if (error?.response?.status === 403 || error?.response?.status === 429) {
        const retryAfter = parseInt(
          error.response.headers?.['retry-after'] || '60',
          10
        );
        console.warn(
          `${_cFgYellow}Search rate limit hit for ${repo}, waiting ${retryAfter}s...${_cReset}`
        );
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      console.error('Error fetching pull requests:', error.message || error);
      hasMorePages = false;
    }
  }

  return pullRequests;
}

/**
 * File extensions that should be excluded from lines-of-code (LOC) tallies.
 * These are typically auto-generated dependency manifests (e.g. package.json,
 * package-lock.json, composer.lock) whose line counts don't reflect actual
 * authored code changes.
 */
const _LOC_EXCLUDED_EXTENSIONS = ['.lock', '.json'];

/**
 * Determines whether a file's changes should be excluded from LOC tallies
 * based on its extension (e.g. `.lock`, `.json` manifest files).
 *
 * @param {string} filename The path/filename of the changed file.
 * @returns {boolean} True if the file should be excluded from LOC counts.
 */
function isLOCExcludedFile(filename) {
  if (!filename) {
    return false;
  }

  const ext = path.extname(filename).toLowerCase();
  return _LOC_EXCLUDED_EXTENSIONS.includes(ext);
}

/**
 * Fetches the per-file change list for a pull request and sums the
 * additions/deletions, excluding files whose extension is in
 * `_LOC_EXCLUDED_EXTENSIONS` (e.g. `.lock`, `.json` manifests) so that
 * dependency lockfile/manifest churn doesn't inflate LOC counts.
 *
 * @param {string} prUrl The `pull_request.url` (or `pulls/:number`) API URL for the PR.
 * @returns {Promise<number>} The total LOC (additions + deletions) for the PR,
 * excluding manifest/lockfile changes.
 */
async function getFilteredPullRequestLOC(prUrl) {
  let loc = 0;
  let page = 1;
  let hasMorePages = true;
  const basePath = prUrl.replace('https://api.github.com', '');

  while (hasMorePages) {
    try {
      const response = await getFromGitHubAPI(`${basePath}/files`, {
        params: {
          per_page: 100,
          page: page,
        },
      });

      const files = Array.isArray(response?.data) ? response.data : [];

      files.forEach(file => {
        if (isLOCExcludedFile(file?.filename)) {
          return;
        }

        const additions = file?.additions ? +file.additions : 0;
        const deletions = file?.deletions ? +file.deletions : 0;
        loc += additions + deletions;
      });

      const linkHeader = response?.headers?.link;
      hasMorePages = linkHeader && linkHeader.includes('rel="next"');
      page++;
    } catch (error) {
      console.error(
        `Error fetching PR files for ${basePath}:`,
        error.message || error
      );
      hasMorePages = false;
    }
  }

  return loc;
}

/**
 * Informs you whether a given project exists on the local disk or not. If not,
 * it will clone it from the remote origin.
 *
 * @param {string} project The project name excluding the owner handle.
 * @returns A promise that resolves when the project is discovered.
 */
function discoverProject(project) {
  scopeName = getScopeName(project);
  packageName = getPackageName(project);

  // Make sure the projects are loaded
  if (!isValidDirectoryPath(path.join(_CONFIG.directory, packageName))) {
    console.log(`Cloning ${_cFgBlue}${project}${_cReset}...`);

    return new Promise((resolve, reject) => {
      executeCommand(
        `git clone git@github.com:${scopeName ? `${scopeName}/` : ''}${getPackageName(project)}.git`,
        _CONFIG.directory
      )
        .then(() => {
          // Make sure the results object is defined
          if (!_RESULTS) {
            _RESULTS = {};
          }

          // Make sure the project is defined in the results object
          if (!_RESULTS[project]) {
            _RESULTS[project] = {};
          }

          resolve(project);
        })
        .catch(error => {
          reject(error);
        });
    });
  } else {
    console.log(`Project ${_cFgGreen}${project}${_cReset} was discovered.`);
    return Promise.resolve(project);
  }
}

// ----- main execution functions -----

/**
 * Validates the configured GitHub API token by calling /rate_limit.
 * - Resolves on success (200) and logs remaining rate-limit quota.
 * - Rejects with a descriptive error on 401 / 403.
 * - Resolves on network errors (warn-only, so offline runs are not blocked).
 *
 * @returns {Promise<void>}
 */
async function _validateToken() {
  if (!_CONFIG?.tokens?.github) return;

  let response;
  try {
    response = await fetch('https://api.github.com/rate_limit', {
      headers: { Authorization: `token ${_CONFIG.tokens.github}` },
    });
  } catch {
    console.warn(
      `\n${_cFgYellow}Warning: could not reach GitHub to validate the token (network error). Proceeding anyway.${_cReset}\n`
    );
    return;
  }

  if (response.status === 401 || response.status === 403) {
    console.error(
      `\n${_cFgRed}✗ GitHub token is invalid or expired.${_cReset}`
    );
    console.error(
      `  Update ${_cFgYellow}tokens.github${_cReset} in config.json with a new Personal Access Token.`
    );
    console.error(`  Generate one at: https://github.com/settings/tokens`);
    console.error(
      `  Required scopes: ${_cFgYellow}repo${_cReset} + ${_cFgYellow}read:org${_cReset}\n`
    );
    const err = new Error('GitHub token is invalid or expired');
    err.code = 'TOKEN_INVALID';
    throw err;
  }

  const data = await response.json();
  console.log(`\n${_cFgBlue}GitHub API${_cReset} rate limits:`);
  console.log(
    `Used ${data.rate.used} out of ${data.rate.limit} GitHub core requests. Reset time: ${new Date(data.rate.reset * 1000).toLocaleString()}`
  );
  console.log(
    `Used ${data.resources.search.used} out of ${data.resources.search.limit} GitHub search requests. Reset time: ${new Date(data.resources.search.reset * 1000).toLocaleString()}\n`
  );
}

/**
 * Function to configure the application based on the configuration file stored
 * at ./config.json.
 */
function _configureApp() {
  const configFilePath = path.join(__dirname, 'config.json');
  // Synchronously read the file
  const configFileContent = fs.readFileSync(configFilePath, 'utf8');

  // Check if the file path exists
  if (!fs.existsSync(configFilePath)) {
    console.error('Config file does not exist:', configFilePath);
    process.exit(1); // Exit the process with an error code
  }

  // Parse the JSON content
  _CONFIG = JSON.parse(configFileContent);

  // Confirm that the directory configuration is valid
  if (
    !_CONFIG ||
    !_CONFIG.directory ||
    !isValidDirectoryPath(_CONFIG.directory)
  ) {
    console.error('Invalid directory path provided in the configuration file.');
    process.exit(1);
  }

  // Confirm that the start date is valid
  if (!_CONFIG.startDate || !isValidDate(_CONFIG.startDate)) {
    console.error('Invalid startDate provided in the configuration file.');
    process.exit(1);
  }

  // Confirm that the end date is valid
  if (!_CONFIG.endDate || !isValidDate(_CONFIG.endDate)) {
    console.error('Invalid endDate provided in the configuration file.');
    process.exit(1);
  }

  // Configure any aliases as a reverse look-up map
  if (_CONFIG?.aliases) {
    _ALIASES = {};

    Object.keys(_CONFIG.aliases).forEach(key => {
      const values = _CONFIG.aliases[key];

      if (values && values.length > 0) {
        values.forEach(value => {
          value = removeEmailAccount(value.toLowerCase()).trim();
          _ALIASES[value] = removeEmailAccount(key.toLowerCase()).trim();
        });
      }
    });
  }

  // Configure the set of alias names flagged as bots (config.json botUsers).
  // botUsers is a flat list of existing alias keys (e.g. "DevOps Deployment")
  // -- not raw GitHub logins -- so it is resolved against the alias names
  // populated above, not against _CONFIG.aliases' values.
  _BOT_ALIASES = new Set(
    (_CONFIG?.botUsers || []).map(alias => String(alias).toLowerCase().trim())
  );

  // Accept the start and end dates that have already been validated above
  _START_DATE = _CONFIG.startDate;
  _END_DATE = _CONFIG.endDate;

  // Allow CLI overrides: --start YYYY-MM-DD --end YYYY-MM-DD
  const args = process.argv.slice(2);
  const startIdx = args.indexOf('--start');
  const endIdx = args.indexOf('--end');
  const skipCache =
    args.includes('--skip-cache') ||
    process.env.npm_config_skip_cache === 'true';
  const noSkipCache =
    args.includes('--no-skip-cache') ||
    process.env.npm_config_no_skip_cache === 'true';

  if (skipCache && noSkipCache) {
    console.error('Cannot use both --skip-cache and --no-skip-cache together.');
    process.exit(1);
  }

  if (skipCache) {
    _CONFIG.skipCache = true;
  }

  if (noSkipCache) {
    _CONFIG.skipCache = false;
  }

  if (
    startIdx !== -1 &&
    args[startIdx + 1] &&
    isValidDate(args[startIdx + 1])
  ) {
    _START_DATE = args[startIdx + 1];
  }
  if (endIdx !== -1 && args[endIdx + 1] && isValidDate(args[endIdx + 1])) {
    _END_DATE = args[endIdx + 1];
  }

  if (skipCache || noSkipCache) {
    console.log(
      `Cache override from CLI: skipCache=${_CONFIG.skipCache ? 'true' : 'false'}`
    );
  }

  // Cap end date at today so we never query future data
  const today = new Date().toISOString().slice(0, 10);
  if (_END_DATE > today) {
    console.log(`End date ${_END_DATE} is in the future — capping at ${today}`);
    _END_DATE = today;
  }

  if (!_RESULTS) {
    _RESULTS = {};
  }

  // write some metadata about the results
  if (_RESULTS) {
    _RESULTS['_report_info'] = {
      start_date: _START_DATE,
      end_date: _END_DATE,
    };
  }

  // Configure the GitHub API
  if (_CONFIG?.tokens?.github) {
    _GITHUB_API = rateLimit(
      axios.create({
        baseURL: 'https://api.github.com',
        headers: {
          Authorization: `token ${_CONFIG.tokens.github}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }),
      {
        maxRequests: 5,
        perMilliseconds: 2000,
      }
    );

    // create a specific API instance for the slower search rate limit (30 per minute)
    _GITHUB_SEARCH_API = rateLimit(
      axios.create({
        baseURL: 'https://api.github.com',
        headers: {
          Authorization: `token ${_CONFIG.tokens.github}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }),
      {
        maxRequests: 28,
        perMilliseconds: 60000,
      }
    );

    // Token validation and rate-limit display happen in _validateToken(),
    // called before _processProjects() in the primary execution block.
  } else {
    console.warn(
      'GitHub API token not configured. Consider adding config.json .tokens.github for more stats!'
    );
  }

  _configureJira();
}

/**
 * Configure the optional Jira integration.
 *
 * The integration is entirely opt-in: when `jira` or `tokens.jira` is missing or
 * incomplete we warn and continue so that a configuration without Jira behaves
 * exactly as it did before the integration existed.
 */
function _configureJira() {
  const jira = _CONFIG?.jira;
  const credentials = _CONFIG?.tokens?.jira;

  if (!jira && !credentials) {
    // Jira is simply not in use for this configuration — stay quiet.
    return;
  }

  if (!jira?.baseUrl) {
    console.warn(
      `${_cFgYellow}Jira is partially configured: missing jira.baseUrl. Skipping issue resolution metrics.${_cReset}`
    );
    return;
  }

  if (!Array.isArray(jira.projects) || jira.projects.length === 0) {
    console.warn(
      `${_cFgYellow}Jira is partially configured: jira.projects must be a non-empty array of project keys. Skipping issue resolution metrics.${_cReset}`
    );
    return;
  }

  if (!credentials?.email || !credentials?.apiToken) {
    console.warn(
      `${_cFgYellow}Jira is partially configured: missing tokens.jira.email or tokens.jira.apiToken. Skipping issue resolution metrics.${_cReset}`
    );
    return;
  }

  let baseURL;
  try {
    baseURL = new URL(jira.baseUrl).origin;
  } catch {
    console.warn(
      `${_cFgYellow}Invalid jira.baseUrl "${jira.baseUrl}". Skipping issue resolution metrics.${_cReset}`
    );
    return;
  }

  const auth = Buffer.from(
    `${credentials.email}:${credentials.apiToken}`
  ).toString('base64');

  _JIRA_API = rateLimit(
    axios.create({
      baseURL,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    }),
    {
      // Jira Cloud allows roughly 10 requests/second per user; stay conservative
      // and match the pacing already used for the GitHub core API.
      maxRequests: 5,
      perMilliseconds: 2000,
    }
  );

  _JIRA_ENABLED = true;
}

/**
 * Validates the configured Jira credentials by calling /rest/api/3/myself.
 *
 * A failure here disables the Jira pass for the run rather than aborting the
 * whole gather, so a stale Atlassian token never costs you your GitHub data.
 *
 * @returns {Promise<void>}
 */
async function _validateJiraToken() {
  if (!_JIRA_ENABLED) {
    return;
  }

  try {
    const response = await _JIRA_API.get('/rest/api/3/myself');
    console.log(
      `\n${_cFgBlue}Jira API${_cReset} authenticated as ${response?.data?.displayName || 'unknown user'}.\n`
    );
  } catch (error) {
    const status = error?.response?.status;

    if (status === 401 || status === 403) {
      console.error(
        `\n${_cFgRed}✗ Jira credentials are invalid or expired.${_cReset}`
      );
      console.error(
        `  Update ${_cFgYellow}tokens.jira.email${_cReset} and ${_cFgYellow}tokens.jira.apiToken${_cReset} in config.json.`
      );
      console.error(
        `  Generate a token at: https://id.atlassian.com/manage-profile/security/api-tokens`
      );
    } else {
      console.warn(
        `\n${_cFgYellow}Warning: could not reach Jira to validate credentials.${_cReset}`
      );
    }

    console.warn(
      `${_cFgYellow}Continuing without issue resolution metrics.${_cReset}\n`
    );
    _JIRA_ENABLED = false;
  }
}

/**
 * Save the current contents of _RESULTS to a new file in the results directory.
 */
function _saveResults() {
  const resultsDir = path.join(__dirname, '.results_history');

  // Check if the .results_history folder exists, if not, create it
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
  }

  // Derive filename from the date range
  let resultsFilePath = '';

  if (!!_CONFIG?.resultsName) {
    // Legacy: use explicit resultsName if provided
    resultsFilePath = path.join(resultsDir, `${_CONFIG?.resultsName}.json`);
  } else if (_START_DATE && _END_DATE) {
    resultsFilePath = path.join(resultsDir, `${_START_DATE}_${_END_DATE}.json`);
  } else {
    const timestamp = Date.now();
    resultsFilePath = path.join(resultsDir, `results_${timestamp}.json`);
  }

  // Write the contents of the _RESULTS object to the new file
  fs.writeFileSync(resultsFilePath, JSON.stringify(_RESULTS, null, 2), 'utf8');

  console.log(`\nResults saved to ${_cFgGreen}${resultsFilePath}${_cReset}!`);
}

function _processProjects() {
  const processingProjects = [];
  const processingPullRequests = [];
  const processingContributors = [];
  const processingPullRequestDetails = [];

  const pullRequests = [];
  const contributors = [];

  // Set some defaults for totalCommits and totalPullRequests
  if (!_RESULTS.totalCommits) {
    _RESULTS.totalCommits = 0;
  }
  if (!_RESULTS.totalPullRequests) {
    _RESULTS.totalPullRequests = 0;
  }

  if (_CONFIG && _CONFIG.projects) {
    _CONFIG.projects.forEach(project => {
      // Make sure that the project has an entry
      if (!_RESULTS[project]) {
        _RESULTS[project] = {};
      }

      // Set some defaults for commits for the project
      if (!_RESULTS[project].commits) {
        _RESULTS[project].commits = 0;
      }

      // Process projects for git analysis
      processingProjects.push(
        new Promise((resolve, reject) => {
          discoverProject(project)
            .then(project => {
              let packageName = getPackageName(project);

              // Count the commits in the project
              executeCommand(
                `git log --since="${_START_DATE}T00:00:00-00:00" --until="${_END_DATE}T00:00:00-00:00" --pretty=format:"" | wc -l | xargs`,
                path.join(_CONFIG.directory, packageName)
              )
                .then(commits => {
                  // Do some validation ont he commits output to ensure we stay numeric
                  if (!commits || isNaN(commits)) {
                    commits = 0;
                  } else {
                    commits = parseInt(commits);
                  }

                  _RESULTS.totalCommits += commits;
                  _RESULTS[project].commits += commits;

                  // Get the list of users that contributed to the project
                  executeCommand(
                    `git log --since="${_START_DATE}T00:00:00-00:00" --until="${_END_DATE}T00:00:00-00:00" --format='%cN <%cE>' | sort -u`,
                    path.join(_CONFIG.directory, packageName)
                  )
                    .then(users => {
                      users = users.split('\n');

                      processUserCommits(packageName, project)
                        .then(() => {
                          // we are complete processing commits
                          resolve();
                        })
                        .catch(error => {
                          console.error(
                            `Error processing user commits for ${project}:`,
                            error
                          );
                          resolve();
                        });
                    })
                    .catch(error => {
                      console.error(
                        `Error fetching users for ${project}:`,
                        error
                      );
                      resolve();
                    });
                })
                .catch(error => {
                  console.error(
                    `Error counting commits for ${project}:`,
                    error
                  );
                  resolve();
                });
            })
            .catch(error => {
              console.error(`Error discovering ${project}:`, error);
              resolve();
            });
        })
      );

      // Fetch all contributors for all known projects
      processingContributors.push(
        new Promise((contResolve, contReject) => {
          fetchAllContributors(project)
            .then(projectContributors => {
              projectContributors.forEach(contributor => {
                if (contributors.indexOf(contributor.login) === -1) {
                  contributors.push(contributor.login);
                }
              });

              contResolve();
            })
            .catch(error => {
              console.error(
                `Error fetching contributors for ${project}:`,
                error
              );
              contResolve();
            });
        })
      );

      // Fetch all pull requests for all known projects
      processingPullRequests.push(
        new Promise((prResolve, prReject) => {
          fetchAllPullRequests(project)
            .then(projectPullRequests => {
              pullRequests.push(...projectPullRequests);

              prResolve();
            })
            .catch(error => {
              console.error(
                `Error fetching pull requests for ${project}:`,
                error
              );
              prResolve();
            });
        })
      );
    });

    if (_CONFIG?.projects?.length > 0) {
      console.log(`Fetching stats on ${_CONFIG.projects.length} projects...`);
    } else {
      console.warn('No projects found in the configuration.');
    }
  }

  return Promise.all(
    processingProjects
      .concat(processingPullRequests)
      .concat(processingContributors)
  ).then(() => {
    // track the total number of pull requests with 1+ reviews for the range
    _RESULTS.totalPullRequests = 0;

    contributors.forEach(contributor => {
      const alias = getAliasForUser(contributor);

      if (!_RESULTS.users[alias]) {
        _RESULTS.users[alias] = {};
      }

      if (!_RESULTS.users[alias].pullRequests) {
        _RESULTS.users[alias].pullRequests = 0;
      }

      if (!_RESULTS.users[alias].pendingCommits) {
        _RESULTS.users[alias].pendingCommits = 0;
      }

      if (!_RESULTS.users[alias].loc) {
        _RESULTS.users[alias].loc = 0;
      }

      if (!_RESULTS.users[alias].filesTouched) {
        _RESULTS.users[alias].filesTouched = 0;
      }

      if (!_RESULTS.users[alias].approvals) {
        _RESULTS.users[alias].approvals = 0;
      }

      if (!_RESULTS.users[alias].feedback) {
        _RESULTS.users[alias].feedback = 0;
      }

      // Churn sub-metrics (repo-hero's first "negative" metric). These are
      // intentionally raw/uncombined here -- score.js's calculateChurn()
      // applies the weighting and calculateScore() subtracts the composite
      // from the user's overall score. Only eligible PRs (merged, 1+ review,
      // 1+ approval) contribute to these -- see the churn eligibility check
      // below.
      if (!_RESULTS.users[alias].churnOpenDurationDays) {
        _RESULTS.users[alias].churnOpenDurationDays = 0;
      }

      if (!_RESULTS.users[alias].churnFeedbackReviews) {
        _RESULTS.users[alias].churnFeedbackReviews = 0;
      }

      if (!_RESULTS.users[alias].churnNonBotComments) {
        _RESULTS.users[alias].churnNonBotComments = 0;
      }

      if (!_RESULTS.users[alias].repoBreakdown) {
        _RESULTS.users[alias].repoBreakdown = {};
      }

      if (!_RESULTS.users[alias].pullRequestList) {
        _RESULTS.users[alias].pullRequestList = [];
      }

      try {
        const userPullRequests = pullRequests.filter(
          pr =>
            pr.user.login === contributor &&
            new Date(pr.created_at) >= new Date(_START_DATE) &&
            new Date(pr.created_at) <= new Date(_END_DATE) &&
            !pr.draft // Exclude draft pull requests
        );

        // tally up lines of code change and fetch reviews
        userPullRequests.forEach(pr => {
          const repoName = extractRepoName(pr);
          processingPullRequestDetails.push(
            new Promise(prdResolve => {
              getFromGitHubAPI(
                `${pr.pull_request.url.replace('https://api.github.com', '')}`
              )
                .then(async prdResponse => {
                  const changedFiles = prdResponse?.data.changed_files
                    ? +prdResponse?.data.changed_files
                    : 0;

                  // Tally LOC from the per-file change list so that manifest
                  // files (.lock, .json) don't inflate the LOC count.
                  const filteredLoc = await getFilteredPullRequestLOC(
                    pr.pull_request.url
                  );

                  _RESULTS.users[alias].loc += filteredLoc;
                  _RESULTS.users[alias].filesTouched += changedFiles;

                  // Track per-repo loc and filesTouched
                  if (repoName) {
                    if (!_RESULTS.users[alias].repoBreakdown[repoName]) {
                      _RESULTS.users[alias].repoBreakdown[repoName] = {
                        pullRequests: 0,
                        approvals: 0,
                        feedback: 0,
                        commits: 0,
                        loc: 0,
                        filesTouched: 0,
                      };
                    }
                    _RESULTS.users[alias].repoBreakdown[repoName].loc +=
                      filteredLoc;
                    _RESULTS.users[alias].repoBreakdown[
                      repoName
                    ].filesTouched += changedFiles;
                  }

                  if (!prdResponse?.data.merged) {
                    _RESULTS.users[alias].pendingCommits += prdResponse?.data
                      .commits
                      ? +prdResponse?.data.commits
                      : 0;
                  }

                  // get reviews for the pr and then resolve
                  getFromGitHubAPI(
                    `${pr.pull_request.url.replace('https://api.github.com', '')}/reviews`
                  )
                    .then(prReviewResponse => {
                      const reviews = Array.isArray(prReviewResponse?.data)
                        ? prReviewResponse.data
                        : [];

                      // Only count pull requests that have 1+ reviews
                      if (reviews.length > 0) {
                        _RESULTS.totalPullRequests++;
                        _RESULTS.users[alias].pullRequests++;
                        _RESULTS.users[alias].pullRequestList.push({
                          title: pr.title,
                          url: pr.html_url,
                          number: pr.number,
                          repo: repoName,
                          createdAt: pr.created_at,
                          mergedAt: prdResponse?.data.merged_at || null,
                        });

                        if (repoName) {
                          if (!_RESULTS.users[alias].repoBreakdown[repoName]) {
                            _RESULTS.users[alias].repoBreakdown[repoName] = {
                              pullRequests: 0,
                              approvals: 0,
                              feedback: 0,
                              commits: 0,
                              loc: 0,
                              filesTouched: 0,
                            };
                          }
                          _RESULTS.users[alias].repoBreakdown[repoName]
                            .pullRequests++;
                        }
                      }

                      reviews.forEach(review => {
                        const isApproval = review?.state === 'APPROVED';
                        const isFeedback =
                          review?.state === 'CHANGES_REQUESTED' ||
                          (review?.state === 'COMMENTED' &&
                            typeof review?.body === 'string' &&
                            review.body.trim().length > 0);

                        if (!isApproval && !isFeedback) {
                          return;
                        }

                        const reviewerAlias = getAliasForUser(
                          review?.user?.login
                        );
                        if (!reviewerAlias) {
                          return;
                        }

                        if (!_RESULTS.users[reviewerAlias]) {
                          _RESULTS.users[reviewerAlias] = {};
                        }

                        if (!_RESULTS.users[reviewerAlias].approvals) {
                          _RESULTS.users[reviewerAlias].approvals = 0;
                        }

                        if (!_RESULTS.users[reviewerAlias].feedback) {
                          _RESULTS.users[reviewerAlias].feedback = 0;
                        }

                        if (!_RESULTS.users[reviewerAlias].repoBreakdown) {
                          _RESULTS.users[reviewerAlias].repoBreakdown = {};
                        }

                        if (isApproval) {
                          _RESULTS.users[reviewerAlias].approvals++;
                        } else if (isFeedback) {
                          _RESULTS.users[reviewerAlias].feedback++;
                        }

                        // Track per-repo approvals and feedback
                        if (repoName) {
                          if (
                            !_RESULTS.users[reviewerAlias].repoBreakdown[
                              repoName
                            ]
                          ) {
                            _RESULTS.users[reviewerAlias].repoBreakdown[
                              repoName
                            ] = {
                              pullRequests: 0,
                              approvals: 0,
                              feedback: 0,
                              commits: 0,
                              loc: 0,
                              filesTouched: 0,
                            };
                          }
                          if (isApproval) {
                            _RESULTS.users[reviewerAlias].repoBreakdown[
                              repoName
                            ].approvals++;
                          } else if (isFeedback) {
                            _RESULTS.users[reviewerAlias].repoBreakdown[
                              repoName
                            ].feedback++;
                          }
                        }
                      });

                      // ─── Churn (negative metric) ──────────────────────
                      // Only PRs that are merged, have 1+ review, and have
                      // at least one APPROVED review are eligible to
                      // generate churn -- this is a stricter set than the
                      // "Pull Requests" metric above (which only requires
                      // 1+ reviews) and is scoped to churn eligibility only.
                      const hasApproval = reviews.some(
                        review => review?.state === 'APPROVED'
                      );
                      const isChurnEligiblePR =
                        prdResponse?.data?.merged === true &&
                        reviews.length > 0 &&
                        hasApproval;

                      if (!isChurnEligiblePR) {
                        return undefined;
                      }

                      const feedbackReviewCount = reviews.filter(
                        review =>
                          review?.state === 'CHANGES_REQUESTED' ||
                          (review?.state === 'COMMENTED' &&
                            typeof review?.body === 'string' &&
                            review.body.trim().length > 0)
                      ).length;

                      const openDurationDays =
                        prdResponse?.data?.merged_at &&
                        prdResponse?.data?.created_at
                          ? (new Date(prdResponse.data.merged_at) -
                              new Date(prdResponse.data.created_at)) /
                            (1000 * 60 * 60 * 24)
                          : 0;

                      _RESULTS.users[alias].churnOpenDurationDays +=
                        openDurationDays;
                      _RESULTS.users[alias].churnFeedbackReviews +=
                        feedbackReviewCount;

                      // Conversation (issue) comments are fetched separately
                      // from review data -- they represent back-and-forth
                      // discussion on the PR that is not tied to a formal
                      // review submission. Comments authored by a configured
                      // bot alias (config.json botUsers) are excluded so
                      // automated tooling (CI bots, dependency bots, etc.)
                      // doesn't inflate churn.
                      if (!pr.comments_url) {
                        return undefined;
                      }

                      return getFromGitHubAPI(
                        pr.comments_url.replace(
                          'https://api.github.com',
                          ''
                        )
                      )
                        .then(prCommentsResponse => {
                          const comments = Array.isArray(
                            prCommentsResponse?.data
                          )
                            ? prCommentsResponse.data
                            : [];

                          const nonBotCommentCount = comments.filter(
                            comment => {
                              const commentAlias = getAliasForUser(
                                comment?.user?.login
                              );
                              return !_BOT_ALIASES.has(commentAlias);
                            }
                          ).length;

                          _RESULTS.users[alias].churnNonBotComments +=
                            nonBotCommentCount;
                        })
                        .catch(() => {});
                    })
                    .catch(() => {})
                    .finally(() => {
                      prdResolve();
                    });
                })
                .catch(error => {
                  prdResolve();
                });
            })
          );
        });
      } catch (error) {
        console.error(
          `Error processing pull requests for user ${contributor}:`,
          error.message
        );
      }
    });

    return Promise.all(processingPullRequestDetails);
  });
}

/**
 * Fetch and tally the issue resolutions recorded within the reporting window
 * across every configured Jira project.
 *
 * Each issue is attributed to its assignee, normalized through the same alias
 * map used for git authors and GitHub logins, so a person's tickets roll up into
 * the same user record as the rest of their contributions.
 *
 * @returns {Promise<void>}
 */
async function _processJiraProjects() {
  if (!_JIRA_ENABLED) {
    return;
  }

  const projects = _CONFIG.jira.projects;

  console.log(
    `Fetching issue resolutions from ${projects.length} Jira projects...`
  );

  if (!_RESULTS.users) {
    _RESULTS.users = {};
  }

  if (!_RESULTS.totalIssueResolutions) {
    _RESULTS.totalIssueResolutions = 0;
  }

  let unassigned = 0;

  for (const projectKey of projects) {
    let issues = [];

    try {
      issues = await fetchCompletedJiraIssues(projectKey);
    } catch (error) {
      console.error(
        `Error fetching Jira issues for project ${projectKey}:`,
        error?.response?.data?.errorMessages || error.message
      );
      continue;
    }

    issues.forEach(issue => {
      const alias = getAliasForJiraUser(issue?.fields?.assignee);

      if (!alias) {
        unassigned++;
        return;
      }

      if (!_RESULTS.users[alias]) {
        _RESULTS.users[alias] = {};
      }

      if (!_RESULTS.users[alias].issueResolutions) {
        _RESULTS.users[alias].issueResolutions = 0;
      }

      if (!_RESULTS.users[alias].resolutionBreakdown) {
        _RESULTS.users[alias].resolutionBreakdown = {};
      }

      if (!_RESULTS.users[alias].resolutionBreakdown[projectKey]) {
        _RESULTS.users[alias].resolutionBreakdown[projectKey] = 0;
      }

      _RESULTS.users[alias].issueResolutions++;
      _RESULTS.users[alias].resolutionBreakdown[projectKey]++;
      _RESULTS.totalIssueResolutions++;
    });

    console.log(
      `  ${_cFgGray}${projectKey}: ${issues.length} issue resolutions${_cReset}`
    );
  }

  if (unassigned > 0) {
    console.log(
      `  ${_cFgYellow}${unassigned} resolved issues had no assignee and were not attributed.${_cReset}`
    );
  }
}

function processUserCommits(packageName, project) {
  return new Promise((resolve, reject) => {
    executeCommand(
      `git log --since='${_START_DATE}T00:00:00-00:00' --until='${_END_DATE}T23:59:59-00:00' --pretty=format:"%an"`,
      path.join(_CONFIG.directory, packageName)
    )
      .then(userCommits => {
        const users = [];
        userCommits = userCommits.split('\n');
        userCommits = userCommits.reduce((acc, author) => {
          // Push all of the original authors to a list so we can process them uniquely
          if (author && users.indexOf(author) === -1) {
            users.push(author);
          }

          // Convert the author into an alias author
          author = getAliasForUser(author);
          if (!acc[author]) {
            acc[author] = 0;
          }
          acc[author]++;

          // Ensure that users array is configured
          if (!_RESULTS.users) {
            _RESULTS.users = {};
          }

          // Make sure the user has a specific entry
          if (!_RESULTS.users[author]) {
            _RESULTS.users[author] = {};
          }

          // Make sure the commits are defined for the user
          if (!_RESULTS.users[author].commits) {
            _RESULTS.users[author].commits = 0;
          }

          return acc;
        }, {});

        Object.keys(userCommits).forEach(author => {
          _RESULTS.users[author].commits += userCommits[author];

          // Track per-repo commits
          if (!_RESULTS.users[author].repoBreakdown) {
            _RESULTS.users[author].repoBreakdown = {};
          }
          const repoName = project || packageName;
          if (!_RESULTS.users[author].repoBreakdown[repoName]) {
            _RESULTS.users[author].repoBreakdown[repoName] = {
              pullRequests: 0,
              approvals: 0,
              feedback: 0,
              commits: 0,
              loc: 0,
              filesTouched: 0,
            };
          }
          _RESULTS.users[author].repoBreakdown[repoName].commits +=
            userCommits[author];
        });

        resolve();
      })
      .catch(error => {
        console.error(`Error counting commits for ${packageName}:`, error);
        resolve(); // gracefully continue instead of crashing the pipeline
      });
  });
}

// ----- primary execution of the script -----

// Configuration steps before running the main logic of the script
_configureApp();

// Validate the GitHub token, then process projects.
// If the token is invalid, process.exit(1) fires before .finally() so no
// partial result file is written and no existing files are overwritten.
_validateToken()
  .then(() => _validateJiraToken())
  .then(() => _processProjects())
  .then(() =>
    _processJiraProjects().catch(error => {
      // Never let a Jira failure discard an otherwise successful GitHub gather.
      console.error('Error processing Jira projects:', error.message);
    })
  )
  .catch(() => {
    process.exit(1);
  })
  .finally(() => {
    // calculate the commits per pull request for the period
    if (!!_RESULTS.totalCommits && !!_RESULTS.totalPullRequests) {
      _RESULTS.commitsPerPullRequest =
        _RESULTS.totalCommits / _RESULTS.totalPullRequests;
    } else {
      _RESULTS.commitsPerPullRequest = 0;
    }

    _RESULTS.predictedPullRequests =
      _CONFIG.commitsPerPullRequest && !isNaN(_CONFIG.commitsPerPullRequest)
        ? _RESULTS.totalCommits / _CONFIG.commitsPerPullRequest
        : _RESULTS.totalCommits / _RESULTS.commitsPerPullRequest;
    _RESULTS.activeUsers = 0;
    _RESULTS.teamScore = 0;

    if (!_RESULTS.totalIssueResolutions) {
      _RESULTS.totalIssueResolutions = 0;
    }

    // assess the results for all users
    if (!!_RESULTS?.users) {
      Object.keys(_RESULTS.users).forEach(user => {
        // make sure the name is defined
        _RESULTS.users[user].name = user;

        // make sure commits is defined
        if (!_RESULTS.users[user].commits) {
          _RESULTS.users[user].commits = 0;
        }

        // make sure approvals and feedback are defined
        if (!_RESULTS.users[user].approvals) {
          _RESULTS.users[user].approvals = 0;
        }

        if (!_RESULTS.users[user].feedback) {
          _RESULTS.users[user].feedback = 0;
        }

        // make sure loc is defined
        if (!_RESULTS.users[user].loc) {
          _RESULTS.users[user].loc = 0;
        }

        // make sure completed jira issues are defined
        if (!_RESULTS.users[user].issueResolutions) {
          _RESULTS.users[user].issueResolutions = 0;
        }

        // calculate the user score
        _RESULTS.users[user].score = calculateScore(_RESULTS.users[user]);

        // make sure that the score is defined
        if (!_RESULTS.users[user].score) {
          _RESULTS.users[user].score = 0;
        }

        // we have an active user
        if (_RESULTS.users[user].score > 0) {
          _RESULTS.activeUsers++;
        }

        _RESULTS.teamScore += _RESULTS.users[user].score;
      });

      // ensure team score is defined and numeric
      if (!_RESULTS.teamScore) {
        _RESULTS.teamScore = 0;
      }

      // Convert the _RESULTS.users object to an array of user objects
      const usersArray = Object.values(_RESULTS.users);

      // Sort the array by score in descending order
      usersArray.sort((a, b) => b.score - a.score);

      // Optionally, convert the sorted array back to an object
      const sortedUsers = {};
      usersArray.forEach(user => {
        sortedUsers[user.id] = user; // Assuming each user object has a unique 'id' property
      });

      // splice out each ignored user
      if (_CONFIG?.ignoreUsers) {
        let index = -1;
        _CONFIG.ignoreUsers.forEach(user => {
          index = usersArray.findIndex(
            obj => obj['name'] === user?.toLowerCase()
          );

          if (index !== -1) {
            if (usersArray[index]?.score > 0) {
              // if the ignored user had a score, it was previously counted as active, so reduce
              _RESULTS.activeUsers--;
              _RESULTS.teamScore -= usersArray[index].score;
            }

            usersArray.splice(index, 1);
          }
        });
      }

      // calculate the team score average from the remaining active users
      if (_RESULTS.activeUsers > 0) {
        _RESULTS.teamScore /= _RESULTS.activeUsers;
      } else {
        _RESULTS.teamScore = 0;
      }

      // Assign the sorted object back to _RESULTS.users
      _RESULTS.users = usersArray;
    }

    // Save results to the hidden directory for later reference
    _saveResults();
  });
