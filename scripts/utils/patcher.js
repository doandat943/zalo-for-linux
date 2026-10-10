const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

/**
 * Apply a list of replacements [{ from, to }] to content.
 *
 * @param {string} content - Original file content
 * @param {Array<{from: string|RegExp, to: string|Function}>} replacements
 * @returns {{content: string, changed: boolean}}
 */
function applyStringPatch(content, replacements) {
  let changed = false;
  let newContent = content;

  for (const item of replacements) {
    const from = Array.isArray(item) ? item[0] : item.from;
    const to = Array.isArray(item) ? item[1] : item.to;

    if (typeof from === 'string') {
      if (newContent.includes(from)) {
        newContent = newContent.split(from).join(to);
        changed = true;
      }
    } else if (from instanceof RegExp) {
      const next = newContent.replace(from, to);
      if (next !== newContent) {
        newContent = next;
        changed = true;
      }
    }
  }

  return { content: newContent, changed };
}

/**
 * Read a file, apply replacements, write back if changed, and log.
 *
 * @param {string} filePath - Absolute path to target file
 * @param {Array<{from: string|RegExp, to: string|Function}>} replacements
 * @param {string} [label] - Optional log label (defaults to basename)
 * @returns {boolean} Whether the file was modified
 */
function patchStrings(filePath, replacements, label) {
  if (!fs.existsSync(filePath)) {
    logger.warn(`File not found: ${filePath}`);
    return false;
  }

  const original = fs.readFileSync(filePath, 'utf8');
  const { content, changed } = applyStringPatch(original, replacements);
  const name = label || path.basename(filePath);

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    logger.dim(`Patched strings: ${name}`);
    return true;
  } else {
    logger.dim(`Already patched: ${name}`);
    return false;
  }
}

/**
 * Internal helper to inject a code block enclosed in standardized markers.
 * Automatically wraps the block with "// --- Zalo Linux: <name> Start ---" and "End ---".
 */
function applyBlockPatch(content, opts) {
  const { name, block, anchor, position = 'prepend' } = opts;
  const startMarker = `// --- Zalo Linux: ${name} Start ---`;
  const endMarker = `// --- Zalo Linux: ${name} End ---`;

  const fullBlock = `${startMarker}\n${block.trim()}\n${endMarker}\n`;

  const startIndex = content.indexOf(startMarker);
  if (startIndex !== -1) {
    const endIndex = content.indexOf(endMarker, startIndex);
    if (endIndex !== -1) {
      const before = content.slice(0, startIndex);
      const after = content.slice(endIndex + endMarker.length).replace(/^\r?\n/, '');
      const existing = content.slice(startIndex, endIndex + endMarker.length);
      if (existing.trim() === fullBlock.trim()) {
        return { content, changed: false };
      }
      return { content: before + fullBlock + after, changed: true };
    }
  }

  if (anchor) {
    if (typeof anchor === 'string' && content.includes(anchor)) {
      return { content: content.replace(anchor, `${anchor};\n${fullBlock}`), changed: true };
    } else if (anchor instanceof RegExp && anchor.test(content)) {
      return { content: content.replace(anchor, `$&;\n${fullBlock}`), changed: true };
    }
  }

  if (position === 'append') {
    return { content: content.trimEnd() + '\n\n' + fullBlock, changed: true };
  } else {
    return { content: fullBlock + content.replace(/^\r?\n/, ''), changed: true };
  }
}

/**
 * Inject or update a code block enclosed in standardized markers into a file, and log.
 *
 * @param {string} filePath - Absolute path to target file
 * @param {object} opts
 * @param {string} opts.name - Patch/feature name for markers
 * @param {string} opts.block - Code block string to inject
 * @param {string|RegExp} [opts.anchor] - Optional anchor string/regex to place block after
 * @param {'prepend'|'append'} [opts.position='prepend'] - Insertion position if anchor not used
 * @param {string} [label] - Optional log label
 * @returns {boolean} Whether the file was modified
 */
function patchBlock(filePath, opts, label) {
  if (!fs.existsSync(filePath)) {
    logger.warn(`File not found: ${filePath}`);
    return false;
  }

  const original = fs.readFileSync(filePath, 'utf8');
  const { content, changed } = applyBlockPatch(original, opts);
  const name = label || opts.name || path.basename(filePath);

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    logger.dim(`Patched block: ${name}`);
    return true;
  } else {
    logger.dim(`Already up to date: ${name}`);
    return false;
  }
}

/**
 * Scan a directory for files matching a pattern.
 *
 * @param {string} dir - Directory to search
 * @param {RegExp} pattern - Regex to match against file names
 * @returns {string[]} Array of absolute file paths
 */
function findTargetFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => pattern.test(f))
    .map(f => path.join(dir, f));
}

module.exports = {
  patchStrings,
  patchBlock,
  findTargetFiles
};
