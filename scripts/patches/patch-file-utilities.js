const path = require('path');
const { integrateNativeLib } = require('../utils/nativelib');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // Load Linux binary for file-utilities
  {
    from: `default:\n      throw new Error(\`Unsupported OS: \${platform}, architecture: \${arch}\`)\n  }\n}`,
    to: `case 'linux':\n      return join(__dirname, 'linux', 'file-utilities.node')\n    default:\n      throw new Error(\`Unsupported OS: \${platform}, architecture: \${arch}\`)\n  }\n}`
  }
];

async function main() {
  integrateNativeLib({
    name: 'file-utilities',
    type: 'rust',
    destDir: path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'linux'),
    loaderFile: path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'index.js'),
    loaderReplacements: REPLACEMENTS
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
