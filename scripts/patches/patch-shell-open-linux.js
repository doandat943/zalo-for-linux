const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { patchStrings } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_DIR = path.join(APP_DIR, 'main-dist');

const REPLACEMENTS = [
  // Linux folder opening: when path is a directory, use shell.openPath() instead of macOS/Windows logic
  {
    from: /(function (\w+)\(e\)\{return \w+\.shell\.openPath\(e\)\}[\s\S]*?if\((\w+)\)\{)(?:if\("linux"===process\.platform&&\3\.isDirectory\(\)\)return \2\(e\);)?if\(!\3\.isDirectory\(\)\)\{/,
    to: '$1if("linux"===process.platform&&$3.isDirectory())return $2(e);if(!$3.isDirectory()){'
  }
];

async function main() {
  logger.info('Patching Linux folder opening...');
  if (!fs.existsSync(MAIN_DIR)) {
    throw new Error('Main bundle directory not found.');
  }

  const bundlePaths = fs.readdirSync(MAIN_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(MAIN_DIR, name))
    .filter((filePath) => {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.includes('Mz8P:function') && content.includes('shell.openPath');
    });

  if (bundlePaths.length === 0) {
    throw new Error('No shell bundles found.');
  }

  for (const filePath of bundlePaths) {
    patchStrings(filePath, REPLACEMENTS, `Linux folder opening in ${path.relative(APP_DIR, filePath)}`);
  }

  logger.success(
    `Linux folder-opening patch applied (${bundlePaths.length} checked)`
  );
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Linux folder-opening patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  main
};
