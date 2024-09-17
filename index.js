const exec = require('child_process').exec;
const fs = require('fs');
const path = require('path');

// ----- nodejs helper variables -----
_cReset = "\x1b[0m"
_cBright = "\x1b[1m"
_cDim = "\x1b[2m"
_cUnderscore = "\x1b[4m"
_cBlink = "\x1b[5m"
_cReverse = "\x1b[7m"
_cHidden = "\x1b[8m"
_cFgBlack = "\x1b[30m"
_cFgRed = "\x1b[31m"
_cFgGreen = "\x1b[32m"
_cFgYellow = "\x1b[33m"
_cFgBlue = "\x1b[34m"
_cFgMagenta = "\x1b[35m"
_cFgCyan = "\x1b[36m"
_cFgWhite = "\x1b[37m"
_cFgGray = "\x1b[90m"
_cBgBlack = "\x1b[40m"
_cBgRed = "\x1b[41m"
_cBgGreen = "\x1b[42m"
_cBgYellow = "\x1b[43m"
_cBgBlue = "\x1b[44m"
_cBgMagenta = "\x1b[45m"
_cBgCyan = "\x1b[46m"
_cBgWhite = "\x1b[47m"
_cBgGray = "\x1b[100m"

// ----- global variables -----
_START_DATE = null // string | null (YYYY-MM-DD)
_END_DATE = null // string | null (YYYY-MM-DD)
_CONFIG = null; // any (config.json)
_ALIASES = {}; // { key: [value: string[]] }
_RESULTS = {}; // any (results_timestamp.json)

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
 * Checks if a date string is a valid date.
 * @param {string} dateString The date string to validate.
 * @returns {boolean} True if the date string is valid, false otherwise.
 */
function isValidDate(dateString) {
  const date = new Date(dateString);
  return !isNaN(date.getTime());
}

// ----- main execution functions -----

/**
 * Function to configure the application based on the configuration file stored
 * at ./config.json.
 */
