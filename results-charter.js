const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');

// Load JSON data
const data = JSON.parse(fs.readFileSync(path.join('.results_history', 'combined_results.json'), 'utf8'));

// Initialize objects for each CSV file
const trendingScore = {};
const trendingCommits = {};
const trendingPullRequests = {};
const trendingFilesTouched = {};
const trendingReviews = {};
const trendingLoc = {};
const trendingTeamScore = {};

// Loop through JSON data
for (const [key, value] of Object.entries(data)) {
  let date = key.split('/').pop();  // Extract date from key
  date = date.slice(0, 7);  // Remove the day part

  if (value.users) {
    for (const user of value.users) {
      const name = user.name;

      if (!trendingScore[name]) {
        trendingScore[name] = {};
        trendingCommits[name] = {};
        trendingPullRequests[name] = {};
        trendingFilesTouched[name] = {};
        trendingReviews[name] = {};
        trendingLoc[name] = {};
      }

      trendingScore[name][date] = user.score || 0;
      trendingCommits[name][date] = user.commits || 0;
      trendingPullRequests[name][date] = user.pullRequests || 0;
      trendingFilesTouched[name][date] = user.filesTouched || 0;
      trendingReviews[name][date] = user.reviews || 0;
      trendingLoc[name][date] = user.loc || 0;
    }
  }

  // Add teamScore to trendingTeamScore
  if (!trendingTeamScore[date]) {
    trendingTeamScore[date] = value.teamScore || 0;
  }
}

// Function to write object to CSV
const writeCsv = (filename, dataObj, isTeamScore = false) => {
  const dates = Array.from(new Set(Object.keys(dataObj))).sort();
  const csvWriter = createCsvWriter({
    path: path.join('.results_history', filename),
    header: isTeamScore
      ? [{ id: 'date', title: 'date' }, { id: 'teamScore', title: 'teamScore' }]
      : [{ id: 'name', title: 'name' }, ...dates.map(date => ({ id: date, title: date }))]
  });

  const records = isTeamScore
    ? dates.map(date => ({ date, teamScore: dataObj[date] }))
    : Object.entries(dataObj).map(([name, dates]) => ({ name, ...dates }));

  csvWriter.writeRecords(records);
};

// Write each object to its respective CSV file
writeCsv('trending_score.csv', trendingScore);
writeCsv('trending_commits.csv', trendingCommits);
writeCsv('trending_pullRequests.csv', trendingPullRequests);
writeCsv('trending_filesTouched.csv', trendingFilesTouched);
writeCsv('trending_reviews.csv', trendingReviews);
writeCsv('trending_loc.csv', trendingLoc);
writeCsv('trending_teamScore.csv', trendingTeamScore, true);