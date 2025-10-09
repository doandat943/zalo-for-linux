const path = require('path');
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const ZADARK_DIR = path.join(__dirname, '..', 'plugins', 'zadark');

console.log('🔍 Checking versions and determining build workflow...');

// Run main function if this file is executed directly
if (require.main === module) {
  main();
}

async function main() {
  try {
    // Get all required versions
    const targetZaloVersion = process.env.ZALO_VERSION || await getLatestZaloVersion();
    const targetZaDarkVersion = process.env.ZADARK_VERSION || await getLatestZaDarkVersion();

    console.log(`📱 Target Zalo version: ${targetZaloVersion}`);
    console.log(`🎨 Target ZaDark version: ${targetZaDarkVersion}`);

    // Only check combinations in GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
      console.log('🤖 GitHub Actions detected - checking existing combinations');
      
      // Check existing combinations in releases
      const existingCombo = await getExistingCombinations();
      console.log(`📦 Found ${existingCombo.length} existing combinations`);

      // Check if combination already exists
      const targetCombo = `${targetZaloVersion}+${targetZaDarkVersion}`;
      const isExist = existingCombo.includes(targetCombo);

      if (isExist) {
        console.log(`🎯 Workflow decision: skip`);
        process.env.SKIP_BUILD = 'true';
      } else {
        console.log(`🎯 Workflow decision: build`);
        delete process.env.SKIP_BUILD;
      }

      // Always set versions
      process.env.ZALO_VERSION = targetZaloVersion;
      process.env.ZADARK_VERSION = targetZaDarkVersion;
    } else {
      console.log('🏠 Local development - building everything');
      
      // In local environment, always build with detected/provided versions
      delete process.env.SKIP_BUILD;
      process.env.ZALO_VERSION = targetZaloVersion;
      process.env.ZADARK_VERSION = targetZaDarkVersion;
    }

    // Output for CI/scripts
    console.log('\n📋 Environment variables set:');
    console.log(`SKIP_BUILD=${process.env.SKIP_BUILD || 'false'}`);
    console.log(`ZALO_VERSION=${process.env.ZALO_VERSION || 'none'}`);
    console.log(`ZADARK_VERSION=${process.env.ZADARK_VERSION || 'none'}`);

  } catch (error) {
    console.error('💥 Version check failed:', error.message);
    process.exit(0); // Don't fail the whole pipeline
  }
}

async function getLatestZaloVersion() {
  return new Promise((resolve, reject) => {
    const request = https.get('https://zalo.me/download/zalo-pc?utm=90000', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        if (redirectUrl && redirectUrl.includes('.dmg')) {
          const match = redirectUrl.match(/ZaloSetup-universal-([0-9.]+)\.dmg/);
          if (match) {
            resolve(match[1]);
          } else {
            reject(new Error('Could not parse version from DMG URL'));
          }
        } else {
          reject(new Error('Redirect URL is not a DMG file'));
        }
        return;
      }
      reject(new Error(`Unexpected HTTP ${response.statusCode}`));
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function getLatestZaDarkVersion() {
  return new Promise((resolve, reject) => {
    try {
      console.log('🔍 Starting ZaDark version detection...');
      console.log(`📁 ZaDark directory: ${ZADARK_DIR}`);

      // Check if directory exists before update
      const existsBefore = fs.existsSync(ZADARK_DIR);
      console.log(`📂 Directory exists before update: ${existsBefore}`);
      
      if (existsBefore) {
        try {
          const filesBefore = execSync('ls -la', { cwd: ZADARK_DIR, encoding: 'utf8' });
          console.log('📄 Files before update:');
          console.log(filesBefore);
        } catch (error) {
          console.log('⚠️ Could not list files before update');
        }
      }

      // First ensure submodule is initialized and updated
      console.log('🔄 Running: git submodule update --init --recursive --remote');
      execSync('git submodule update --init --recursive --remote', {
        stdio: 'inherit'
      });
      console.log('✅ Submodule update completed');

      // Verify submodule directory exists and is a git repo
      if (!fs.existsSync(ZADARK_DIR)) {
        console.error(`❌ ZaDark submodule directory not found after update: ${ZADARK_DIR}`);
        reject(new Error('ZaDark submodule directory not found after update'));
        return;
      }
      console.log('✅ ZaDark directory exists after update');
      
      // List files after update
      try {
        const filesAfter = execSync('ls -la', { cwd: ZADARK_DIR, encoding: 'utf8' });
        console.log('📄 Files after update:');
        console.log(filesAfter);
      } catch (error) {
        console.log('⚠️ Could not list files after update');
      }

      // Check if it's a git repository
      try {
        console.log('🔍 Checking if ZaDark is a valid git repository...');
        execSync('git rev-parse --git-dir', {
          cwd: ZADARK_DIR,
          stdio: 'pipe'
        });
        console.log('✅ ZaDark is a valid git repository');
      } catch (error) {
        console.error('❌ ZaDark submodule is not a valid git repository');
        reject(new Error('ZaDark submodule is not a valid git repository'));
        return;
      }

      // Fetch all tags from remote to ensure we have latest
      try {
        console.log('📥 Fetching tags from remote...');
        execSync('git fetch --tags', {
          cwd: ZADARK_DIR,
          stdio: 'pipe'
        });
        console.log('✅ Tags fetched successfully');
      } catch (error) {
        console.warn('⚠️ Could not fetch tags, using local tags only:', error.message);
      }

      // Get latest tag from submodule
      console.log('🏷️ Getting latest tag...');
      const latestTag = execSync('git tag --sort=-version:refname | head -1', {
        cwd: ZADARK_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();

      console.log(`📋 Raw latest tag result: "${latestTag}"`);

      if (latestTag) {
        console.log(`✅ Found ZaDark latest tag: ${latestTag}`);
        resolve(latestTag);
      } else {
        console.error('❌ No ZaDark tags found in submodule');
        reject(new Error('No ZaDark tags found in submodule'));
      }
    } catch (error) {
      console.error('💥 Error in getLatestZaDarkVersion:', error.message);
      reject(new Error(`Could not get ZaDark version: ${error.message}`));
    }
  });
}

async function getExistingCombinations() {
  return new Promise((resolve) => {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases`,
      headers: { 'User-Agent': 'Node.js' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const releases = JSON.parse(data);
          const combinations = new Set();

          releases.forEach(release => {
            release.assets.forEach(asset => {
              const match = asset.name.match(/Zalo-([0-9.]+)(?:\+ZaDark-([0-9.]+))?-/);
              if (match) {
                const zaloVer = match[1];
                const zadarkVer = match[2] || 'none';
                combinations.add(`${zaloVer}+${zadarkVer}`);
              }
            });
          });

          resolve(Array.from(combinations));
        } catch (error) {
          console.warn('⚠️ Could not parse releases, assuming no existing combinations');
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

module.exports = { main };