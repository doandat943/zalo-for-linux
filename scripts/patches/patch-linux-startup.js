const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_DIST_DIR = path.join(APP_DIR, 'main-dist');

const REQUIRED_STARTUP_FILES = [
  'bootstrap.js',
  path.join('main-dist', 'main.js'),
  path.join('main-dist', 'preload-render.js'),
  path.join('pc-dist', 'index.html'),
  path.join('pc-dist', 'login.html')
];

// Zalo's backend currently has no usable Linux desktop client profile. The
// rest of this project wraps the macOS distribution, so Linux processes must
// consistently identify as the macOS desktop client (23). Previously this was
// patched only in main.js from patch-db-cross-v4, leaving compact-app and media
// utility processes on Linux type 25. That mismatch can break startup/session
// hand-off when one of those processes initializes first.
const LINUX_CLIENT_TYPE_PATTERN = /case"LINUX":return (\d+);/g;
const COMPATIBLE_CLIENT_TYPE = 23;

function assertStartupLayout(appDir = APP_DIR) {
  const missing = REQUIRED_STARTUP_FILES.filter((relativePath) =>
    !fs.existsSync(path.join(appDir, relativePath))
  );

  if (missing.length > 0) {
    throw new Error(`Zalo startup files are missing: ${missing.join(', ')}`);
  }
}

function patchClientType(content, fileName) {
  let matchCount = 0;
  const patched = content.replace(LINUX_CLIENT_TYPE_PATTERN, (_match, currentType) => {
    matchCount += 1;
    const parsedType = Number(currentType);
    if (parsedType !== 25 && parsedType !== COMPATIBLE_CLIENT_TYPE) {
      throw new Error(
        `Unexpected Linux client type ${currentType} in ${fileName}; ` +
        'review the upstream platform mapping before building.'
      );
    }
    return `case"LINUX":return ${COMPATIBLE_CLIENT_TYPE};`;
  });

  return { content: patched, matchCount, changed: patched !== content };
}

async function main() {
  logger.info('Checking Zalo startup compatibility for Linux...');
  assertStartupLayout();

  const bundles = fs.readdirSync(MAIN_DIST_DIR)
    .filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => path.join(MAIN_DIST_DIR, fileName));

  let mappingCount = 0;
  let patchedFileCount = 0;
  let mainMappingFound = false;

  for (const filePath of bundles) {
    const original = fs.readFileSync(filePath, 'utf8');
    const result = patchClientType(original, path.basename(filePath));
    if (result.matchCount === 0) continue;

    mappingCount += result.matchCount;
    if (path.basename(filePath) === 'main.js') mainMappingFound = true;
    if (result.changed) {
      fs.writeFileSync(filePath, result.content, 'utf8');
      patchedFileCount += 1;
      logger.dim(`Patched Linux client type in ${path.basename(filePath)}`);
    }
  }

  if (!mainMappingFound) {
    throw new Error('Could not find the Linux client type mapping in main-dist/main.js.');
  }
  if (mappingCount === 0) {
    throw new Error('No Zalo platform mappings were found; upstream startup layout may have changed.');
  }

  logger.success(
    `Linux startup check passed (${mappingCount} mapping(s), ${patchedFileCount} file(s) updated)`
  );
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Linux startup patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = { main, assertStartupLayout, patchClientType };
