async function main() {
  console.log('🚀 Starting setup workflow...');

  try {
    // Step 1: Check versions and determine workflow
    console.log('\n📋 Step 1: Checking versions...');
    await require('./check-versions.js').main();

    // Check if we should skip build
    if (process.env.SKIP_BUILD === 'true') {
      console.log('\n⏭️  Build skipped - combination already exists');
      console.log('✅ No build needed!');
      process.exit(0);
    }

    // Step 2: Download DMG (script will skip if not needed)
    console.log('\n📥 Step 2: Downloading Zalo DMG...');
    await require('./download-dmg.js').main();

    // Step 3: Prepare ZaDark (script will skip if not needed)
    console.log('\n🎨 Step 3: Preparing ZaDark...');
    await require('./prepare-zadark.js').main();

    // Step 4: Prepare app (script will skip if not needed)
    console.log('\n📱 Step 4: Preparing Zalo app...');
    await require('./prepare-app.js').main();

    console.log('\n🎉 Setup completed successfully!');

  } catch (error) {
    console.error('\n💥 Setup failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };