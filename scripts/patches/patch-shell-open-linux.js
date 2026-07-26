const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_DIR = path.join(APP_DIR, 'main-dist');
const LINUX_DIRECTORY_GUARD_PATTERN =
  /if\("linux"===process\.platform&&([A-Za-z_$][\w$]*)\.isDirectory\(\)\)return [A-Za-z_$][\w$]*\(e\)/;

function patchShellOpenLinux(content) {
  const shellModuleStart = content.indexOf('Mz8P:function');
  if (shellModuleStart === -1) {
    throw new Error('Shell module not found.');
  }

  const shellModule = content.slice(shellModuleStart);
  if (LINUX_DIRECTORY_GUARD_PATTERN.test(shellModule)) return content;

  const openPathMatch = shellModule.match(
    /function ([A-Za-z_$][\w$]*)\(e\)\{return [A-Za-z_$][\w$]*\.shell\.openPath\(e\)\}/
  );
  if (!openPathMatch) {
    throw new Error('Electron shell.openPath helper not found.');
  }
  const openPath = openPathMatch[1];

  const directoryBranchPattern =
    /if\(([A-Za-z_$][\w$]*)\)\{if\(!\1\.isDirectory\(\)\)\{/;
  const directoryBranchMatch = shellModule.match(directoryBranchPattern);
  if (!directoryBranchMatch) {
    throw new Error('Shell directory branch not found.');
  }
  const stat = directoryBranchMatch[1];

  const patchedShellModule = shellModule.replace(
    directoryBranchPattern,
    `if(${stat}){if("linux"===process.platform&&${stat}.isDirectory())return ${openPath}(e);` +
      `if(!${stat}.isDirectory()){`
  );
  return content.slice(0, shellModuleStart) + patchedShellModule;
}

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

  let updatedCount = 0;
  for (const filePath of bundlePaths) {
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = patchShellOpenLinux(original);
    if (patched !== original) {
      fs.writeFileSync(filePath, patched, 'utf8');
      updatedCount += 1;
      logger.dim(`Patched Linux folder opening in ${path.relative(APP_DIR, filePath)}`);
    }
  }

  logger.success(
    `Linux folder-opening patch applied (${bundlePaths.length} checked, ${updatedCount} updated)`
  );
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Linux folder-opening patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  patchShellOpenLinux
};
