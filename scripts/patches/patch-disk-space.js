const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { patchStrings, findTargetFiles } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // Measure Zalo data directory (~/.config/ZaloData); immutable distros can report 0 bytes free on /
  {
    from: /("7r\+T":function[\s\S]*?([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\("IpzU"\)[\s\S]*?analyzeMainDisk\(\)\{)let e="";e="\/";/,
    to: '$1let e=Object($2.getZaloDirSync)();'
  }
];

async function main() {
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const lazyDir = path.join(pcDistDir, 'lazy');

  if (!fs.existsSync(pcDistDir)) {
    logger.warn('pc-dist directory not found, skipping disk space patch');
    return;
  }

  const targetFiles = [
    ...findTargetFiles(pcDistDir, /^(compact-app-pc|search-worker|sync-v2-sub-worker)\..*\.js$/),
    ...findTargetFiles(lazyDir, /^default-login-main-startup-shared-worker-znotification\..*\.js$/)
  ];

  for (const filePath of targetFiles) {
    patchStrings(filePath, REPLACEMENTS, `disk space check: ${path.basename(filePath)}`);
  }

  if (targetFiles.length > 0) {
    logger.success(`Disk space patch applied (${targetFiles.length} files)`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Disk space patch failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
