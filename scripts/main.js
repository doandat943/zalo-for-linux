const logger = require('./utils/logger.js');

async function main() {
  logger.step('Starting Zalo for Linux workflow');

  try {
    if (process.env.SETUP === 'true') {
      logger.step('Step 1: Checking versions');
      await require('./check-versions.js').main();

      // Check if we should skip build
      if (process.env.GITHUB_ACTIONS && process.env.BUILD === 'false') {
        logger.success('Build skipped - combination already exists (no build needed)');
        process.exit(0);
      }

      logger.step('Step 2: Downloading Zalo DMG and Windows installer');
      await require('./download.js').main();

      logger.step('Step 3: Preparing ZaDark');
      await require('./prepare-zadark.js').main();

      logger.step('Step 4: Preparing Zalo app');
      await require('./prepare-app.js').main();

      // Optional: call engine under Wine — failure must not break the build.
      logger.step('Step 4.5: Setting up zcall-bridge (optional call engine)');
      try { await require('./setup-zcall-bridge.js').main(); }
      catch (e) { logger.warn('zcall-bridge setup failed, calls unavailable: ' + e.message); }

      logger.step('Step 5: Cleaning unused files');
      await require('./clean-unused.js').main();
    }
    if (process.env.BUILD === 'true') {
      logger.step('Step 6: Building AppImages');
      await require('./build.js').main();
    }
  } catch (error) {
    logger.error('Workflow failed:', error.message);
    process.exit(1);
  }
}

main();
