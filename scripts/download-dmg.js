const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const ZALO_DMG_PATTERN = 'https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-VERSION.dmg';
const TEMP_DIR = path.join(__dirname, '..', 'temp');

async function main() {
  // Create directories
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  try {
    // Check if we should skip - no ZALO_VERSION means we should skip
    if (!process.env.ZALO_VERSION) {
      logger.info('Download skipped (no ZALO_VERSION provided)');
      return;
    }

    // Version specified
    const version = process.env.ZALO_VERSION.trim();
    const dmgUrl = ZALO_DMG_PATTERN.replace('VERSION', version);
    
    // Extract filename from URL
    const urlPath = new URL(dmgUrl).pathname;
    const dmgFilename = path.basename(urlPath);
    const dmgPath = path.join(TEMP_DIR, dmgFilename);

    // Check if DMG already exists
    if (fs.existsSync(dmgPath)) {
      const stats = fs.statSync(dmgPath);
      const fileSize = (stats.size / 1024 / 1024).toFixed(2);

      logger.info(`Found existing Zalo DMG v${version} (${fileSize} MB)`);

      if (!process.env.FORCE_DOWNLOAD) {
        logger.success('Download skipped - file already exists');
        return;
      }

      logger.info('Force download enabled, removing existing file...');
      fs.unlinkSync(dmgPath);
    }

    // Download DMG
    logger.info(`Downloading Zalo DMG v${version}...`);
    await downloadFile(dmgUrl, dmgPath);

    // Verify file
    if (!fs.existsSync(dmgPath)) {
      throw new Error('Download failed - file not found after download');
    }

    const stats = fs.statSync(dmgPath);
    const fileSize = (stats.size / 1024 / 1024).toFixed(2);

    logger.success(`Downloaded successfully: ${dmgFilename} (${fileSize} MB)`);

  } catch (error) {
    logger.error('Download failed:', error.message);
    process.exit(1);
  }
}

async function downloadFile(url, destination) {
  // Use wget for reliable download with progress
  const wgetCommand = [
    'wget',
    '--progress=bar:force',  // Show progress bar
    '--user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"',
    `"${url}"`,
    '-O', `"${destination}"`
  ].join(' ');

  try {
    execSync(wgetCommand, {
      stdio: 'inherit'  // Show wget progress in real-time
    });
  } catch (error) {
    // Clean up partial file on error
    if (fs.existsSync(destination)) {
      fs.unlinkSync(destination);
    }
    throw new Error(`wget failed: ${error.message}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
