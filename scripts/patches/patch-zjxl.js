const path = require('path');
const { integrateNativeLib } = require('../utils/nativelib');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // Load Linux binary for zjxl
  {
    from: `} else {\n    return { error: 'not support' };\n  }`,
    to: `} else if (process.platform === 'linux') {\n    nodeAddon = require('./build/linux/zjxl.node');\n  } else {\n    return { error: 'not support' };\n  }`
  }
];

async function main() {
  integrateNativeLib({
    name: 'zjxl',
    type: 'rust',
    destDir: path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'build', 'linux'),
    loaderFile: path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'index.js'),
    loaderReplacements: REPLACEMENTS
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
