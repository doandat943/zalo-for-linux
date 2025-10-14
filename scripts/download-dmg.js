const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ZALO_DMG_PATTERN = 'https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-VERSION.dmg';
const TEMP_DIR = path.join(__dirname, '..', 'temp');

async function main() {
  console.log('📥 Starting Zalo DMG download process...');

  // Create directories
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  else {
    try {
      // Check if we should skip - no ZALO_VERSION means we should skip
      if (!process.env.ZALO_VERSION) {
        console.log('ℹ️  Download skipped (no ZALO_VERSION provided)');
        return;
      }

      // Version specified
      const version = process.env.ZALO_VERSION.trim();
      const dmgUrl = ZALO_DMG_PATTERN.replace('VERSION', version);
      console.log('📦 Version:', version);
      console.log('🔗 Constructed URL:', dmgUrl);

      // Extract filename from URL
      const urlPath = new URL(dmgUrl).pathname;
      const dmgFilename = path.basename(urlPath);
      const dmgPath = path.join(TEMP_DIR, dmgFilename);

      console.log('📄 DMG filename:', dmgFilename);

      // Check if DMG already exists
      if (fs.existsSync(dmgPath)) {
        const stats = fs.statSync(dmgPath);
        const fileSize = (stats.size / 1024 / 1024).toFixed(2);

        console.log('💾 DMG file already exists!');
        console.log('📄 Existing file:', dmgPath);
        console.log('📊 File size:', fileSize, 'MB');
        console.log('📅 Created:', stats.birthtime.toLocaleString());
        console.log('💡 To force re-download: set FORCE_DOWNLOAD=true');

        if (!process.env.FORCE_DOWNLOAD) {
          console.log('✅ Download skipped - file already exists');
          return;
        }

        console.log('🔄 Force download enabled, removing existing file...');
        fs.unlinkSync(dmgPath);
      }

      // Download DMG
      console.log('⬇️ Starting download...');
      await downloadFile(dmgUrl, dmgPath);

      // Verify file
      if (!fs.existsSync(dmgPath)) {
        throw new Error('Download failed - file not found after download');
      }

      const stats = fs.statSync(dmgPath);
      const fileSize = (stats.size / 1024 / 1024).toFixed(2);

      console.log(`💾 DMG file saved at: ${dmgPath}`);
      console.log('📊 File size:', fileSize, 'MB');

    } catch (error) {
      console.error('💥 Download failed:', error.message);
      console.error('💡 Try specifying a different version: ZALO_VERSION="25.8.2" npm run download-dmg');
      process.exit(1);
    }
  }
}

async function downloadFile(url, destination) {
  console.log('📥 Downloading DMG file...');
  console.log('🔗 URL:', url);
  console.log('💾 Destination:', destination);

  // Use wget for reliable download with progress
  const wgetCommand = [
    'wget',
    '--progress=bar:force',  // Show progress bar
    '--user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"',
    `"${url}"`,
    '-O', `"${destination}"`
  ].join(' ');

  try {
    console.log('🔄 Running wget...');
    execSync(wgetCommand, {
      stdio: 'inherit'  // Show wget progress in real-time
    });
    console.log('✅ Download completed!');
  } catch (error) {
    // Clean up partial file on error
    if (fs.existsSync(destination)) {
      fs.unlinkSync(destination);
    }

    throw new Error(`Download failed: ${error.message}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
