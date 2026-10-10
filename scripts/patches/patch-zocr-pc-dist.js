const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

function patch(source) {
  const start = source.indexOf('EzwU:function');
  if (start < 0) return source;
  const end = source.indexOf('},F0Xa:function', start);
  if (end < 0) throw new Error('OCR module boundary changed');
  let module = source.slice(start, end);
  const visibility = 'show:"unsupported"!==e.support,disabled:"supported"!==e.support||"ready"!==e.scanStatus';
  const visible = 'show:!0,disabled:"supported"!==e.support||"ready"!==e.scanStatus';
  if (!module.includes(visibility) && !module.includes(visible)) {
    throw new Error('OCR button pattern changed');
  }
  module = module.replace(visibility, visible);
  const enabled = /\w+=\(\)=>!0;function/;
  const config = /(\w+=\(\)=>)\w+\.key\("is_enabled"\)\.value(?=;function)/;
  if (!config.test(module) && !enabled.test(module)) {
    throw new Error('OCR feature flag pattern changed');
  }
  module = module.replace(config, '$1!0');
  // A drag starting in OCR can generate its click on the viewer background.
  // Catch that click before React's background handler closes the window.
  const gestureMarker = 'let ocrGestureStarted=!1;';
  if (!module.includes(gestureMarker)) {
    const reset = /const u=\(\)=>\{const e=(\w+)\.current,t=c\.getSelection\(\);/g;
    const down = /A=e=>\{var \w+,\w+,\w+,\w+;const (\w+)=(\w+)\.current;/g;
    const resets = [...module.matchAll(reset)];
    const downs = [...module.matchAll(down)];
    if (resets.length !== 1 || downs.length !== 1 || resets[0][1] !== downs[0][2]) {
      throw new Error('OCR selection gesture pattern changed');
    }
    const textLayer = resets[0][1];
    const target = downs[0][1];
    const replacements = [
      {
        from: resets[0][0],
        to: gestureMarker + `const ocrGestureClick=e=>{const t=ocrGestureStarted;ocrGestureStarted=!1;t&&${textLayer}.current&&!${textLayer}.current.contains(e.target)&&(e.preventDefault(),e.stopPropagation())},` + resets[0][0].slice('const '.length)
      },
      {
        from: downs[0][0],
        to: downs[0][0] + `ocrGestureStarted=0===e.button&&Boolean(${target}&&${target}.contains(e.target));`
      },
      {
        from: 'return c.addEventListener("mousedown",A,!0),',
        to: 'return c.addEventListener("click",ocrGestureClick,!0),c.addEventListener("mousedown",A,!0),'
      },
      {
        from: 'c.removeEventListener("mousedown",A,!0),',
        to: 'c.removeEventListener("click",ocrGestureClick,!0),c.removeEventListener("mousedown",A,!0),'
      }
    ];
    for (const { from, to } of replacements) {
      if (module.split(from).length !== 2) {
        throw new Error(`OCR selection pattern changed: ${from}`);
      }
      module = module.replace(from, to);
    }
  }
  // Releasing a drag outside OCR must not collapse the last valid selection.
  const dragRelease = /if\(t\.dragging&&(\w+)&&a\.contains\(\1\.node\)\)\{([^{}]+)\}else t\.selectAnchorOnMouseUp\?/g;
  const preservedRelease = /if\(t\.dragging\)\{if\((\w+)&&a\.contains\(\1\.node\)\)\{([^{}]+)\}\}else t\.selectAnchorOnMouseUp\?/g;
  const releases = [...module.matchAll(dragRelease)];
  if (releases.length === 1) {
    module = module.replace(dragRelease,
      'if(t.dragging){if($1&&a.contains($1.node)){$2}}else t.selectAnchorOnMouseUp?');
  } else if (releases.length !== 0 || [...module.matchAll(preservedRelease)].length !== 1) {
    throw new Error('OCR selection mouseup pattern changed');
  }
  return source.slice(0, start) + module + source.slice(end);
}

async function main() {
  logger.info('Patching OCR UI...');
  const root = path.join(APP_DIR, 'pc-dist');
  const changes = [];
  let found = 0;
  const files = [
    ...fs.readdirSync(root)
      .filter(name => /^(compact-app-pc|search-worker|sync-v2-sub-worker)\.[\da-f]+\.js$/.test(name)),
    ...fs.readdirSync(path.join(root, 'lazy'))
      .filter(name => /^default-login-main-startup-shared-worker-znotification\.[\da-f]+\.js$/.test(name))
      .map(name => path.join('lazy', name)),
  ];
  for (const entry of files) {
    const file = path.join(root, entry);
    try {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('EzwU:function')) {
        logger.warn(`OCR UI: skipped ${path.relative(APP_DIR, file)}: OCR module not found`);
        continue;
      }
      const updated = patch(source);
      found++;
      if (updated !== source) changes.push([file, updated]);
    } catch (error) {
      logger.warn(`OCR UI: failed to patch ${path.relative(APP_DIR, file)}: ${error.message}`);
      throw error;
    }
  }
  if (!found) throw new Error('No OCR bundles found in pc-dist');
  // Validate every bundle before writing any changes.
  for (const [file, updated] of changes) {
    try {
      fs.writeFileSync(file, updated);
    } catch (error) {
      logger.warn(`OCR UI: failed to write ${path.relative(APP_DIR, file)}: ${error.message}`);
      throw error;
    }
    logger.dim(`Patched ${path.relative(APP_DIR, file)}`);
  }
  logger.success(`OCR UI: ${changes.length} patched, ${found - changes.length} already patched.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    logger.error('Failed to patch OCR UI', error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, patch };
