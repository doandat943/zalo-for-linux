const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const PATCH_MARKER = 'zalo-linux-browser-image-resize-v2';

// Zalo normally sends images to a native libvips task before uploading them.
// That task is not reliable on Linux and a clipboard File cannot be structured-
// cloned to Electron's utility process. Keep the resize inside Chromium and,
// most importantly, return the original Blob when decoding/resizing fails. A
// rejected resize promise makes Zalo downgrade an otherwise valid image to a
// generic attachment.
async function main() {
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const candidates = listJsFiles(pcDistDir);
  let patchedCount = 0;
  let alreadyPatchedCount = 0;

  for (const filePath of candidates) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(PATCH_MARKER)) alreadyPatchedCount += 1;

    const matches = findResizeMethods(content);
    if (matches.length === 0) continue;

    let newContent = content;
    for (const match of matches.slice().reverse()) {
      newContent = newContent.slice(0, match.start)
        + buildReplacement(match.variables)
        + newContent.slice(match.end);
    }

    fs.writeFileSync(filePath, newContent, 'utf8');
    logger.dim(`Patched ${path.relative(APP_DIR, filePath)}: browser image resize with Blob fallback (${matches.length} occurrence${matches.length > 1 ? 's' : ''})`);
    patchedCount += matches.length;
  }

  if (patchedCount === 0 && alreadyPatchedCount === 0) {
    logger.warn('Renderer ResizeTask entry point not found in app/pc-dist; Zalo may have changed this code');
  }
}

function findResizeMethods(content) {
  // Match only the stable shape of the ResizeTask call. Logger identifiers and
  // message IDs are intentionally ignored because Zalo changes them per build.
  const startPattern = /async resizeImage\(([$\w]+),\{width:([$\w]+),height:([$\w]+),quality:([$\w]+),format:([$\w]+),destinationPath:([$\w]+)\}\)\{const ([$\w]+)=new [$\w]+\.ResizeTask\(\{payload:\{src:\1,width:\2,height:\3,quality:\4,outputFormat:\5,destinationPath:\6\}\}\);/g;
  const matches = [];
  let found;

  while ((found = startPattern.exec(content)) !== null) {
    // The first brace belongs to the destructured options parameter. The
    // method body is the later `{const ...` matched by startPattern.
    const bodyStart = content.indexOf('{const', found.index);
    const end = findMatchingBrace(content, bodyStart);
    if (end < 0) continue;

    const method = content.slice(found.index, end + 1);
    if (!method.includes('offload resize via libvips') || !method.includes(`await ${found[7]}.run()`)) continue;

    matches.push({
      start: found.index,
      end: end + 1,
      variables: {
        src: found[1],
        width: found[2],
        height: found[3],
        quality: found[4],
        format: found[5],
        destinationPath: found[6],
      },
    });
    startPattern.lastIndex = end + 1;
  }

  return matches;
}

function findMatchingBrace(content, openingBrace) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openingBrace; index < content.length; index += 1) {
    const character = content[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function buildReplacement({ src, width, height, quality, format, destinationPath }) {
  return `async resizeImage(${src},{width:${width},height:${height},quality:${quality},format:${format},destinationPath:${destinationPath}}){`
    + `const zMarker="${PATCH_MARKER}";`
    + `const zMime="jpeg"===${format}||"jpg"===${format}?"image/jpeg":"image/png";`
    + `let zSource="string"==typeof ${src}?new Blob([await window.$zFileManager.getFileArrayBuffer(${src})],{type:zMime}):${src};`
    + 'if(!(zSource instanceof Blob))zSource=new Blob([zSource],{type:zMime});'
    + 'try{'
    + 'const zBitmap=await createImageBitmap(zSource);'
    + 'let zOutput;'
    + 'try{'
    + 'const zCanvas=document.createElement("canvas");'
    + `const zWidth=Math.max(1,Math.round(Number(${width})||zBitmap.width));`
    + `const zHeight=Math.max(1,Math.round(Number(${height})||zBitmap.height));`
    + 'zCanvas.width=zWidth;zCanvas.height=zHeight;'
    + 'const zContext=zCanvas.getContext("2d");'
    + 'if(!zContext)throw new Error("Linux image resize: Canvas 2D unavailable");'
    + 'zContext.drawImage(zBitmap,0,0,zWidth,zHeight);'
    + `zOutput=await new Promise(zResolve=>zCanvas.toBlob(zResolve,zMime,${quality}));`
    + 'if(!zOutput)throw new Error("Linux image resize: toBlob returned null")'
    + '}finally{zBitmap.close&&zBitmap.close()}'
    + `if(${destinationPath}){await window.$zFileManager.writeBlobToPath(${destinationPath},zOutput);return}`
    + 'return zOutput'
    + '}catch(zError){'
    + `console.warn(zMarker+": using original image",zError);`
    + `if(${destinationPath}){await window.$zFileManager.writeBlobToPath(${destinationPath},zSource);return}`
    + 'return zSource'
    + '}}';
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

module.exports = { main, findResizeMethods, findMatchingBrace, buildReplacement };
