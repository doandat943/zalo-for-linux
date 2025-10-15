const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ZADARK_DIR = path.join(__dirname, '..', 'plugins', 'zadark');

async function main() {
  console.log('🔍 Checking versions and determining build workflow...');

  try {
    // Get all required versions
    const targetZaloVersion = process.env.ZALO_VERSION || await getLatestZaloVersion();
    const targetZaDarkVersion = process.env.ZADARK_VERSION || await getLatestZaDarkVersion();
    const targetCommit = process.env.COMMIT_HASH || execSync('git rev-parse --short HEAD', {
      encoding: 'utf8'
    }).trim();

    // Only check combinations in GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
      console.log('🤖 GitHub Actions detected - checking existing combinations');

      // Check existing combinations in releases
      const existingCombo = await getExistingCombinations();
      console.log(`📦 Found ${existingCombo.length} existing combinations`);

      // Check if combination already exists
      const targetCombo = `${targetZaloVersion}+${targetZaDarkVersion}+${targetCommit}`;
      const isExist = existingCombo.includes(targetCombo);

      if (isExist) {
        console.log(`🎯 Workflow decision: skip (found ${targetCombo})`);
        process.env.BUILD = 'false';
      } else {
        console.log(`🎯 Workflow decision: build (missing ${targetCombo})`);
        process.env.BUILD = 'true';
        if (process.env.GITHUB_OUTPUT) {
          fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=true\n`);
      }
    }

    process.env.ZALO_VERSION = targetZaloVersion;
    process.env.ZADARK_VERSION = targetZaDarkVersion;
    process.env.COMMIT_HASH = targetCommit;

    // Output for CI/scripts
    console.log('\n📋 Environment variables set:');
    console.log(`BUILD=${process.env.BUILD || 'none'}`);
    console.log(`ZALO_VERSION=${process.env.ZALO_VERSION || 'none'}`);
    console.log(`ZADARK_VERSION=${process.env.ZADARK_VERSION || 'none'}`);
    console.log(`COMMIT_HASH=${process.env.COMMIT_HASH || 'none'}`);

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
      // First ensure submodule is initialized and updated
      execSync('git submodule update --init --recursive --remote', {
        stdio: 'pipe'
      });

      execSync('git fetch --tags', {
        cwd: ZADARK_DIR,
        stdio: 'pipe'
      });

      // Get latest tag from submodule
      const latestTag = execSync('git tag --sort=-version:refname | head -1', {
        cwd: ZADARK_DIR,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();

      if (latestTag) {
        resolve(latestTag);
      } else {
        reject(new Error('No ZaDark tags found'));
      }
    } catch (error) {
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
              const match = asset.name.match(/Zalo-([0-9.]+)\+ZaDark-([0-9.]+)-([0-9a-fA-F]+)\.AppImage$/);
              if (match) {
                const zaloVer = match[1];
                const zadarkVer = match[2];
                const commitHash = match[3];
                combinations.add(`${zaloVer}+${zadarkVer}+${commitHash}`);
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

if (require.main === module) {
  main();
}

module.exports = { main };