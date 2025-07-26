const fs = require('fs');
const path = require('path');

const resultsDir = path.join(__dirname, '.results_history');
const outputCsv = path.join(
  __dirname,
  '.results_history/active_users_by_date.csv'
);

const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));

const rows = [['start_date', 'activeUsers']];

files.forEach(file => {
  const filePath = path.join(resultsDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const startDate = data._report_info?.start_date || '';
  const activeUsers = data.activeUsers ?? '';
  rows.push([startDate, activeUsers]);
});

fs.writeFileSync(outputCsv, rows.map(r => r.join(',')).join('\n'));
console.log(`CSV written to ${outputCsv}`);
