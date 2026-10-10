const path = require('path');
const { integrateNativeLib } = require('../utils/nativelib');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // Load linux_x64 binary for zimage
  {
    from: `\t\t} else {\n\t\t\tos = 'darwin_x64';\n\t\t}\n\t}\n}`,
    to: `\t\t} else {\n\t\t\tos = 'darwin_x64';\n\t\t}\n\t} else if (process.platform === 'linux') {\n\t\tos = 'linux_x64';\n\t}\n}`
  }
];

async function main() {
  integrateNativeLib({
    name: 'zimage',
    type: 'rust',
    destDir: path.join(APP_DIR, 'native', 'nativelibs', 'zimage', 'linux_x64'),
    loaderFile: path.join(APP_DIR, 'native', 'nativelibs', 'zimage', 'index.js'),
    loaderReplacements: REPLACEMENTS
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
