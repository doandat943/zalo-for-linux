const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

// The renderer's photo-resize entry point (offloads to the native "zimage"
// resize task, see patch-fix-image-resize-linux.js for why that fails on
// Linux) is called with either a filesystem path (drag-drop of a real file)
// or a raw File/Blob object (clipboard paste, in-memory sources) as its
// first argument. Passing a File object through to the Node utility-process
// task hangs forever — Electron's structured-clone can't transfer a File
// across that boundary ("#<File> could not be cloned"), and the renderer
// never gets a response back.
//
// This patch replaces that entry point with a pure Canvas 2D resize: decode
// via <img>, draw scaled onto a canvas, re-encode with canvas.toBlob(). It
// handles both source types (reads the path via $zFileManager first if
// needed), so it also fixes the Linux-only "no native resize" gap without
// falling back to sending an unresized image (unlike the destinationPath
// fallback in patch-fix-image-resize-linux.js, which is left in place as a
// backstop for any other caller of the native resize path).
async function main() {
  const original = 'async resizeImage(t,{width:n,height:a,quality:s,format:i,destinationPath:o}){' +
    'const r=new F.ResizeTask({payload:{src:t,width:n,height:a,quality:s,outputFormat:i,destinationPath:o}});' +
    'De.zsymb(15,"Wa57B9",["offload resize via libvips","XuCTfw"],{src:t});' +
    'try{const e=await r.run();' +
    'return De.zsymb(15,"vYh1lX",["offload resize via libvips complete","UvVbd5"],{src:t}),e}' +
    'catch(e){throw De.zsymb(21,"sriLO1",["offload resize via libvips fail","s606QH"],{src:t,error:e}),e}}';

  const replacement = 'async resizeImage(t,{width:n,height:a,quality:s,format:i,destinationPath:o}){' +
    'De.zsymb(15,"Wa57B9",["offload resize via libvips","XuCTfw"],{src:t});' +
    'try{' +
    'const zsrcBlob="string"==typeof t?new Blob([await window.$zFileManager.getFileArrayBuffer(t)]):t;' +
    'const zurl=URL.createObjectURL(zsrcBlob);' +
    'let zoutBlob;' +
    'try{' +
    'const zimg=await new Promise(((zres,zrej)=>{' +
    'const zim=new Image();' +
    'zim.onload=()=>zres(zim);' +
    'zim.onerror=()=>zrej(new Error("canvas-resize: source image failed to decode"));' +
    'zim.src=zurl' +
    '}));' +
    'const zcanvas=document.createElement("canvas");' +
    'zcanvas.width=n;zcanvas.height=a;' +
    'const zctx=zcanvas.getContext("2d");' +
    'zctx.drawImage(zimg,0,0,n,a);' +
    'zoutBlob=await new Promise((zres=>zcanvas.toBlob(zres,"jpeg"===i?"image/jpeg":"image/png",s)));' +
    'if(!zoutBlob)throw new Error("canvas-resize: toBlob returned null")' +
    '}finally{URL.revokeObjectURL(zurl)}' +
    'if(o)await window.$zFileManager.writeBlobToPath(o,zoutBlob);' +
    'return De.zsymb(15,"vYh1lX",["offload resize via libvips complete","UvVbd5"],{src:t}),o?void 0:zoutBlob}' +
    'catch(e){throw De.zsymb(21,"sriLO1",["offload resize via libvips fail","s606QH"],{src:t,error:e}),e}}';

  // pc-dist chunk filenames are content-hashed and change with every Zalo
  // release, so scan for whichever file(s) actually contain the pattern
  // instead of hardcoding a path.
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const candidates = listJsFiles(pcDistDir);
  let patchedCount = 0;

  for (const filePath of candidates) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes(original)) continue;

    const occurrences = content.split(original).length - 1;
    const newContent = content.split(original).join(replacement);
    fs.writeFileSync(filePath, newContent, 'utf8');
    logger.dim(`Patched ${path.relative(APP_DIR, filePath)}: canvas-based resize (${occurrences} occurrence${occurrences > 1 ? 's' : ''})`);
    patchedCount += occurrences;
  }

  if (patchedCount === 0) {
    logger.warn('Pattern for renderer resizeImage (F.ResizeTask offload) not found in app/pc-dist, skipping canvas-resize patch (Zalo may have changed this code)');
  }
}

function listJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

if (require.main === module) {
  main();
}

module.exports = { main };
