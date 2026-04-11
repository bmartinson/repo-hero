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

console.clear();

console.log(`Commands:\n`);
console.log(
  `  ${_cFgBlue}config${_cReset}\t(re-configure dates in config.json)\n`
);
console.log(`  ${_cFgGreen}start${_cReset}\t\t(execute all)`);
console.log(
  `    ${_cFgGreen}gather${_cReset}\t(gather data and generate .results_history/*.json)`
);
console.log(`    \t\t  --start YYYY-MM-DD  (override start date)`);
console.log(`    \t\t  --end   YYYY-MM-DD  (override end date)`);
console.log(
  `    ${_cFgGreen}combine${_cReset}\t(re-generate combined results)`
);
console.log(`    ${_cFgGreen}chart${_cReset}\t(re-generate csv files)`);
console.log(`    ${_cFgGreen}dashboard${_cReset}\t(re-generate dashboard)`);
console.log(
  `    ${_cFgGreen}enrich${_cReset}\t(enrich historical data with PR predictions)`
);
console.log(
  `    ${_cFgGreen}reindex${_cReset}\t(re-index for alias/ignore changes)\n`
);
console.log(`  ${_cFgYellow}help${_cReset}\t\t(display this menu)`);

console.log('');
