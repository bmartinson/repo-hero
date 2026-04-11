const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, '.results_history');
const outputFilePath = path.join(resultsDir, 'combined_results.json');

// Check if combined_results.json exists and delete it if it does
if (fs.existsSync(outputFilePath)) {
  fs.unlinkSync(outputFilePath);
  console.log('Existing combined_results.json deleted');
}

// Read all files in the .results_history directory
fs.readdir(resultsDir, (err, files) => {
  if (err) {
    console.error('Error reading directory:', err);
    return;
  }

  // Collect entries with their start dates for sorting
  const entries = [];

  files.forEach(file => {
    if (file === 'combined_results.json') return;
    if (path.extname(file).toLowerCase() !== '.json') return;

    const filePath = path.join(resultsDir, file);
    if (filePath.toLowerCase().indexOf('.ds_store') >= 0) return;

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const jsonContent = JSON.parse(fileContent);

    // Use _report_info.start_date as the sort key (fall back to filename)
    const startDate =
      jsonContent?._report_info?.start_date ||
      path.parse(file).name.split('_')[0];

    entries.push({ startDate, key: path.parse(file).name, data: jsonContent });
  });

  // Sort by start date ascending
  entries.sort((a, b) => a.startDate.localeCompare(b.startDate));

  // Build the combined results in sorted order
  const combinedResults = {};
  entries.forEach(e => {
    combinedResults[e.key] = e.data;
  });

  // Write the combined results to a new JSON file
  fs.writeFileSync(
    outputFilePath,
    JSON.stringify(combinedResults, null, 2),
    'utf-8'
  );
  console.log('Combined results saved to', outputFilePath);
});
