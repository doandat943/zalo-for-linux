const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ZALO_DOWNLOAD_PAGE = 'https://zalo.me/download/zalo-pc?utm=90000';
const ZALO_DMG_PATTERN = 'https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-VERSION.dmg';
const TEMP_DIR = path.join(__dirname, '..', 'temp');

console.log('📥 Starting Zalo DMG download process...');

// Create directories
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function getLatestDMGUrl() {
  return new Promise((resolve, reject) => {
    console.log('🔍 Getting latest DMG URL from Zalo...');
    console.log('📦 Checking:', ZALO_DOWNLOAD_PAGE);
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };
    
    const request = https.get(ZALO_DOWNLOAD_PAGE, options, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        console.log('🎯 Found redirect to:', redirectUrl);
        
        // Check if redirect is a DMG file
        if (redirectUrl && redirectUrl.includes('.dmg')) {
          resolve(redirectUrl);
        } else {
          reject(new Error('Redirect URL is not a DMG file'));
        }
        return;
      }
      
      reject(new Error(`Unexpected HTTP ${response.statusCode}: ${response.statusMessage}. Expected redirect to DMG file.`));
    });
    
    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout while getting latest DMG URL'));
    });
  });
}

async function downloadFile(url, destination, redirectCount = 0) {
  const maxRedirects = 10;
  const timeoutMs = 300000; // 5 minutes for large file
  
  return new Promise((resolve, reject) => {
    if (redirectCount === 0) {
      console.log('📥 Downloading DMG file...');
      console.log('🔗 Starting URL:', url);
    }
    
    if (redirectCount > maxRedirects) {
      reject(new Error(`Too many redirects (${redirectCount})`));
      return;
    }
    
    const request = (url.startsWith('https') ? https : http).get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        console.log(`🔄 Redirect ${redirectCount + 1}: ${redirectUrl}`);
        
        // Handle relative URLs
        let fullRedirectUrl;
        if (redirectUrl.startsWith('/')) {
          const urlObj = new URL(url);
          fullRedirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
        } else if (!redirectUrl.startsWith('http')) {
          const urlObj = new URL(url);
          fullRedirectUrl = `${urlObj.protocol}//${urlObj.host}/${redirectUrl}`;
        } else {
          fullRedirectUrl = redirectUrl;
        }
        
        // Follow redirect recursively
        return downloadFile(fullRedirectUrl, destination, redirectCount + 1)
          .then(resolve)
          .catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage} at ${url}`));
        return;
      }

      console.log('✅ Found final download URL');
      const fileStream = fs.createWriteStream(destination);
      const totalSize = parseInt(response.headers['content-length'] || '0');
      let downloadedSize = 0;
      let lastProgressUpdate = 0;
      const startTime = Date.now();

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        
        // Update progress every 1MB or 5% to avoid spam
        const now = Date.now();
        if (now - lastProgressUpdate > 1000) { // Every 1 second
          const progress = totalSize > 0 ? ((downloadedSize / totalSize) * 100).toFixed(1) : 'Unknown';
          const downloadedMB = Math.round(downloadedSize / 1024 / 1024);
          const totalMB = totalSize > 0 ? Math.round(totalSize / 1024 / 1024) : '?';
          const elapsedSec = Math.round((now - startTime) / 1000);
          const speedKBps = downloadedSize > 0 ? Math.round((downloadedSize / 1024) / (elapsedSec || 1)) : 0;
          
          process.stdout.write(`\r📊 Progress: ${progress}% (${downloadedMB}/${totalMB}MB) | Speed: ${speedKBps}KB/s | Time: ${elapsedSec}s`);
          lastProgressUpdate = now;
        }
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        console.log('\n✅ Download completed!');
        resolve();
      });

      fileStream.on('error', (error) => {
        console.log('\n❌ File write error:', error.message);
        reject(error);
      });
      
      response.on('error', (error) => {
        console.log('\n❌ Response error:', error.message);
        reject(error);
      });
    });

    request.on('error', (error) => {
      console.log('\n❌ Request error:', error.message);
      reject(error);
    });
    
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      const timeoutMin = Math.round(timeoutMs / 60000);
      reject(new Error(`Download timeout after ${timeoutMin} minutes. File may be very large or connection is slow.`));
    });
  });
}

async function downloadDMG() {
  try {
    // Determine download URL - Simple 2 modes
    let dmgUrl;
    let downloadMode;
    
    if (process.env.DMG_VERSION) {
      // Mode 1: Version-based URL construction  
      const version = process.env.DMG_VERSION.trim();
      dmgUrl = ZALO_DMG_PATTERN.replace('VERSION', version);
      downloadMode = 'version';
      console.log('🎯 Using version-based download');
      console.log('📦 Version:', version);
      console.log('🔗 Constructed URL:', dmgUrl);
    } else {
      // Mode 2: Auto-latest (default)
      downloadMode = 'latest';
      console.log('🆕 Auto-downloading latest version from Zalo...');
      dmgUrl = await getLatestDMGUrl();
      console.log('✅ Latest DMG URL obtained:', dmgUrl);
    }
    
    // Extract filename from URL
    const urlPath = new URL(dmgUrl).pathname;
    const dmgFilename = path.basename(urlPath) || 'zalo.dmg';
    const dmgPath = path.join(TEMP_DIR, dmgFilename);
    
    console.log('📄 DMG filename:', dmgFilename);
    console.log('🎯 Download mode:', downloadMode);
    
    // Check if DMG already exists
    if (fs.existsSync(dmgPath)) {
      console.log('💾 DMG file already exists!');
      console.log('📄 Existing file:', dmgPath);
      
      const stats = fs.statSync(dmgPath);
      const fileSize = (stats.size / 1024 / 1024).toFixed(2);
      console.log('📊 File size:', fileSize, 'MB');
      console.log('📅 Created:', stats.birthtime.toLocaleString());
      
      if (downloadMode === 'latest') {
        console.log('💡 To force re-download latest: delete existing file or set FORCE_DOWNLOAD=true');
      } else {
        console.log('💡 To force re-download version: set FORCE_DOWNLOAD=true');
      }
      
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
    const stats = fs.statSync(dmgPath);
    const fileSize = (stats.size / 1024 / 1024).toFixed(2);
    console.log('📊 Downloaded file size:', fileSize, 'MB');
    
    console.log('🎉 Download completed successfully!');
    console.log(`💾 DMG file saved at: ${dmgPath}`);
    
  } catch (error) {
    console.error('💥 Download failed:', error.message);
    if (error.message.includes('Request timeout') || error.message.includes('No DMG link found')) {
      console.error('💡 If auto-detection failed, try specifying a version: DMG_VERSION="25.8.2" npm run download-dmg');
    }
    process.exit(1);
  }
}

// Run download
downloadDMG();
