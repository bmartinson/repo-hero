const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const exec = require('child_process').exec;
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
let _RESULTS = {}; // any (results_timestamp.json)
let _GITHUB_API = null; // axios instance for the GitHub API
let _GITHUB_SEARCH_API = null; // axios instance for the GitHub API
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
 * Executes a shell command and returns a promise that resolves with the response.
 *
 * @param {string} command The command to execute.
 * @param {string} directory The directory to execute the script in.
 * @returns {Promise<string>} A promise that resolves with the command's standard output.
 */
async function executeCommand(command, directory) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: directory }, (error, stdout) => {
      if (error) {
        reject(`Error executing command: ${error.message}`);
        return;
      }
      resolve(stdout);
    });
  });
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

  if (!_CACHE) {
    _CACHE = {};

    try {
      const files = fs.readdirSync(cacheDir);
      const jsonFiles = files.filter(file => path.extname(file) === '.json');
      const jsonData = jsonFiles.map(file => {
        const filePath = path.join(cacheDir, file);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(fileContent);
      });

      Object.values(jsonData).forEach(data => {
        Object.keys(data).forEach(key => {
          _CACHE[key] = data[key];
        });
      });
    } catch (error) {
      _CACHE = {};
    }
  }

  if (_CONFIG?.skipCache && _CACHE[key]) {
    if (options) {
      console.log(
        `Re-using cached data from GitHub API: ${_cFgYellow}${req}${_cReset} with options: ${JSON.stringify(options)}`
      );
    } else {
      console.log(
        `Re-using cached data from GitHub API: ${_cFgYellow}${req}${_cReset}`
      );
    }

    return _CACHE[key];
  }

  try {
    // Generate the unique filename for results caching
    const timestamp = Date.now();
    const uuid = uuidv4();
    const filename = `cache_${timestamp}_${uuid}.json`;

    if (options) {
      console.log(
        `Fetching data from GitHub API: ${_cFgBlue}${req}${_cReset} with options: ${JSON.stringify(options)}`
      );
    } else {
      console.log(
        `Fetching data from GitHub API: ${_cFgBlue}${req}${_cReset}`
      );
    }

    console.log(`  ${_cFgGray}Cached at: ./results_cache/${filename}${_cReset}\n`);

    const response = req.startsWith('/search/')
      ? await _GITHUB_SEARCH_API.get(req, options)
      : await _GITHUB_API.get(req, options);

    if (response?.status !== 200) {
      return response;
    }

    _CACHE[key] = { data: response.data, headers: response.headers };

    const saveData = {};
    saveData[key] = _CACHE[key];

    // Convert _CACHE to JSON string
    const cacheData = JSON.stringify(saveData, null, 2);

    // Check if the .results_cache folder exists, if not, create it
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir);
    }

    // Create the filename with the current Unix timestamp
    const cacheFilePath = path.join(
      cacheDir,
      filename
    );

    // Write the JSON string to cache_xxx_yyy.json
    fs.writeFile(cacheFilePath, cacheData, () => {});

    return response;
  } catch (error) {
    throw error;
  }
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
            per_page: 100, // Maximum number of results per page
            page: page,
          },
        }
      );

      pullRequests = pullRequests.concat(response.data.items);

      // Check if there are more pages
      const linkHeader = response.headers.link;
      hasMorePages = linkHeader && linkHeader.includes('rel="next"');
      page++;
    } catch (error) {
      console.error('Error fetching pull requests:', error);
      hasMorePages = false;
    }
  }

  return pullRequests;
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

  // Accept the start and end dates that have already been validated above
  _START_DATE = _CONFIG.startDate;
  _END_DATE = _CONFIG.endDate;

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

    // create a specific API instance for a slower search rate limit (30 per minute)
    _GITHUB_SEARCH_API = rateLimit(
      axios.create({
        baseURL: 'https://api.github.com',
        headers: {
          Authorization: `token ${_CONFIG.tokens.github}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }),
      {
        maxRequests: 30,
        perMilliseconds: 30000,
      }
    );

    fetch('https://api.github.com/rate_limit', {
      headers: {
        Authorization: `token ${_CONFIG.tokens.github}`,
      },
    })
      .then(response => response.json())
      .then(data => {
        console.log(`\n${_cFgBlue}GitHub API${_cReset} rate limits:`);
        console.log(
          `Used ${data.rate.used} out of ${data.rate.limit} GitHub core requests. Reset time: ${new Date(data.rate.reset * 1000).toLocaleString()}`
        );
        console.log(
          `Used ${data.resources.search.used} out of ${data.resources.search.limit} GitHub search requests. Reset time: ${new Date(data.resources.search.reset * 1000).toLocaleString()}\n`
        );
      })
      .catch(error => console.error('Error!', error));
  } else {
    console.warn(
      'GitHub API token not configured. Consider adding config.json .tokens.github for more stats!'
    );
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

  // Create the filename with the current Unix timestamp
  const timestamp = Date.now();
  let resultsFilePath = '';

  if (!!_CONFIG?.resultsName) {
    resultsFilePath = path.join(resultsDir, `${_CONFIG?.resultsName}.json`);
  } else {
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

  // Set some defaults for totalCommits
  if (!_RESULTS.totalCommits) {
    _RESULTS.totalCommits = 0;
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

                      processUserCommits(packageName)
                        .then(() => {
                          // we are complete processing commits
                          resolve();
                        })
                        .catch(error => {
                          console.error(
                            `Error processing user commits for ${project}:`,
                            error
                          );
                          reject(error);
                        });
                    })
                    .catch(error => {
                      console.error(
                        `Error fetching users for ${project}:`,
                        error
                      );
                      reject(error);
                    });
                })
                .catch(error => {
                  console.error(
                    `Error counting commits for ${project}:`,
                    error
                  );
                  reject(error);
                });
            })
            .catch(error => {
              console.error(`Error discovering ${project}:`, error);
              reject(error);
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
              contReject();
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
              prReject();
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
    const rangedPullRequests = pullRequests.filter(
      pr =>
        new Date(pr.created_at) >= new Date(_START_DATE) &&
        new Date(pr.created_at) <= new Date(_END_DATE)
    );

    // track the total number of pull requests for the range
    _RESULTS.totalPullRequests = rangedPullRequests.length;

    contributors.forEach(contributor => {
      const alias = getAliasForUser(contributor);

      if (!_RESULTS.users[alias]) {
        _RESULTS.users[alias] = {};
      }

      if (!_RESULTS.users[alias].pullRequests) {
        _RESULTS.users[alias].pullRequests = 0;
      }

      if (!_RESULTS.users[alias].loc) {
        _RESULTS.users[alias].loc = 0;
      }

      if (!_RESULTS.users[alias].filesTouched) {
        _RESULTS.users[alias].filesTouched = 0;
      }

      if (!_RESULTS.users[alias].reviews) {
        _RESULTS.users[alias].reviews = 0;
      }

      try {
        const userPullRequests = pullRequests.filter(
          pr =>
            pr.user.login === contributor &&
            new Date(pr.created_at) >= new Date(_START_DATE) &&
            new Date(pr.created_at) <= new Date(_END_DATE) &&
            !pr.draft // Exclude draft pull requests
        );

        // count the pull requests
        _RESULTS.users[alias].pullRequests += userPullRequests.length;

        // tally up lines of code change
        userPullRequests.forEach(pr => {
          processingPullRequestDetails.push(
            new Promise(prdResolve => {
              getFromGitHubAPI(
                `${pr.pull_request.url.replace('https://api.github.com', '')}`
              )
                .then(prdResponse => {
                  _RESULTS.users[alias].loc += prdResponse?.data.additions
                    ? +prdResponse?.data.additions
                    : 0;
                  _RESULTS.users[alias].loc += prdResponse?.data.deletions
                    ? +prdResponse?.data.deletions
                    : 0;
                  _RESULTS.users[alias].filesTouched += prdResponse?.data
                    .changed_files
                    ? +prdResponse?.data.changed_files
                    : 0;

                  // get reviews for the pr and then resolve
                  getFromGitHubAPI(
                    `${pr.pull_request.url.replace('https://api.github.com', '')}/reviews`
                  )
                    .then(prReviewResponse => {
                      if (Array.isArray(prReviewResponse?.data)) {
                        prReviewResponse?.data?.forEach(review => {
                          const reviewerAlias = getAliasForUser(
                            review.user.login
                          );

                          if (!_RESULTS.users[reviewerAlias]) {
                            _RESULTS.users[reviewerAlias] = {};
                          }

                          if (!_RESULTS.users[reviewerAlias].reviews) {
                            _RESULTS.users[reviewerAlias].reviews = 0;
                          }

                          // count the review
                          _RESULTS.users[reviewerAlias].reviews++;
                        });
                      }
                    })
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

function processUserCommits(packageName) {
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
        });

        resolve();
      })
      .catch(error => {
        console.error(`Error counting commits for ${packageName}:`, error);
        reject();
      });
  });
}

// ----- primary execution of the script -----

// Configuration steps before running the main logic of the script
_configureApp();

// Process all projects as configured
_processProjects().finally(() => {
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

  // assess the results for all users
  if (!!_RESULTS?.users) {
    Object.keys(_RESULTS.users).forEach(user => {
      // make sure the name is defined
      _RESULTS.users[user].name = user;

      // make sure commits is defined
      if (!_RESULTS.users[user].commits) {
        _RESULTS.users[user].commits = 0;
      }

      // make sure reviews are defined
      if (!_RESULTS.users[user].reviews) {
        _RESULTS.users[user].reviews = 0;
      }

      // make sure loc is defined
      if (!_RESULTS.users[user].loc) {
        _RESULTS.users[user].loc = 0;
      }

      // calculate the user score
      _RESULTS.users[user].score =
        (_RESULTS.users[user].loc > 1000000
          ? _RESULTS.users[user].loc / 800
          : _RESULTS.users[user].loc / 100) +
        _RESULTS.users[user].filesTouched / 100 +
        _RESULTS.users[user].pullRequests * 15 +
        _RESULTS.users[user].commits / 100 +
        (_RESULTS.users[user].commits / _RESULTS.commitsPerPullRequest) * 10 +
        // (_RESULTS.users[user].pullRequests ? _RESULTS.users[user].commits / _RESULTS.users[user].pullRequests / 10 : 0) + // account for divide by zero
        _RESULTS.users[user].reviews * 10;

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

    _RESULTS.teamScore /= _RESULTS.activeUsers;

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
          }

          usersArray.splice(index, 1);
        }
      });
    }

    // Assign the sorted object back to _RESULTS.users
    _RESULTS.users = usersArray;
  }

  // Save results to the hidden directory for later reference
  _saveResults();
});
