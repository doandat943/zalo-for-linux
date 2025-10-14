async function main() {
  console.log('🚀 Starting workflow...');

  try {
    if (process.env.SETUP === 'true') {
      // Step 1: Check versions and determine workflow
      console.log('\n📋 Step 1: Checking versions...');
      await require('./check-versions.js').main();

      // Check if we should skip build
      if (process.env.GITHUB_ACTIONS && process.env.BUILD === 'false') {
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
    }
    if (process.env.BUILD === 'true') {
      // Step 5: Build app (script will skip if not needed)
      console.log('\n📱 Step 5: Building Zalo app...');
      await require('./build.js').main();
    }
  } catch (error) {
    console.error('\n💥 Workflow failed:', error.message);
    process.exit(1);
  }
}

main();
