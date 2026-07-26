const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const BUNDLE_DIRS = [
  path.join(APP_DIR, 'main-dist'),
  path.join(APP_DIR, 'pc-dist')
];

const PATH_MODULE_EXPORT_ANCHOR =
  'n.d(t,"gethomeDirSyncAlt",(function(){return ';
const LOCALIZED_EXPORTS =
  'n.d(t,"getdocumentsDir",(function(){return zflGetDocumentsDir})),' +
  'n.d(t,"getdocumentsDirSync",(function(){return zflGetDocumentsDirSync})),' +
  'n.d(t,"getdownloadsDir",(function(){return zflGetDownloadsDir})),' +
  'n.d(t,"getdownloadsDirSync",(function(){return zflGetDownloadsDirSync})),' +
  'n.d(t,"resolveLocalizedUserPath",(function(){return zflResolveLocalizedUserPath})),';

function addLocalizedPathExports(content) {
  if (content.includes('"getdownloadsDir"')) return content;

  const anchorIndex = content.indexOf(PATH_MODULE_EXPORT_ANCHOR);
  if (anchorIndex === -1) {
    throw new Error('App path module export anchor not found.');
  }

  const exportEnd = content.indexOf(')),', anchorIndex);
  if (exportEnd === -1) {
    throw new Error('App path module export terminator not found.');
  }

  return content.slice(0, exportEnd + 3) +
    LOCALIZED_EXPORTS +
    content.slice(exportEnd + 3);
}

function addLocalizedPathHelpers(content) {
  if (content.includes('zflGetDownloadsDir=async()=>')) return content;

  const managerAndPathPattern =
    /const ([A-Za-z_$][\w$]*)=[^,;]*createAppPathManager\(\),([A-Za-z_$][\w$]*)=([^,;]+),/;
  const match = content.match(managerAndPathPattern);
  if (!match) {
    throw new Error('App path manager anchor not found.');
  }

  const [anchor, manager, pathApi, pathValue] = match;
  const helpers =
    `const ${manager}=${anchor.slice(anchor.indexOf('=') + 1, anchor.indexOf(','))},` +
    `${pathApi}=${pathValue},` +
    `zflGetDocumentsDir=async()=>${pathApi}.join(await ${manager}.getPath("documents"),${pathApi}.sep),` +
    `zflGetDocumentsDirSync=()=>${pathApi}.join(${manager}.getPathSync("documents"),${pathApi}.sep),` +
    `zflGetDownloadsDir=async()=>${pathApi}.join(await ${manager}.getPath("downloads"),${pathApi}.sep),` +
    `zflGetDownloadsDirSync=()=>${pathApi}.join(${manager}.getPathSync("downloads"),${pathApi}.sep),` +
    `zflResolveLocalizedUserPath=e=>{` +
      `if(${pathApi}.isAbsolute(e))return ${pathApi}.resolve(e);` +
      `const t=e.split(/[\\\\/]+/),n=t[0].toLowerCase();` +
      `return"documents"===n?${pathApi}.resolve(zflGetDocumentsDirSync(),...t.slice(1)):` +
      `"downloads"===n?${pathApi}.resolve(zflGetDownloadsDirSync(),...t.slice(1)):` +
      `${pathApi}.resolve(${manager}.getPathSync("home"),e)` +
    `},`;

  return content.replace(anchor, helpers);
}

function patchStoredUserPath(content) {
  const serviceStart = content.indexOf('VVt6:function');
  if (serviceStart === -1) {
    throw new Error('Received-files path service not found.');
  }

  const servicePrefix = content.slice(serviceStart, serviceStart + 1200);
  const pathModuleMatch = servicePrefix.match(
    /([A-Za-z_$][\w$]*)=n\("IpzU"\)/
  );
  if (!pathModuleMatch) {
    throw new Error('Path module import not found in the received-files path service.');
  }
  const pathModule = pathModuleMatch[1];
  const localizedPath = `Object(${pathModule}.resolveLocalizedUserPath)(t.path)`;

  if (servicePrefix.includes(localizedPath)) return content;

  // Also matches an older broken version of this patch which hard-coded the
  // minified alias `r`. That alias is a local store getter in some bundles.
  const existingLocalizedPattern =
    /Object\([A-Za-z_$][\w$]*\.resolveLocalizedUserPath\)\(t\.path\)/;
  if (servicePrefix.match(existingLocalizedPattern)) {
    return content.slice(0, serviceStart) +
      content.slice(serviceStart).replace(existingLocalizedPattern, localizedPath);
  }

  const storedPathPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.resolve\(([A-Za-z_$][\w$]*),t\.path\)/;
  const match = servicePrefix.match(storedPathPattern);
  if (!match) {
    throw new Error('Stored received-files path anchor not found.');
  }

  return content.slice(0, serviceStart) +
    content.slice(serviceStart).replace(
      storedPathPattern,
      `$1=${localizedPath}`
    );
}

