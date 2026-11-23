const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const maxImage = 25 * 1024 * 1024;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpeg = Buffer.from([255, 216, 255]);
const id = () => crypto.randomUUID();
const iso = () => new Date().toISOString();
const normalize = (text) => text.normalize('NFKC').toLowerCase();
const tagsFrom = (tags = []) => [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
const fail = (message) => { throw new Error(message); };

function readConfig(configFile) {
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

function writeConfig(configFile, config) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const temporary = configFile + '.' + id();
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, configFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function open(directory, { create = false } = {}) {
  if (create) fs.mkdirSync(path.join(directory, 'images'), { recursive: true });
  const file = path.join(directory, 'memory.sqlite');
  if (!create && !fs.existsSync(file)) fail('找不到知识库数据库。');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=ON;');
    let version = db.prepare('PRAGMA user_version').get().user_version;
    if (!version && create) {
      db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;');
      version = db.prepare('PRAGMA user_version').get().user_version;
      if (!version) db.exec(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('capture','note')),
          title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL,
          local_only INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL,
          deleted TEXT, revision INTEGER NOT NULL DEFAULT 1, fingerprint TEXT
        );
        CREATE TABLE images (
          id TEXT PRIMARY KEY, entry TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          hash TEXT NOT NULL, mime TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          ocr TEXT NOT NULL DEFAULT '', visible INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX images_entry ON images(entry);
        CREATE TABLE sources (
          note TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          capture TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, PRIMARY KEY(note, capture)
        );
        CREATE INDEX sources_capture ON sources(capture);
        CREATE TABLE provenance (
          note TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          capture TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, PRIMARY KEY(note, capture)
        );
        CREATE INDEX provenance_capture ON provenance(capture);
        CREATE TABLE revisions (
          entry TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, version INTEGER NOT NULL,
          created TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(entry, version)
        );
        CREATE TABLE search_text (
          entry TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, value TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE search_fts USING fts5(entry UNINDEXED, value, tokenize='trigram');
        PRAGMA user_version=1;
      `);
      db.exec('COMMIT;');
    }
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) fail('知识库版本不受支持。');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function imagePath(directory, hash) {
  if (!/^[a-f\d]{64}$/.test(hash)) fail('图片文件标识无效。');
  return path.join(directory, 'images', hash);
}

function entryView(row) {
  return {
    id: row.id, kind: row.kind, title: row.title, body: row.body, tags: JSON.parse(row.tags),
    localOnly: Boolean(row.local_only), created: row.created, updated: row.updated,
    deleted: row.deleted, revision: row.revision
  };
}

function find(db, entry, agent = false) {
  const row = db.prepare('SELECT * FROM entries WHERE id=?').get(entry);
  if (!row || (agent && (row.local_only || row.deleted))) fail('找不到可访问的条目。');
  return row;
}

function imagesFor(db, entry) {
  return db.prepare('SELECT id,mime,status,ocr FROM images WHERE entry=? AND visible=1 ORDER BY rowid').all(entry);
}

function details(db, row, agent) {
  const visibility = agent ? 'AND c.local_only=0' : '';
  return {
    ...entryView(row),
    images: imagesFor(db, row.id),
    sources: db.prepare(`
      SELECT c.id,c.title,c.body,c.deleted FROM sources s JOIN entries c ON c.id=s.capture
      WHERE s.note=? ${agent ? 'AND c.deleted IS NULL' : ''} ${visibility} ORDER BY s.rowid
    `).all(row.id).map((source) => ({
      id: source.id, title: source.title, excerpt: source.body.slice(0, 100), deleted: source.deleted
    }))
  };
}

function reindex(db, entry) {
  const row = find(db, entry);
  const value = normalize([row.title, row.body, JSON.parse(row.tags).join(' '),
    ...imagesFor(db, entry).map((image) => image.ocr)].join('\n'));
  db.prepare('INSERT OR REPLACE INTO search_text VALUES (?,?)').run(entry, value);
  db.prepare('DELETE FROM search_fts WHERE entry=?').run(entry);
  db.prepare('INSERT INTO search_fts VALUES (?,?)').run(entry, value);
}

function list(db, input, agent) {
  const { view = 'all', query = '', offset = 0, tag = '' } = input;
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const terms = normalize(query).replaceAll('\0', '').trim().split(/\s+/).filter(Boolean).slice(0, 12);
  const where = [view === 'trash' && !agent ? 'e.deleted IS NOT NULL' : 'e.deleted IS NULL'];
  const values = [];
  if (agent) where.push('e.local_only=0');
  if (view === 'notes') where.push("e.kind='note'");
  if (view === 'inbox') where.push(`e.kind='capture' AND NOT EXISTS (
    SELECT 1 FROM sources s JOIN entries n ON n.id=s.note WHERE s.capture=e.id AND n.deleted IS NULL
    ${agent ? 'AND n.local_only=0' : ''})`);
  if (view === 'filed') where.push(`e.kind='capture' AND EXISTS (
    SELECT 1 FROM sources s JOIN entries n ON n.id=s.note WHERE s.capture=e.id AND n.deleted IS NULL
    ${agent ? 'AND n.local_only=0' : ''})`);
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value=?)');
    values.push(tag);
  }
  for (const term of terms) {
    if ([...term].length >= 3) {
      where.push('e.id IN (SELECT entry FROM search_fts WHERE search_fts MATCH ?)');
      values.push('"' + term.replaceAll('"', '""') + '"');
    }
    where.push("instr(s.value,?)>0");
    values.push(term);
  }
  const results = db.prepare(`
    SELECT e.*, (SELECT count(*) FROM images WHERE entry=e.id AND visible=1) AS image_count,
      (SELECT group_concat(ocr, char(10)) FROM images WHERE entry=e.id AND visible=1 AND ocr!='') AS ocr
    FROM entries e JOIN search_text s ON s.entry=e.id WHERE ${where.join(' AND ')}
    ORDER BY ${view === 'trash' ? 'e.deleted' : 'e.updated'} DESC, e.rowid DESC LIMIT ? OFFSET ?
  `).all(...values, limit + 1, Math.max(0, offset));
  return {
    more: results.length > limit,
    items: results.slice(0, limit).map((row) => {
      const { body, ...item } = entryView(row);
      const text = [body, row.ocr].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
      let at = terms.map((term) => normalize(text).indexOf(term)).find((index) => index >= 0) ?? 0;
      at = Math.max(0, at - 28);
      const excerpt = (at ? '…' : '') + text.slice(at, at + 166) + (at + 166 < text.length ? '…' : '');
      return { ...item, excerpt, imageCount: row.image_count };
    })
  };
}

function snapshot(db, row) {
  db.prepare('INSERT OR IGNORE INTO revisions VALUES (?,?,?,?)')
    .run(row.id, row.revision, row.updated, JSON.stringify({ ...entryView(row), imageIds: imagesFor(db, row.id).map((image) => image.id) }));
}

function checkRevision(row, revision) {
  if (row.revision !== revision) fail('条目已更新。请重新读取最新版本后再操作。');
}

function linkSources(db, note, sources, agent) {
  for (const source of new Set(sources)) {
    const row = find(db, source, agent);
    if (row.kind !== 'capture' || row.deleted) fail('只能关联有效的收件素材。');
    db.prepare('INSERT INTO sources VALUES (?,?)').run(note, source);
    db.prepare('INSERT OR IGNORE INTO provenance VALUES (?,?)').run(note, source);
  }
}

function enforcePrivacy(db, entry) {
  const inherited = db.prepare(`
    SELECT 1 FROM provenance p JOIN entries c ON c.id=p.capture WHERE p.note=? AND c.local_only=1
  `).get(entry);
  if (inherited) db.prepare('UPDATE entries SET local_only=1 WHERE id=?').run(entry);
  if (find(db, entry).local_only) {
    db.prepare(`
      UPDATE entries SET local_only=1, revision=revision+1, updated=?
      WHERE local_only=0 AND id IN (SELECT note FROM provenance WHERE capture=?)
    `).run(iso(), entry);
  }
}

function saveImages(db, directory, entry, images) {
  for (const buffer of images) {
    if (!Buffer.isBuffer(buffer) || buffer.length > maxImage) fail('每张图片最多 25 MB。');
    const mime = buffer.subarray(0, png.length).equals(png) ? 'image/png'
      : buffer.subarray(0, jpeg.length).equals(jpeg) ? 'image/jpeg' : fail('仅支持 PNG 和 JPEG 图片。');
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const target = imagePath(directory, hash);
    if (!fs.existsSync(target)) {
      const temporary = target + '.' + id();
      try {
        fs.writeFileSync(temporary, buffer, { flag: 'wx', flush: true });
        fs.renameSync(temporary, target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    db.prepare('INSERT INTO images (id,entry,hash,mime) VALUES (?,?,?,?)').run(id(), entry, hash, mime);
  }
}

function create(db, directory, input, agent) {
  const { kind = 'note', title = '', body = '', images = [], sources = [], localOnly = false, quick = false } = input;
  if (!body.trim() && !title.trim() && !images.length && !sources.length) fail('请添加文本、图片或来源素材。');
  const key = id();
  const now = iso();
  let fingerprint = null;
  if (quick) {
    const digest = crypto.createHash('sha256').update(body).update('\0');
    for (const image of images) digest.update(crypto.createHash('sha256').update(image).digest());
    fingerprint = digest.digest('hex');
    const duplicate = db.prepare(`
      SELECT id FROM entries WHERE fingerprint=? AND deleted IS NULL AND created>=? LIMIT 1
    `).get(fingerprint, new Date(Date.now() - 2500).toISOString());
    if (duplicate) return { id: duplicate.id, duplicate: true };
  }
  db.prepare(`
    INSERT INTO entries (id,kind,title,body,tags,local_only,created,updated,fingerprint)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(key, kind, title.trim(), body, JSON.stringify(tagsFrom(input.tags)), Number(localOnly), now, now, fingerprint);
  saveImages(db, directory, key, images);
  if (kind === 'note') linkSources(db, key, sources, agent);
  enforcePrivacy(db, key);
  reindex(db, key);
  return details(db, find(db, key), agent);
}

function edit(db, directory, input, agent) {
  const row = find(db, input.id, agent);
  if (row.deleted) fail('请先恢复该条目。');
  checkRevision(row, input.revision);
  snapshot(db, row);
  const { title, body, tags, localOnly } = { ...entryView(row), ...input };
  db.prepare(`
    UPDATE entries SET title=?,body=?,tags=?,local_only=?,revision=revision+1,updated=? WHERE id=?
  `).run(title.trim(), body, JSON.stringify(tagsFrom(tags)), Number(localOnly), iso(), row.id);
  if (input.imageIds) {
    db.prepare('UPDATE images SET visible=0 WHERE entry=?').run(row.id);
    for (const image of input.imageIds) {
      const updated = db.prepare('UPDATE images SET visible=1 WHERE entry=? AND id=?').run(row.id, image);
      if (!updated.changes) fail('附件不属于该条目。');
    }
  }
  saveImages(db, directory, row.id, input.images ?? []);
  enforcePrivacy(db, row.id);
  reindex(db, row.id);
  return details(db, find(db, row.id), agent);
}

const writeOperations = new Set(['create', 'edit', 'delete', 'restore', 'detach', 'restoreRevision',
  'purge', 'retryOcr', 'completeOcr']);

function operate(db, directory, operation, input, agent) {
  if (operation === 'list') return list(db, input, agent);
  if (operation === 'get') return details(db, find(db, input.id, agent), agent);
  if (operation === 'tags') {
    return db.prepare(`
      SELECT DISTINCT j.value AS name FROM entries e, json_each(e.tags) j
      WHERE e.deleted IS NULL ORDER BY j.value COLLATE NOCASE
    `).all().map((row) => row.name);
  }
  if (operation === 'revisions') {
    find(db, input.id);
    return db.prepare('SELECT version,created,value FROM revisions WHERE entry=? ORDER BY version DESC')
      .all(input.id).map((row) => ({ version: row.version, created: row.created, ...JSON.parse(row.value) }));
  }
  if (operation === 'image') {
    const row = db.prepare('SELECT * FROM images WHERE id=?').get(input.id);
    if (!row || !row.visible) fail('找不到图片。');
    find(db, row.entry, agent);
    return { mime: row.mime, data: fs.readFileSync(imagePath(directory, row.hash)).toString('base64') };
  }
  if (operation === 'pendingOcr') {
    return db.prepare(`
      SELECT i.id, i.hash FROM images i JOIN entries e ON e.id=i.entry
      WHERE i.status='pending' AND i.visible=1 AND e.deleted IS NULL ORDER BY i.rowid LIMIT 1
    `).get();
  }
  if (operation === 'create') return create(db, directory, input, agent);
  if (operation === 'edit') return edit(db, directory, input, agent);
  if (operation === 'restoreRevision') {
    const revision = db.prepare('SELECT value FROM revisions WHERE entry=? AND version=?').get(input.id, input.version);
    if (!revision) fail('找不到历史版本。');
    const { title, body, tags, imageIds } = JSON.parse(revision.value);
    return edit(db, directory, { ...input, title, body, tags, imageIds }, false);
  }
  if (operation === 'detach') {
    const row = find(db, input.id, agent);
    if (row.kind !== 'note' || row.deleted) fail('找不到可整理的笔记。');
    checkRevision(row, input.revision);
    find(db, input.source, agent);
    db.prepare('DELETE FROM sources WHERE note=? AND capture=?').run(row.id, input.source);
    db.prepare('UPDATE entries SET revision=revision+1,updated=? WHERE id=?').run(iso(), row.id);
    return details(db, find(db, row.id), agent);
  }
  if (operation === 'delete' || operation === 'restore') {
    const row = find(db, input.id, agent);
    checkRevision(row, input.revision);
    if (Boolean(row.deleted) === (operation === 'delete')) return { id: row.id };
    const now = iso();
    db.prepare('UPDATE entries SET deleted=?,updated=?,revision=revision+1 WHERE id=?')
      .run(operation === 'delete' ? now : null, now, row.id);
    return { id: row.id };
  }
  if (operation === 'purge') {
    db.exec('DELETE FROM search_fts WHERE entry IN (SELECT id FROM entries WHERE deleted IS NOT NULL)');
    const result = db.prepare('DELETE FROM entries WHERE deleted IS NOT NULL').run();
    return { count: result.changes };
  }
  if (operation === 'retryOcr' || operation === 'completeOcr') {
    const image = db.prepare('SELECT entry FROM images WHERE id=?').get(input.id);
    if (!image) return null;
    db.prepare('UPDATE images SET status=?,ocr=? WHERE id=?').run(
      operation === 'retryOcr' ? 'pending' : input.ok ? 'done' : 'failed', input.text ?? '', input.id
    );
    reindex(db, image.entry);
    return { id: image.entry };
  }
  fail('不支持的操作。');
}

function collectImages(db, directory) {
  transaction(db, () => {
    const referenced = new Set(db.prepare('SELECT DISTINCT hash FROM images').all().map((row) => row.hash));
    for (const filename of fs.readdirSync(path.join(directory, 'images'))) {
      if (!referenced.has(filename) && /^[a-f\d]{64}(?:\.[a-f\d-]{36})?$/.test(filename)) {
        fs.rmSync(path.join(directory, 'images', filename), { force: true });
      }
    }
  });
}

function run(configFile, operation, input = {}, { agent = false } = {}) {
  const { directory, scope } = readConfig(configFile);
  if (input.scope && input.scope !== scope) fail('活动知识库已切换，请重新查询。');
  const db = open(directory);
  try {
    if (!writeOperations.has(operation)) {
      db.exec('BEGIN');
      const value = operate(db, directory, operation, input, agent);
      db.exec('COMMIT');
      return { scope, value };
    }
    if (agent && operation !== 'create' && input.scope !== scope) fail('修改前需要从当前知识库重新读取条目。');
    const value = transaction(db, () => {
      if (readConfig(configFile).scope !== scope) fail('活动知识库已切换，请重新查询。');
      return operate(db, directory, operation, input, agent);
    });
    if (operation === 'purge') collectImages(db, directory);
    return { scope, value };
  } finally {
    db.close();
  }
}

function initialize(configFile, directory) {
  if (!fs.existsSync(configFile)) {
    open(directory, { create: true }).close();
    writeConfig(configFile, { directory, scope: id(), shortcut: 'Control+Shift+Alt+V', autoStart: false });
  }
  return readConfig(configFile);
}

function validateLibrary(directory) {
  const db = new DatabaseSync(path.join(directory, 'memory.sqlite'), { readOnly: true });
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== 1 ||
        db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('知识库文件无效。');
    if (!fs.statSync(path.join(directory, 'images')).isDirectory()) fail('知识库图片目录无效。');
    for (const { hash } of db.prepare('SELECT DISTINCT hash FROM images').all()) {
      if (!fs.statSync(imagePath(directory, hash)).isFile()) fail('备份中的图片文件不完整。');
    }
  } finally {
    db.close();
  }
}

function copyLibrary(source, target) {
  if (fs.existsSync(target)) fail('目标目录已存在，请选择新的位置。');
  const staging = target + '.' + id();
  const lock = open(source);
  try {
    fs.mkdirSync(path.join(staging, 'images'), { recursive: true });
    transaction(lock, () => {
      const reader = open(source);
      try {
        reader.prepare('VACUUM INTO ?').run(path.join(staging, 'memory.sqlite'));
        for (const { hash } of reader.prepare('SELECT DISTINCT hash FROM images').all()) {
          fs.copyFileSync(imagePath(source, hash), imagePath(staging, hash));
        }
      } finally {
        reader.close();
      }
    });
    validateLibrary(staging);
    fs.renameSync(staging, target);
  } finally {
    lock.close();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { initialize, readConfig, writeConfig, run, validateLibrary, copyLibrary, imagePath, maxImage };
