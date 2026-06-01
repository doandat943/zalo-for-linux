const path = require('path');
const BASE_DIR = path.resolve(__dirname, '../..');

function formatPath(p) {
  if (typeof p !== 'string') return p;
  // Replace absolute path with relative path
  if (p.startsWith(BASE_DIR)) {
    let rel = p.slice(BASE_DIR.length);
    if (rel.startsWith('/')) rel = rel.slice(1);
    return rel || '.';
  }
  return p;
}

function cleanArgs(args) {
  return args.map(arg => {
    if (typeof arg === 'string') return formatPath(arg);
    return arg;
  });
}

module.exports = {
  step: (msg) => console.log(`\n\x1b[1m\x1b[34m==>\x1b[0m \x1b[1m${msg}\x1b[0m`),
  info: (...args) => console.log('  \x1b[36mℹ\x1b[0m', ...cleanArgs(args)),
  success: (...args) => console.log('  \x1b[32m✔\x1b[0m', ...cleanArgs(args)),
  warn: (...args) => console.warn('  \x1b[33m⚠\x1b[0m', ...cleanArgs(args)),
  error: (...args) => console.error('  \x1b[31m✖\x1b[0m', ...cleanArgs(args)),
  dim: (...args) => console.log('    \x1b[2m' + cleanArgs(args).join(' ') + '\x1b[0m'),
  formatPath
};
