const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function updateConfig(dateString) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  let startDate, endDate, resultsName;

  if (/^\d{4}$/.test(dateString)) {
    // Four digit year case
    const year = dateString;
    startDate = `${year}-01-01`;
    endDate = `${year}-12-31`;
    resultsName = `${year}`;
  } else if (/^\d{4}-\d{2}$/.test(dateString)) {
    // YYYY-MM case
    const [year, month] = dateString.split('-');
    const lastDay = new Date(year, month, 0).getDate();
    if (month === '02' && isLeapYear(parseInt(year))) {
      startDate = `${year}-${month}-01`;
      endDate = `${year}-${month}-29`;
    } else {
      startDate = `${year}-${month}-01`;
      endDate = `${year}-${month}-${lastDay}`;
    }
    resultsName = `${dateString}`;
  } else {
    throw new Error('Invalid date format. Use YYYY or YYYY-MM.');
  }

  config.startDate = `${startDate}`;
  config.endDate = `${endDate}`;
  config.resultsName = `${resultsName}`;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log('Config updated successfully.');
}

// Example usage: node configurator.js 2024 or node configurator.js 2024-01
const dateString = process.argv[2];
if (!dateString) {
  console.error('Please provide a date string.');
  process.exit(1);
}

try {
  updateConfig(dateString);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
