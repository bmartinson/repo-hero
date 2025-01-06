const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, '.results_history');
const outputFilePath = path.join(resultsDir, 'combined_results.json');

const combinedResults = {};

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

  files.forEach(file => {
    if (file === 'combined_results.json') {
      // Skip the combined results file
      return;
    }

    const filePath = path.join(resultsDir, file);

    if (filePath.toLowerCase().indexOf('.ds_store') >= 0) {
      return;
    }

    const fileNameWithoutExt = path.parse(file).name;

    // Read and parse each JSON file
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const jsonContent = JSON.parse(fileContent);

    // Add the content to the combinedResults object
    combinedResults[fileNameWithoutExt] = jsonContent;
  });

  // Write the combined results to a new JSON file
  fs.writeFileSync(
    outputFilePath,
    JSON.stringify(combinedResults, null, 2),
    'utf-8'
  );
  console.log('Combined results saved to', outputFilePath);
});
