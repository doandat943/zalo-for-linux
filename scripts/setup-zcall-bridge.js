/**
 * setup-zcall-bridge.js
 *
 * Prepares the call-v2 Wine runtime:
 *
 *   1. Copies Windows plugins extracted by prepare-app.js:
 *      plugins/capture/ (ZaloCall.exe + Qt DLLs + plugins) into
 *      app/native/qt-call-and-cap/, then trims unneeded files
 *   2. Compiles pipebridge.c (252KB named-pipe <-> TCP pump, no runtime
 *      needed) with mingw, falling back to the committed prebuilt exe
 *   3. Compiles streamproxy.c (LD_PRELOAD shim that redirects ZaloCall's
 *      screen-capture reads to the Wayland bridge display) with gcc
 *
 * No proprietary binaries are committed to this repository — everything is
 * fetched from official sources at setup time (same policy as the macOS DMG).
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const logger = require('./utils/logger');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'app', 'native', 'qt-call-and-cap');
const TEMP_DIR = path.join(ROOT, 'temp');

async function main() {

  const currentArch = process.arch || os.arch();
  if (currentArch === 'arm64' || currentArch === 'aarch64') {
    logger.warn(`Skipping zcall-bridge setup: aarch64 is not supported for 32-bit Wine runtime.`);
    return;
  }

  // -------------------------------------------------------------------------
  // 1. plugins/capture from the Windows installer
  // -------------------------------------------------------------------------
  const version = process.env.ZALO_WIN_VERSION;
  if (!version) {
    throw new Error('ZALO_WIN_VERSION is required; run prepare-app.js before zcall-bridge setup');
  }
  logger.info(`Setting up call-v2 runtime from Zalo Windows v${version}...`);

  const captureSrc = path.join(TEMP_DIR, `Zalo-Win-${version}`, `Zalo-${version}`, 'plugins', 'capture');
  if (!fs.existsSync(path.join(captureSrc, 'ZaloCall.exe'))) {
    throw new Error(`Windows capture runtime missing: ${captureSrc}; run prepare-app.js first`);
  }
  fs.ensureDirSync(TARGET);
  fs.copySync(captureSrc, TARGET, { overwrite: true });
  logger.success('ZaloCall.exe + Qt runtime installed');

  // Trim the capture folder: keep only what ZaloCall.exe needs.
  // Verified by replay tests: 1-1 calls work without these.
  for (const junk of ['pdbs', 'translations', 'bearer', 'iconengines',
                      'playlistformats', 'sqldrivers', 'styles']) {
    fs.removeSync(path.join(TARGET, junk));
  }
  for (const junkFile of ['opengl32sw.dll',  // Qt software-GL fallback (unused under Wine)
                          'Qt5Sql.dll', 'Qt5Xml.dll']) {
    fs.removeSync(path.join(TARGET, junkFile));
  }
  // Note: ZaviMeet.exe (19MB) is KEPT — required for group video calls.
  logger.dim('Trimmed unneeded Qt plugins / DLLs');

  // -------------------------------------------------------------------------
  // 2. pipebridge.exe (tiny C named-pipe <-> TCP pump, no runtime needed).
  //    Compiled from source — requires mingw on the build machine
  //    (i686-w64-mingw32-gcc). Binaries are not committed (*.exe is
  //    gitignored per repo policy).
  // -------------------------------------------------------------------------
  const srcC = path.join(ROOT, 'zcall-bridge', 'pipebridge.c');
  const builtExe = path.join(ROOT, 'zcall-bridge', 'pipebridge.exe');
  if (fs.existsSync(srcC)) {
    try {
      execSync(`i686-w64-mingw32-gcc "${srcC}" -lws2_32 -O2 -o "${builtExe}"`, {
        cwd: ROOT, stdio: 'pipe'
      });
      logger.dim('pipebridge.exe compiled from source');
    } catch (e) {
      throw new Error(
        'mingw (i686-w64-mingw32-gcc) is required to build pipebridge.exe — ' +
        'install it with: sudo apt install gcc-mingw-w64-i686'
      );
    }
  }
  if (fs.existsSync(builtExe)) {
    fs.copyFileSync(builtExe, path.join(TARGET, 'pipebridge.exe'));
    logger.success('pipebridge.exe installed');
  } else {
    logger.warn('pipebridge.exe missing — build it with: i686-w64-mingw32-gcc zcall-bridge/pipebridge.c -lws2_32 -O2 -o zcall-bridge/pipebridge.exe');
  }

  // PE32 COM entry point for the WoW64 camera hook. Wine registers this in
  // its own prefix; no Zalo or Qt DLL is modified.
  const cameraHookSrc = path.join(ROOT, 'zcall-bridge', 'camera-hook.c');
  const cameraHookDll = path.join(ROOT, 'zcall-bridge', 'camera-hook.dll');
  try {
    execSync(`i686-w64-mingw32-gcc -shared -static-libgcc -O2 -Wall -Wextra -Werror "${cameraHookSrc}" -lole32 -loleaut32 -lstrmiids -luuid -lws2_32 -Wl,--kill-at -o "${cameraHookDll}"`, {
      cwd: ROOT, stdio: 'pipe'
    });
    logger.dim('camera-hook.dll (PE32) compiled from source');
  } catch (e) {
    throw new Error('Could not build the WoW64 camera hook: ' + String(e.stderr || e.message).trim().slice(-300));
  }

  // -------------------------------------------------------------------------
  // 3. streamproxy.so (LD_PRELOAD shim that redirects ZaloCall's
  //    screen-capture reads to the bridge display). MUST be 64-bit: the
  //    default WoW64 Unix process binds the 64-bit libX11, even though
  //    ZaloCall is a 32-bit PE app — a 32-bit shim would not intercept it.
  // -------------------------------------------------------------------------
  const proxySrc = path.join(ROOT, 'zcall-bridge', 'streamproxy.c');
  const proxySo = path.join(ROOT, 'zcall-bridge', 'streamproxy.so');
  if (fs.existsSync(proxySrc)) {
    try {
      // Honor the distro toolchain environment so the shim gets the same
      // hardening as the rest of the package (e.g. `-Wl,-z,now` for FULL RELRO).
      // All three variables are unset in a plain shell, so nothing changes there.
      const cc = process.env.CC || 'gcc';
      const cflags = process.env.CFLAGS || '';
      const ldflags = process.env.LDFLAGS || '';
      execSync(`${cc} -m64 ${cflags} -shared -fPIC -O2 "${proxySrc}" -ldl -lX11 -lxcb ${ldflags} -o "${proxySo}"`, {
        cwd: ROOT, stdio: 'pipe'
      });
      logger.dim(`${path.basename(proxySo)} (64-bit) compiled from source`);
    } catch (e) {
      throw new Error(
        '64-bit X11 development libraries are required for streamproxy.so — install with: sudo apt install libx11-dev libxcb1-dev' +
        ' (gcc said: ' + String(e.stderr || e.message).trim().slice(-300) + ')'
      );
    }
  } else {
    logger.warn('streamproxy.c missing — share screen will not work on Wayland');
  }

  logger.success('call-v2 runtime ready: ' + TARGET);
}

if (require.main === module) {
  main().catch((e) => {
    logger.error('Setup failed:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
