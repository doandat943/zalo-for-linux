const path = require('path');
const { integrateNativeLib } = require('../utils/nativelib');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // Load Linux binary for file-utils
  {
    from: `} else {\n    return {error: 'not support'};\n  }`,
    to: `} else if (process.platform === 'linux'){\n    return require('./linux/file-utils.node');\n  } else {\n    return {error: 'not support'};\n  }`
  }
];

async function main() {
  integrateNativeLib({
    name: 'file-utils',
    type: 'rust',
    destDir: path.join(APP_DIR, 'native', 'nativelibs', 'file-utils', 'linux'),
    loaderFile: path.join(APP_DIR, 'native', 'nativelibs', 'file-utils', 'index.js'),
    loaderReplacements: REPLACEMENTS
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