function _configureApp() {
  const configFilePath = path.join(__dirname, 'config.json')
  // Synchronously read the file
  const configFileContent = fs.readFileSync(
    configFilePath,
    'utf8',
  );

  // Check if the file path exists
  if (!fs.existsSync(configFilePath)) {
    console.error('Config file does not exist:', configFilePath);
    process.exit(1); // Exit the process with an error code
  }

  // Parse the JSON content
  _CONFIG = JSON.parse(configFileContent);

  // Confirm that the directory configuration is valid
  if (!_CONFIG || !_CONFIG.directory || !isValidDirectoryPath(_CONFIG.directory)) {
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

    Object.keys(_CONFIG.aliases).forEach((key) => {
      const values = _CONFIG.aliases[key];

      if (values && values.length > 0) {
        values.forEach((value) => {
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
}

/**
 * Function to configure the application based on runtime parameters passed in
 * during execution.
 */
// function _configureRunTime() {
//   /**
//    * When launching the application, loop over the arguments provided to find the
//    * right run time arguments to run the application with.
//    */
//   if (process.argv && process.argv.length > 0) {
//     for (let i = 0; i < process.argv.length; i++) {
//       if (String(process.argv[i]).startsWith("--year=")) {
//         _YEAR = process.argv[i].substring(String("--year=").length, String(process.argv[i]).length);
//       }
//     }
//   }

//   if (!_YEAR || isNaN(_YEAR)) {
//     console.error("Invalid year provided. Please provide a valid year using `--year=YYYY`");
//     process.exit(1);
//   } else {
//     // Make sure the year is an integer
//     _YEAR = parseInt(_YEAR);
//   }
// }

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
  const resultsFilePath = path.join(resultsDir, `results_${timestamp}.json`);

  // Write the contents of the _RESULTS object to the new file
  fs.writeFileSync(resultsFilePath, JSON.stringify(_RESULTS, null, 2), 'utf8');
}

function _processProjects() {
  const processingProjects = [];

  if (_CONFIG && _CONFIG.projects) {
    _CONFIG.projects.forEach((project) => {
      processingProjects.push(
        new Promise((resolve, reject) => {
          discoverProject(project).then((project) => {
            let packageName = getPackageName(project);

            // Count the commits in the project
            executeCommand(`git log --since="${_START_DATE}T00:00:00-00:00" --until="${_END_DATE}T00:00:00-00:00" --pretty=format:"" | wc -l | xargs`, path.join(_CONFIG.directory, packageName)).then((commits) => {
              // Do some validation ont he commits output to ensure we stay numeric
              if (!commits || isNaN(commits)) {
                commits = 0;
              } else {
                commits = parseInt(commits);
              }

              // Set some defaults for totalCommits
              if (!_RESULTS.totalCommits) {
                _RESULTS.totalCommits = 0;
              }

              // Make sure that the project has an entry
              if (!_RESULTS[project]) {
                _RESULTS[project] = {};
              }

              // Set some defaults for commits for the project
              if (!_RESULTS[project].commits) {
                _RESULTS[project].commits = 0;
              }

              _RESULTS.totalCommits += commits;
              _RESULTS[project].commits += commits;

              // Get the list of users that contributed to the project
              executeCommand(`git log --since="${_START_DATE}T00:00:00-00:00" --until="${_END_DATE}T00:00:00-00:00" --format='%cN <%cE>' | sort -u`, path.join(_CONFIG.directory, packageName)).then((users) => {
                users = users.split('\n');

                processUserCommits(packageName).then(() => {
                  // we are complete processing commits
                  resolve();
                }).catch((error) => {
                  console.error(`Error processing user commits for ${project}:`, error);
                  reject(error);
                });
              }).catch((error) => {
                console.error(`Error fetching users for ${project}:`, error);
                reject(error);
              });
            }).catch((error) => {
              console.error(`Error counting commits for ${project}:`, error);
              reject(error);
            });
          }).catch((error) => {
            console.error(`Error discovering ${project}:`, error);
            reject(error);
          });
        }),
      );
    });
  }

  return Promise.all(processingProjects);
}

function discoverProject(project) {
  scopeName = getScopeName(project);
  packageName = getPackageName(project);

  // Make sure the projects are loaded
  if (!isValidDirectoryPath(path.join(_CONFIG.directory, packageName))) {
    console.log(`Cloning ${_cFgBlue}${project}${_cReset}...`);

    return new Promise((resolve, reject) => {
      executeCommand(`git clone git@github.com:${scopeName ? `${scopeName}/` : ''}${getPackageName(project)}.git`, _CONFIG.directory).then(() => {
        // Make sure the results object is defined
        if (!_RESULTS) {
          _RESULTS = {};
        }

        // Make sure the project is defined in the results object
        if (!_RESULTS[project]) {
          _RESULTS[project] = {};
        }

        resolve(project);
      }).catch((error) => {
        reject(error);
      });
    });
  } else {
    console.log(`Project ${_cFgGreen}${project}${_cReset} was discovered.`);
    return Promise.resolve(project);
  }
}

function processUserCommits(packageName) {
  return new Promise((resolve, reject) => {
    executeCommand(`git log --since='${_START_DATE}T00:00:00-00:00' --until='${_END_DATE}T23:59:59-00:00' --pretty=format:"%an"`, path.join(_CONFIG.directory, packageName)).then((userCommits) => {
      userCommits = userCommits.split('\n');
      userCommits = userCommits.reduce((acc, author) => {
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

      Object.keys(userCommits).forEach((author) => {
        _RESULTS.users[author].commits += userCommits[author];
      });

      // Complete processing on the project
      resolve();
    }).catch((error) => {
      console.error(`Error counting commits for ${packageName}:`, error);
      reject();
    });
  });
}

// ----- primary execution of the script -----

// Configuration steps before running the main logic of the script
_configureApp();
// _configureRunTime();

// Process all projects as configured
_processProjects().then(() => {
  console.warn('~~~~~~~ COMPLETE ~~~~~~~');

  // Save results to the hidden directory for later reference
  _saveResults();
});
