const fs = require('fs-extra');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const NODE_MODULES = path.join(__dirname, '..', '..', 'node_modules');

async function main() {
  console.log('🔧 Patching sqlite3 for Linux...');

  const sqliteTargetDir = path.join(APP_DIR, 'native', 'nativelibs', 'sqlite3', 'binding', 'napi-v6-linux-x64');
  fs.mkdirSync(sqliteTargetDir, { recursive: true });

  const targetNodePath = path.join(sqliteTargetDir, 'node_sqlite3.node');
  const sourceNodePath = path.join(NODE_MODULES, 'sqlite3', 'build', 'Release', 'node_sqlite3.node');

  if (fs.existsSync(sourceNodePath)) {
    fs.copyFileSync(sourceNodePath, targetNodePath);
    console.log('✅ SQLite3 Linux binary installed successfully!');
  } else {
    console.log('⚠️  SQLite3 binary not found in node_modules. Run "npm install" first.');
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };