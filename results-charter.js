const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');

// Load JSON data
const data = JSON.parse(
  fs.readFileSync(
    path.join('.results_history', 'combined_results.json'),
    'utf8'
  )
);

// Initialize objects for each CSV file
const trendingScore = {};
const trendingCommits = {};
const trendingPullRequests = {};
const trendingFilesTouched = {};
const trendingApprovals = {};
const trendingFeedback = {};
const trendingLoc = {};
const trendingIssueResolutions = {};

// Loop through JSON data
for (const [key, value] of Object.entries(data)) {
  if (value.users) {
    for (const user of value.users) {
      const name = user.name;
      let date = key.split('/').pop(); // Extract date from key
      date = date.slice(0, 7); // Remove the day part

      if (!trendingScore[name]) {
        trendingScore[name] = {};
        trendingCommits[name] = {};
        trendingPullRequests[name] = {};
        trendingFilesTouched[name] = {};
        trendingApprovals[name] = {};
        trendingFeedback[name] = {};
        trendingLoc[name] = {};
        trendingIssueResolutions[name] = {};
      }

      trendingScore[name][date] = user.score || 0;
      trendingCommits[name][date] = user.commits || 0;
      trendingPullRequests[name][date] = user.pullRequests || 0;
      trendingFilesTouched[name][date] = user.filesTouched || 0;
      trendingApprovals[name][date] = user.approvals || 0;
      trendingFeedback[name][date] = user.feedback || 0;
      trendingLoc[name][date] = user.loc || 0;
      trendingIssueResolutions[name][date] = user.issueResolutions || 0;
    }
  }
}

// Function to write object to CSV
const writeCsv = (filename, dataObj) => {
  const dates = Array.from(
    new Set(Object.values(dataObj).flatMap(Object.keys))
  ).sort();
  const csvWriter = createCsvWriter({
    path: path.join('.results_history', filename),
    header: [
      { id: 'name', title: 'name' },
      ...dates.map(date => ({ id: date, title: date })),
    ],
  });

  const records = Object.entries(dataObj).map(([name, dates]) => ({
    name,
    ...dates,
  }));
  csvWriter.writeRecords(records);
};

const outputFiles = [
  'trending_score.csv',
  'trending_commits.csv',
  'trending_pullRequests.csv',
  'trending_filesTouched.csv',
  'trending_approvals.csv',
  'trending_feedback.csv',
  'trending_loc.csv',
  'trending_issueResolutions.csv',
];

outputFiles.forEach(outputFilePath => {
  if (fs.existsSync(outputFilePath)) {
    fs.unlinkSync(outputFilePath);
  }
});

// Write each object to its respective CSV file
writeCsv('trending_score.csv', trendingScore);
writeCsv('trending_commits.csv', trendingCommits);
writeCsv('trending_pullRequests.csv', trendingPullRequests);
writeCsv('trending_filesTouched.csv', trendingFilesTouched);
writeCsv('trending_approvals.csv', trendingApprovals);
writeCsv('trending_feedback.csv', trendingFeedback);
writeCsv('trending_loc.csv', trendingLoc);
writeCsv('trending_issueResolutions.csv', trendingIssueResolutions);
