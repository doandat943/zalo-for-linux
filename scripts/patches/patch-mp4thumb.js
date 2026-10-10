const path = require('path');
const { integrateNativeLib } = require('../utils/nativelib');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const REPLACEMENTS = [
  // Load Linux binary for mp4thumb
  {
    from: `else {\n            if(process.arch === 'arm64'){`,
    to: `else if(process.platform === 'linux') {\n            thumbModule = require(\`./linux/mp4thumb.node\`);\n        }\n        else {\n            if(process.arch === 'arm64'){`
  }
];

async function main() {
  integrateNativeLib({
    name: 'mp4thumb',
    type: 'rust',
    destDir: path.join(APP_DIR, 'native', 'nativelibs', 'mp4thumb', 'linux'),
    loaderFile: path.join(APP_DIR, 'native', 'nativelibs', 'mp4thumb', 'index.js'),
    loaderReplacements: REPLACEMENTS
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