function patchDefaultDocumentsPath(content) {
  if (!content.includes(',"Documents","Zalo Received Files",')) return content;

  const asyncPattern =
    /([A-Za-z_$][\w$]*)\.join\(await ([A-Za-z_$][\w$]*)\(\),"Documents","Zalo Received Files",\1\.sep\)/g;
  const syncPattern =
    /([A-Za-z_$][\w$]*)\.join\(([A-Za-z_$][\w$]*)\(\),"Documents","Zalo Received Files",\1\.sep\)/g;

  const managerMatch = content.match(
    /const ([A-Za-z_$][\w$]*)=[^,;]*createAppPathManager\(\)/
  );
  if (!managerMatch) {
    throw new Error('App path manager not found while patching the default Documents path.');
  }
  const manager = managerMatch[1];

  let asyncCount = 0;
  let syncCount = 0;
  content = content.replace(asyncPattern, (match, pathApi) => {
    asyncCount += 1;
    return `${pathApi}.join(await ${manager}.getPath("documents"),"Zalo Received Files",${pathApi}.sep)`;
  });
  content = content.replace(syncPattern, (match, pathApi) => {
    syncCount += 1;
    return `${pathApi}.join(${manager}.getPathSync("documents"),"Zalo Received Files",${pathApi}.sep)`;
  });

  if (asyncCount !== 1 || syncCount !== 2) {
    throw new Error(
      `Expected one async and two sync Documents paths, found ${asyncCount} and ${syncCount}.`
    );
  }
  return content;
}

function patchRendererUserPaths(content) {
  const syncDocumentsPattern =
    /([A-Za-z_$][\w$]*)\.join\(Object\(([A-Za-z_$][\w$]*)\.gethomeDirSync\)\(\),"Documents","Zalo Received Files",\1\.sep\)/g;
  const downloadsPattern =
    /let ([A-Za-z_$][\w$]*)=await Object\(([A-Za-z_$][\w$]*)\.gethomeDir\)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.join\(\1,"Downloads"\)/g;

  content = content.replace(
    syncDocumentsPattern,
    '$1.join(Object($2.getdocumentsDirSync)(),"Zalo Received Files",$1.sep)'
  );
  content = content.replace(
    downloadsPattern,
    'let $3=await Object($2.getdownloadsDir)()'
  );
  return content;
}

function patchXdgUserDirs(content) {
  const moduleStart = content.indexOf('IpzU:function');
  if (moduleStart === -1) {
    throw new Error('Zalo app path module not found.');
  }

  const prefix = content.slice(0, moduleStart);
  let pathModuleAndRemainder = content.slice(moduleStart);

  pathModuleAndRemainder = addLocalizedPathExports(pathModuleAndRemainder);
  pathModuleAndRemainder = addLocalizedPathHelpers(pathModuleAndRemainder);
  pathModuleAndRemainder = patchStoredUserPath(pathModuleAndRemainder);
  pathModuleAndRemainder = patchDefaultDocumentsPath(pathModuleAndRemainder);
  pathModuleAndRemainder = patchRendererUserPaths(pathModuleAndRemainder);
  return prefix + pathModuleAndRemainder;
}

function findJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

async function main() {
  logger.info('Patching XDG user directories...');
  const bundlePaths = BUNDLE_DIRS
    .flatMap(findJavaScriptFiles)
    .filter((filePath) => {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.includes('getDefaultZaloReceivedFiles') &&
        content.includes('createAppPathManager');
    });

  if (bundlePaths.length === 0) {
    throw new Error('No Zalo path bundles found.');
  }

  let updatedCount = 0;
  for (const filePath of bundlePaths) {
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = patchXdgUserDirs(original);
    if (patched !== original) {
      fs.writeFileSync(filePath, patched, 'utf8');
      updatedCount += 1;
      logger.dim(`Patched localized user directories in ${path.relative(APP_DIR, filePath)}`);
    }
  }

  logger.success(
    `XDG user directory patch applied (${bundlePaths.length} checked, ${updatedCount} updated)`
  );
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('XDG user directory patch failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  patchXdgUserDirs
};
