const fs = require('fs-extra');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

async function main() {
  console.log('🔧 Patching main.js for Linux title bar...');

  const mainJsPath = path.join(APP_DIR, 'main-dist', 'main.js');

  if (!fs.existsSync(mainJsPath)) {
    console.log('⚠️  main.js not present, skipping patch');
    return;
  }

  let content = fs.readFileSync(mainJsPath, 'utf8');

  // Enable title bar on Linux: T,frame:!1 -> T,frame:!0
  if (content.includes('T,frame:!1')) {
    content = content.replace(/T,frame:!1/g, 'T,frame:!0');
    fs.writeFileSync(mainJsPath, content, 'utf8');
    console.log('✅ Patched T,frame:!1 -> T,frame:!0 (title bar enabled)');
  } else {
    console.log('⚠️  Pattern T,frame:!1 not found in main.js, skipping patch');
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };