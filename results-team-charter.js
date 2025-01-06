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
const trendingTeamScore = {};
const totalPullRequests = {};
const predictedPullRequests = {};
const predictedDeliverablesPerActiveUser = {};

// Loop through JSON data
for (const [key, value] of Object.entries(data)) {
  let date = key.split('/').pop(); // Extract date from key
  date = date.slice(0, 7); // Remove the day part

  // Add teamScore to trendingTeamScore
  if (!trendingTeamScore[date]) {
    trendingTeamScore[date] = +value.teamScore > 0 ? +value.teamScore : 0 || 0;
  }

  // Add totalPullRequests to totalPullRequests
  if (!totalPullRequests[date]) {
    totalPullRequests[date] = value.totalPullRequests || 0;
  }

  // Add predictedPullRequests to predictedPullRequests
  if (!predictedPullRequests[date]) {
    predictedPullRequests[date] = value.predictedPullRequests || 0;
  }

  // Add predictedDeliverablesPerActiveUser to predictedDeliverablesPerActiveUser
  if (!predictedDeliverablesPerActiveUser[date]) {
    predictedDeliverablesPerActiveUser[date] =
      +value.activeUsers > 0
        ? value.predictedPullRequests / value.activeUsers
        : 0 || 0;
  }
}

// Function to write object to CSV
const writeCsv = (filename, dataObj, isTeamScore = false) => {
  const dates = Array.from(new Set(Object.keys(dataObj))).sort();
  const csvWriter = createCsvWriter({
    path: path.join('.results_history', filename),
    header: [
      { id: 'date', title: 'date' },
      { id: 'value', title: 'value' },
    ],
  });

  const records = dates.map(date => ({ date, value: dataObj[date] }));

  csvWriter.writeRecords(records);
};

const outputFiles = [
  'trending_teamScore.csv',
  'trending_teamPullRequests.csv',
  'trending_teamPredictedPullRequests.csv',
  'trending_teamPredictedDeliverablesPerActiveUser.csv',
];

outputFiles.forEach(outputFilePath => {
  if (fs.existsSync(outputFilePath)) {
    fs.unlinkSync(outputFilePath);
  }
});

// Write each object to its respective CSV file
writeCsv('trending_teamScore.csv', trendingTeamScore, true);
writeCsv('trending_teamPullRequests.csv', totalPullRequests);
writeCsv('trending_teamPredictedPullRequests.csv', predictedPullRequests);
writeCsv(
  'trending_teamPredictedDeliverablesPerActiveUser.csv',
  predictedDeliverablesPerActiveUser
);
