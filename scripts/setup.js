const { execSync } = require('child_process');

console.log('🚀 Starting setup workflow...');

try {
  // Step 1: Check versions and determine workflow
  console.log('\n📋 Step 1: Checking versions...');
  execSync('node scripts/check-versions.js', {
    stdio: 'inherit',
    env: process.env
  });

  // Step 2: Download DMG (script will skip if not needed)
  console.log('\n📥 Step 2: Downloading Zalo DMG...');
  execSync('node scripts/download-dmg.js', {
    stdio: 'inherit',
    env: process.env
  });

  // Step 3: Prepare ZaDark (script will skip if not needed)
  console.log('\n🎨 Step 3: Preparing ZaDark...');
  execSync('node scripts/prepare-zadark.js', {
    stdio: 'inherit',
    env: process.env
  });

  // Step 4: Prepare app (script will skip if not needed)
  console.log('\n📱 Step 4: Preparing Zalo app...');
  execSync('node scripts/prepare-app.js', {
    stdio: 'inherit',
    env: process.env
  });

  console.log('\n🎉 Setup completed successfully!');

} catch (error) {
  console.error('\n💥 Setup failed:', error.message);
  process.exit(1);
}