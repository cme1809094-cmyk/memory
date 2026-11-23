const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const yauzl = require('yauzl');
const storage = require('./store.cjs');

const previewBytes = 16 * 1024;
const summaryChars = 260;
const textExtensions = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.html', '.toml', '.ini', '.sql', '.ps1', '.js', '.ts', '.py', '.sh', '.bat', '.cmd'
]);
const officePreviews = new Map([
  ['.docx', { part: 'word/document.xml', textTag: 'w:t' }],
  ['.pptx', { part: 'ppt/slides/slide1.xml', textTag: 'a:t' }]
]);

function clipboardFiles(uriList) {
  const files = [];
  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim();
    if (!value.toLowerCase().startsWith('file:')) continue;
    const url = new URL(value);
    if (url.hostname && url.hostname !== 'localhost') {
      throw new Error('请复制本机文件。暂不支持从网络共享直接保存。');
    }
    files.push(fileURLToPath(url));
  }
  return files;
}

function readPrefix(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(previewBytes);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.includes(0)) return '';
  return new TextDecoder().decode(bytes).replace(/\ufffd$/u, '');
}

function decodeXml(value) {
  return value.replace(/&(lt|gt|amp|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});/g, (match, entity) => {
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity];
    const codePoint = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

async function officePrefix(file, { part, textTag }) {
  const zip = await yauzl.openPromise(file, { autoClose: false });
  try {
    let scanned = 0;
    for await (const entry of zip.eachEntry()) {
      if (++scanned > 2048) break;
      if (entry.fileName !== part) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      let remaining = previewBytes;
      for await (const chunk of stream) {
        chunks.push(chunk.subarray(0, remaining));
        remaining -= Math.min(remaining, chunk.length);
        if (!remaining) break;
      }
      const xml = decodeText(Buffer.concat(chunks));
      const tags = new RegExp('<' + textTag + '(?:\\s[^>]*)?>([^<]*)</' + textTag + '>|</(?:w|a):p>', 'g');
      return Array.from(xml.matchAll(tags), (match) => match[1] === undefined ? '\n' : decodeXml(match[1])).join('');
    }
    return '';
  } finally {
    zip.close();
  }
}

async function summarizeFile(file, name) {
  const extension = path.extname(name).toLowerCase();
  let preview = '';
  if (textExtensions.has(extension)) {
    preview = decodeText(readPrefix(file));
  } else if (officePreviews.has(extension)) {
    try {
      preview = await officePrefix(file, officePreviews.get(extension));
    } catch {
      return '';
    }
  }
  const lines = preview.split(/\r?\n/).map((line) => line
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|>)\s+/, '')
    .replace(/\s+/g, ' ').trim()).filter((line) => /[\p{L}\p{N}]/u.test(line));
  const excerpt = [...new Set(lines)].slice(0, 3).join(' ');
  const chars = Array.from(excerpt);
  return chars.length > summaryChars ? chars.slice(0, summaryChars - 1).join('') + '…' : excerpt;
}

async function captureFiles(configFile, scope, paths) {
  const config = storage.readConfig(configFile);
  if (scope !== config.scope) throw new Error('活动知识库已切换，请重新保存文件。');
  const sources = [...new Set(paths)].sort();
  if (!sources.length || sources.length > 100) throw new Error('每次可保存 1 至 100 个文件。');
  const staging = fs.mkdtempSync(path.join(storage.prepareFileDirectory(config.directory), '.capture-'));
  const files = [];
  let committed = false;
  try {
    for (const source of sources) {
      const name = path.basename(source);
      const original = fs.lstatSync(source);
      if (!original.isFile()) throw new Error('只能保存普通文件：' + name);
      const id = randomUUID();
      const staged = path.join(staging, id);
      fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      const size = fs.statSync(staged).size;
      const current = fs.lstatSync(source);
      if (size !== original.size || current.size !== size || current.mtimeMs !== original.mtimeMs ||
          current.ctimeMs !== original.ctimeMs) throw new Error('文件在复制期间发生变化：' + name);
      files.push({ id, staged, name, size, summary: await summarizeFile(staged, name),
        fingerprint: JSON.stringify([source, size, original.mtimeMs, original.ctimeMs]) });
    }
    const basename = files[0].name;
    const title = files.length === 1 ? basename : basename + ' 等 ' + files.length + ' 个文件';
    const result = storage.run(configFile, 'create', { scope, kind: 'capture', title, quick: true }, { files });
    committed = !result.value.duplicate;
    return result;
  } finally {
    if (!committed) {
      for (const file of files) fs.rmSync(storage.filePath(config.directory, file.id), { force: true });
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { clipboardFiles, captureFiles };
