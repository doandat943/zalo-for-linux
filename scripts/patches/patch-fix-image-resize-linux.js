const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

// Zalo's native photo-resize library ("zimage", app/native/nativelibs/zimage)
// only ships prebuilt binaries for darwin_arm64/darwin_x64 (and a win32
// build). Its platform-detection code never assigns a Linux target, so on
// Linux the resize call always rejects with NOT_SUPPORT. The resize-handler
// utility-process task then throws IMAGE_LOAD_FAILED ("IMG element failed
// to load image"), which the renderer catches and silently falls back to
// sending the photo as a generic file attachment instead of an image
// message. This patch makes the resize task fall back to the original,
// unresized image bytes when the native resize call fails, instead of
// throwing — the image is still sent as a photo, just without the
// size/quality reduction that macOS/Windows builds get from libvips.
async function main() {
  const mediaJsPath = path.join(APP_DIR, 'main-dist', 'utility-process-media.js');

  if (!fs.existsSync(mediaJsPath)) {
    logger.warn('utility-process-media.js not present, skipping image-resize Linux fallback patch');
    return;
  }

  let content = fs.readFileSync(mediaJsPath, 'utf8');

  const original = 'try{const t=await Y.resizeImage(c,n,r,i,"image/jpeg"===o?"jpeg":"png");' +
    'if(null==t)throw this.logger.zsymb(21,"EFr71P",["resize fail, result is null","S8hEat"],e.payload),new q;' +
    'if(s)try{await $.a.promises.writeFile(s,new Uint8Array(t))}catch(u){this.logger.zsymb(21,"9mlU0t",["write file fail","BGvPmN"],s,u)}}' +
    'catch(l){throw this.logger.zsymb(21,"dtOtok",["resize fail","yytUN5"],e.payload,l),new q}';

  const replacement = 'try{let t;try{t=await Y.resizeImage(c,n,r,i,"image/jpeg"===o?"jpeg":"png")}catch(zNativeErr){t=null}' +
    'if(null==t){this.logger.zsymb(21,"ZFIX01",["native resize unavailable (no Linux build of zimage), falling back to original bytes","ZFIX01"],e.payload);t=c}' +
    'if(s)try{await $.a.promises.writeFile(s,new Uint8Array(t))}catch(u){this.logger.zsymb(21,"9mlU0t",["write file fail","BGvPmN"],s,u)}}' +
    'catch(l){throw this.logger.zsymb(21,"dtOtok",["resize fail","yytUN5"],e.payload,l),new q}';

  if (content.includes(original)) {
    content = content.replace(original, replacement);
    fs.writeFileSync(mediaJsPath, content, 'utf8');
    logger.dim('Patched utility-process-media.js: fall back to unresized bytes when native image resize is unavailable (Linux)');
  } else {
    logger.warn('Pattern for resize-handler not found in utility-process-media.js, skipping image-resize Linux fallback patch (Zalo may have changed this code)');
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
