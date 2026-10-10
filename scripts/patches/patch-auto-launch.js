const path = require('path');
const logger = require('../utils/logger');
const { patchStrings } = require('../utils/patcher');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_DIST_DIR = path.join(APP_DIR, 'main-dist');
const TARGET_FILES = ['main.js', 'compact-app.js'];

const REPLACEMENTS = [
  // 1. Set AppImage path and isHidden flag on Linux for launcher.
  // On Linux, isHidden makes auto-launch append `--hidden` to the autostart Exec
  // line, which plugins/start-hidden handles by starting in the tray (#58).
  {
    from: /(else if\("win32"===process\.platform\)\{let [^}]*?;e\.path=t\})(?:else if\("linux"===process\.platform\)[^;]*?;)?(\w+=new \w+\(e\))/,
    to: '$1else if("linux"===process.platform)e.path=process.env.APPIMAGE||i.getPath("exe"),e.isHidden=!0;$2'
  },
  // 2. Lazy initialization for getZaloLauncher getter
  {
    from: /getZaloLauncher:\(\)=>([du])(?!\s*\{)/g,
    to: (_match, inst) => {
      const init = inst === 'd' ? 'u' : 'd';
      return `getZaloLauncher:()=>{if(!${inst})${init}(l);return ${inst}}`;
    }
  },
  // 3. Wrap checkAutoLaunchEnable and toggleAutoLaunch with async / error handling
  {
    from: new RegExp(
      'checkAutoLaunchEnable:e=>\\{const\\{getZaloLauncher:t\\}=n\\("([A-Za-z0-9._-]+)"\\);return t\\(\\)\\.isEnabled\\(\\)\\},' +
      'toggleAutoLaunch:\\(e,t\\)=>\\{const\\{appConfig:r\\}=n\\("([A-Za-z0-9._-]+)"\\),\\{getZaloLauncher:i\\}=n\\("\\1"\\),o=i\\(\\);' +
      't\\?\\(([A-Za-z_$][A-Za-z0-9_$]*)\\.zsymb\\(4,"([A-Za-z0-9._-]+)",\\["autolaunch to enable","([A-Za-z0-9._-]+)"\\]\\),o\\.enable\\(\\),r\\.set\\("autolaunch",!0\\)\\):' +
      '\\(\\3\\.zsymb\\(4,"([A-Za-z0-9._-]+)",\\["autolaunch to disable","([A-Za-z0-9._-]+)"\\]\\),o\\.disable\\(\\),r\\.set\\("autolaunch",!1\\)\\)\\},'
    ),
    to: 'checkAutoLaunchEnable:async e=>{try{const{getZaloLauncher:t}=n("$1"),r=t();' +
      'return!!(r&&"function"==typeof r.isEnabled)&&!!await r.isEnabled()}catch(e){return!1}},' +
      'toggleAutoLaunch:async(e,t)=>{const{appConfig:r}=n("$2"),{getZaloLauncher:i}=n("$1");try{' +
      'const o=i();if(!o)return r.set("autolaunch",!!t),!1;return t?' +
      '($3.zsymb(4,"$4",["autolaunch to enable","$5"]),await o.enable(),r.set("autolaunch",!0),!0):' +
      '($3.zsymb(4,"$6",["autolaunch to disable","$7"]),await o.disable(),r.set("autolaunch",!1),!0)' +
      '}catch(e){return $3.zsymb(19,"linux_auto_launch_error",e),!1}},'
  }
];

async function main() {
  logger.info('Patching auto-launch for Linux...');
  for (const fileName of TARGET_FILES) {
    patchStrings(path.join(MAIN_DIST_DIR, fileName), REPLACEMENTS, `auto-launch handlers in ${fileName}`);
  }
  logger.success(`Linux auto-launch patch applied (${TARGET_FILES.length} files)`);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Auto-launch patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = { main };
