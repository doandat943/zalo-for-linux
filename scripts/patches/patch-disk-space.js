const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const PC_DIST_DIR = path.join(__dirname, '..', '..', 'app', 'pc-dist');

function patchDiskSpace(content) {
  if (!content.includes('analyzeMainDisk(){')) return content;

  const start = content.indexOf('"7r+T":function');
  const method = content.indexOf('analyzeMainDisk(){', start);
  if (start === -1 || method === -1) {
    throw new Error('Disk checker module not found.');
  }
  const imports = content.slice(start, method);
  const pathModule = imports.match(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\("IpzU"\)/);
  if (!pathModule) throw new Error('Disk checker path module import not found.');

  // Measure Zalo's data filesystem; immutable / can correctly report zero free bytes.
  const replacement = `analyzeMainDisk(){let e=Object(${pathModule[1]}.getZaloDirSync)();`;
  const remainder = content.slice(method);
  if (remainder.startsWith(replacement)) return content;
  const rootPath = /^analyzeMainDisk\(\)\{let e="";e="\/";/;
  if (!rootPath.test(remainder)) throw new Error('Disk checker root path anchor not found.');
  return content.slice(0, method) + remainder.replace(rootPath, replacement);
}

function findBundles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? findBundles(file) :
      entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  });
}

async function main() {
  logger.info('Patching disk space checks to use the Zalo data directory...');
  const bundles = findBundles(PC_DIST_DIR)
    .map((file) => ({ file, original: fs.readFileSync(file, 'utf8') }))
    .filter(({ original }) => original.includes('analyzeMainDisk(){'));
  if (!bundles.length) throw new Error('No disk checker bundles found.');

  // Validate every bundle before writing, so upstream changes cannot leave a partial patch.
  const patches = bundles.map(({ file, original }) => ({ file, original, patched: patchDiskSpace(original) }));
  let updated = 0;
  for (const { file, original, patched } of patches) {
    if (original === patched) continue;
    fs.writeFileSync(file, patched);
    updated += 1;
    logger.dim(`Patched ${path.relative(PC_DIST_DIR, file)}`);
  }
  logger.success(`Disk space patch applied (${bundles.length} checked, ${updated} updated)`);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Disk space patch failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, patchDiskSpace };
