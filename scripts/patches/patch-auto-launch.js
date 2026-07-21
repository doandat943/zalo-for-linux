const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_DIST_DIR = path.join(APP_DIR, 'main-dist');
const AUTO_LAUNCH_BUNDLES = ['main.js', 'compact-app.js'];

const LAUNCHER_OPTIONS_ORIGINAL =
  'else if("win32"===process.platform){let t=o.join(o.dirname(i.getPath("exe")),"..","Zalo.exe");e.path=t}l=new r(e)';
const LAUNCHER_OPTIONS_PATCHED =
  'else if("win32"===process.platform){let t=o.join(o.dirname(i.getPath("exe")),"..","Zalo.exe");e.path=t}else if("linux"===process.platform)e.path=process.env.APPIMAGE||i.getPath("exe");l=new r(e)';
const COMPACT_LAUNCHER_OPTIONS_ORIGINAL =
  'else if("win32"===process.platform){let t=o.join(o.dirname(i.getPath("exe")),"..","Zalo.exe");e.path=t}u=new r(e)';
const COMPACT_LAUNCHER_OPTIONS_PATCHED =
  'else if("win32"===process.platform){let t=o.join(o.dirname(i.getPath("exe")),"..","Zalo.exe");e.path=t}else if("linux"===process.platform)e.path=process.env.APPIMAGE||i.getPath("exe");u=new r(e)';

const GET_LAUNCHER_ORIGINAL = 'getZaloLauncher:()=>l';
const GET_LAUNCHER_PATCHED = 'getZaloLauncher:()=>{if(!l)u(d);return l}';
const COMPACT_GET_LAUNCHER_ORIGINAL = 'getZaloLauncher:()=>u';
const COMPACT_GET_LAUNCHER_PATCHED = 'getZaloLauncher:()=>{if(!u)d(l);return u}';

const HANDLERS_ORIGINAL =
  'checkAutoLaunchEnable:e=>{const{getZaloLauncher:t}=n("Wsuc");return t().isEnabled()},' +
  'toggleAutoLaunch:(e,t)=>{const{appConfig:r}=n("ZQzv"),{getZaloLauncher:i}=n("Wsuc"),o=i();' +
  't?($e.zsymb(4,"pM_gN_",["autolaunch to enable","PGmVrW"]),o.enable(),r.set("autolaunch",!0)):' +
  '($e.zsymb(4,"b76Lft",["autolaunch to disable","sTBzDy"]),o.disable(),r.set("autolaunch",!1))},';

const HANDLERS_PATCHED_V1 =
  'checkAutoLaunchEnable:async e=>{try{const{getZaloLauncher:t}=n("Wsuc"),r=t();' +
  'return!!(r&&"function"==typeof r.isEnabled)&&!!await r.isEnabled()}catch(e){return!1}},' +
  'toggleAutoLaunch:async(e,t)=>{const{appConfig:r}=n("ZQzv"),{getZaloLauncher:i}=n("Wsuc"),o=i();' +
  'if(!o)return r.set("autolaunch",!!t),!1;try{return t?' +
  '($e.zsymb(4,"pM_gN_",["autolaunch to enable","PGmVrW"]),await o.enable(),r.set("autolaunch",!0),!0):' +
  '($e.zsymb(4,"b76Lft",["autolaunch to disable","sTBzDy"]),await o.disable(),r.set("autolaunch",!1),!0)' +
  '}catch(e){return $e.zsymb(19,"linux_auto_launch_error",e),!1}},';

const HANDLERS_PATCHED =
  'checkAutoLaunchEnable:async e=>{try{const{getZaloLauncher:t}=n("Wsuc"),r=t();' +
  'return!!(r&&"function"==typeof r.isEnabled)&&!!await r.isEnabled()}catch(e){return!1}},' +
  'toggleAutoLaunch:async(e,t)=>{const{appConfig:r}=n("ZQzv"),{getZaloLauncher:i}=n("Wsuc");try{' +
  'const o=i();if(!o)return r.set("autolaunch",!!t),!1;return t?' +
  '($e.zsymb(4,"pM_gN_",["autolaunch to enable","PGmVrW"]),await o.enable(),r.set("autolaunch",!0),!0):' +
  '($e.zsymb(4,"b76Lft",["autolaunch to disable","sTBzDy"]),await o.disable(),r.set("autolaunch",!1),!0)' +
  '}catch(e){return $e.zsymb(19,"linux_auto_launch_error",e),!1}},';

function replaceRequired(content, original, replacement, label, legacy = []) {
  if (content.includes(replacement)) return content;
  for (const candidate of [original, ...legacy]) {
    if (content.includes(candidate)) return content.replace(candidate, replacement);
  }
  throw new Error(`Auto-launch ${label} anchor not found; upstream Zalo bundle may have changed.`);
}

function patchAutoLaunch(content) {
  const isMainVariant = content.includes(LAUNCHER_OPTIONS_ORIGINAL) ||
    content.includes(LAUNCHER_OPTIONS_PATCHED) || content.includes(GET_LAUNCHER_PATCHED);
  const isCompactVariant = content.includes(COMPACT_LAUNCHER_OPTIONS_ORIGINAL) ||
    content.includes(COMPACT_LAUNCHER_OPTIONS_PATCHED) || content.includes(COMPACT_GET_LAUNCHER_PATCHED);
  if (!isMainVariant && !isCompactVariant) {
    throw new Error('Auto-launch launcher module anchor not found; upstream Zalo bundle may have changed.');
  }

  if (isMainVariant) {
    content = replaceRequired(
      content, LAUNCHER_OPTIONS_ORIGINAL, LAUNCHER_OPTIONS_PATCHED, 'Linux path'
    );
    content = replaceRequired(
      content, GET_LAUNCHER_ORIGINAL, GET_LAUNCHER_PATCHED, 'lazy initialization'
    );
  } else {
    content = replaceRequired(
      content, COMPACT_LAUNCHER_OPTIONS_ORIGINAL, COMPACT_LAUNCHER_OPTIONS_PATCHED, 'Linux path'
    );
    content = replaceRequired(
      content, COMPACT_GET_LAUNCHER_ORIGINAL, COMPACT_GET_LAUNCHER_PATCHED, 'lazy initialization'
    );
  }
  content = replaceRequired(
    content, HANDLERS_ORIGINAL, HANDLERS_PATCHED, 'IPC handler', [HANDLERS_PATCHED_V1]
  );
  return content;
}

async function main() {
  logger.info('Patching auto-launch for Linux...');
  let checkedCount = 0;
  let updatedCount = 0;

  for (const fileName of AUTO_LAUNCH_BUNDLES) {
    const filePath = path.join(MAIN_DIST_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      if (fileName === 'main.js') throw new Error('main-dist/main.js not found');
      logger.warn(`Skipping ${fileName} (not found)`);
      continue;
    }
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = patchAutoLaunch(original);
    checkedCount += 1;
    if (patched !== original) {
      fs.writeFileSync(filePath, patched, 'utf8');
      updatedCount += 1;
      logger.dim(`Patched auto-launch handlers in ${fileName}`);
    }
  }
  logger.success(`Linux auto-launch patch applied (${checkedCount} checked, ${updatedCount} updated)`);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Auto-launch patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = { main, patchAutoLaunch };
