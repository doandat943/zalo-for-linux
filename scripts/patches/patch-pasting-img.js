const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

async function main() {
  const mainDistPreloadFiles = [
    'compact-app-preload.js',
    'preload-noti.js',
    'preload-shared-worker.js',
    'preload-sqlite.js',
    'preload-render.js'
  ];

  for (const preloadFile of mainDistPreloadFiles) {
    const PreloadPath = path.join(APP_DIR, 'main-dist', preloadFile);
    
    if (!fs.existsSync(PreloadPath)) {
      logger.warn(`${preloadFile} not present, skipping patch`);
      continue;
    }

    let content = fs.readFileSync(PreloadPath, 'utf8');
    
    // Apply new get img clipboard functions
    original = `getClipboardImage:()=>{const e=r.clipboard.readImage();return{isEmpty:()=>e.isEmpty(),toJPEG:t=>e.toJPEG(t),toPNG:t=>e.toPNG(t)}},`;
    pasteImageFunc = `getClipboardImagePNG:()=>{let e=r.clipboard.readImage();if(e.isEmpty())try{const t=r.clipboard.readBuffer("image/png");t&&t.length>0&&(e=r.nativeImage.createFromBuffer(t))}catch(e){}return e.isEmpty()?null:e.toPNG().toString("base64")},getClipboardFilePath:()=>{try{const{execSync:e}=require("child_process"),r=e("wl-paste --type text/uri-list 2>/dev/null",{timeout:1e3}).toString().trim();if(!r)return null;const t=r.split("\\n")[0].trim();return t.startsWith("file://")?decodeURIComponent(t.replace("file://","")):null}catch(e){return null}},deleteFile:e=>{try{require("fs").unlinkSync(e)}catch(e){}},saveClipboardImageToTemp:()=>{try{const e=require("fs"),t=require("os"),a=require("path");let o=r.clipboard.readImage();if(o.isEmpty())try{const e=r.clipboard.readBuffer("image/png");e&&e.length>0&&(o=r.nativeImage.createFromBuffer(e))}catch(e){}if(o.isEmpty())return null;const n=a.join(t.tmpdir(),"zalo_clip_"+Date.now()+".png");return e.writeFileSync(n,o.toPNG()),n}catch(e){return String(e)}},`;
    if (content.includes(original)) {
      content = content.replace(original, original + pasteImageFunc);
      fs.writeFileSync(PreloadPath, content, 'utf8');
      logger.dim(`Patched ${preloadFile}: applied new get image clipboard functions`);
    } else {
      logger.warn(`Pattern getClipboardImage:() not found in ${PreloadPath}, skipping patch`);
    }

    // Apply cleanup clipboard and drag-and-drop img emulation to preload-render.js
    if (preloadFile === 'preload-render.js') {
        cleanupAndDADEmuCode = `try{const e=require("fs"),t=require("os"),n=require("path");e.readdirSync(t.tmpdir()).filter(e=>e.startsWith("zalo_clip_")).forEach(a=>{try{e.unlinkSync(n.join(t.tmpdir(),a))}catch(e){}})}catch(e){}window.addEventListener("DOMContentLoaded",()=>{let e=0;document.addEventListener("paste",async t=>{const n=Date.now();n-e<200||(e=n,await async function(){if(window.$zelectronNative)try{let e=null;const t=window.$zelectronNative.getClipboardImagePNG&&window.$zelectronNative.getClipboardImagePNG();if(t){const n=atob(t),a=new Uint8Array(n.length);for(let e=0;e<n.length;e++)a[e]=n.charCodeAt(e);e=new File([a],"image.png",{type:"image/png"})}else{const t=window.$zelectronNative.getClipboardFilePath&&window.$zelectronNative.getClipboardFilePath();if(!t)return;const n=t.split(".").pop().toLowerCase();if(!["png","jpg","jpeg","gif","webp","bmp","tiff","tif","avif","jxl"].includes(n))return;const a=await fetch("file://"+t),i=await a.blob();e=new File([i],t.split("/").pop(),{type:i.type||"image/png"})}if(!e)return;const n=new DataTransfer;n.items.add(e);const a=document.getElementById("dragOverlayInputbox");if(!a)return;a.style.display="block",a.dispatchEvent(new DragEvent("dragenter",{dataTransfer:n,bubbles:!0})),a.dispatchEvent(new DragEvent("dragover",{dataTransfer:n,bubbles:!0})),a.dispatchEvent(new DragEvent("drop",{dataTransfer:n,bubbles:!0,cancelable:!0}))}catch(e){}}())},!0)});`;
        fs.writeFileSync(PreloadPath, cleanupAndDADEmuCode + content, 'utf8');
        logger.dim(`Patched ${preloadFile}: applied cleanup and drag-and-drop image emulation to the paste action.`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };