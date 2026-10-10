const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { patchStrings } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/**
 * Keep ZaDark loaded when Zalo switches to its dark theme (fixes #66).
 *
 * Zalo's dark theme component calls a helper that removes every
 * link[href^="zadark"] and script[src^="zadark"] from the page (the selectors
 * are spelled out character by character). With the desktop in dark mode
 * (patch-auto-theme follows it), ZaDark lost its CSS and icon font right
 * after startup: its sidebar button stayed as an empty slot and the message
 * translation was gone.
 *
 * The helper is found by that character array and turned into a no-op.
 * Only applied to the ZaDark variant (from build.js integrateZaDark).
 */
const MARKER = '"z","a","d","a","r","k"';

const REPLACEMENTS = [
  // Disable the helper that removes ZaDark elements in dark theme
  {
    from: new RegExp(
      '(\\b[\\w$]+=\\(\\)=>\\{)' +
      '(var [\\w$,]+;const [\\w$]+=\\["l","i","n","k","\\[","h","r","e","f","\\^","=",\'"\',"z","a","d","a","r","k",\'"\',"\\]"\\]\\.join\\(""\\))',
      'g'
    ),
    to: '$1return;$2'
  }
];

function listJsFiles(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(listJsFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

async function main() {
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  if (!fs.existsSync(pcDistDir)) {
    logger.warn('pc-dist not present, skipping ZaDark keep patch');
    return;
  }

  let matchedFiles = 0;
  for (const file of listJsFiles(pcDistDir)) {
    const content = fs.readFileSync(file, 'utf8');
    if (!content.includes(MARKER)) continue;
    patchStrings(file, REPLACEMENTS, `Kept ZaDark in dark theme: ${path.relative(pcDistDir, file)}`);
    matchedFiles++;
  }

  if (matchedFiles > 0) {
    logger.success(`ZaDark kept in Zalo's dark theme (${matchedFiles} files)`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
