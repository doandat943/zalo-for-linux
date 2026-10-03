const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

function patch(source) {
  const start = source.indexOf('EzwU:function');
  if (start < 0) return source;
  const end = source.indexOf('},F0Xa:function', start);
  if (end < 0) throw new Error('OCR module boundary changed');
  let module = source.slice(start, end);
  const visibility = 'show:"unsupported"!==e.support,disabled:"supported"!==e.support||"ready"!==e.scanStatus';
  const visible = 'show:!0,disabled:"supported"!==e.support||"ready"!==e.scanStatus';
  if (!module.includes(visibility) && !module.includes(visible)) {
    throw new Error('OCR button pattern changed');
  }
  module = module.replace(visibility, visible);
  const enabled = /\w+=\(\)=>!0;function/;
  const config = /(\w+=\(\)=>)\w+\.key\("is_enabled"\)\.value(?=;function)/;
  if (!config.test(module) && !enabled.test(module)) {
    throw new Error('OCR feature flag pattern changed');
  }
  module = module.replace(config, '$1!0');
  return source.slice(0, start) + module + source.slice(end);
}

function main() {
  logger.info('Patching OCR UI...');
  const root = path.join(APP_DIR, 'pc-dist');
  const changes = [];
  let found = 0;
  const files = [
    ...fs.readdirSync(root)
      .filter(name => /^(compact-app-pc|search-worker|sync-v2-sub-worker)\.[\da-f]+\.js$/.test(name)),
    ...fs.readdirSync(path.join(root, 'lazy'))
      .filter(name => /^default-login-main-startup-shared-worker-znotification\.[\da-f]+\.js$/.test(name))
      .map(name => path.join('lazy', name)),
  ];
  for (const entry of files) {
    const file = path.join(root, entry);
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('EzwU:function')) continue;
    const updated = patch(source);
    found++;
    if (updated !== source) changes.push([file, updated]);
  }
  if (!found) throw new Error('No OCR bundles found in pc-dist');
  // Validate every bundle before writing any changes.
  for (const [file, updated] of changes) {
    fs.writeFileSync(file, updated);
    logger.dim(`Patched ${path.relative(APP_DIR, file)}`);
  }
  logger.success(`OCR UI: ${changes.length} patched, ${found - changes.length} already patched.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    logger.error('Failed to patch OCR UI', error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
