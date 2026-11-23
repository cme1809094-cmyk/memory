const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const storage = require('../src/store.cjs');
const { createRecognizer } = require('../src/ocr.cjs');
const { captureFiles } = require('../src/file-capture.cjs');

const screenshot = path.join(__dirname, 'terminal.png');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const configFile = path.join(directory, 'settings.json');
  const library = path.join(directory, 'Library');
  const config = storage.initialize(configFile, library);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory, configFile, library, config,
    run: (operation, input, options) => storage.run(configFile, operation, input, options).value
  };
}

test('clipboard capture, OCR index and source organization', (t) => {
  const { run } = fixture(t);
  const input = { kind: 'capture', body: '拒绝访问：请检查目录权限。', quick: true, images: [fs.readFileSync(screenshot)] };
  const capture = run('create', input);
  assert.deepEqual(run('create', input), { id: capture.id, duplicate: true });
  run('completeOcr', { id: capture.images[0].id, text: 'HRESULT: 0x80070005', ok: true });
  assert.equal(run('list', { query: '权限 0x80070005' }).items[0].id, capture.id);
  assert.equal(run('list', { query: 'HR' }).items[0].id, capture.id);
  assert.equal(run('list', { query: '"quoted"' }).items.length, 0);
  const note = run('create', { title: '发布失败', body: '修改输出目录权限后重新发布。', sources: [capture.id] });
  assert.equal(run('list', { view: 'inbox' }).items.length, 0);
  assert.equal(run('list', { view: 'filed' }).items[0].id, capture.id);
  assert.equal(run('get', { id: note.id }).sources[0].id, capture.id);
  run('detach', { id: note.id, revision: note.revision, source: capture.id });
  assert.equal(run('list', { view: 'inbox' }).items[0].id, capture.id);
});

test('history restores original text and attachment visibility; purge removes unused files', (t) => {
  const { run, library } = fixture(t);
  const note = run('create', { title: 'Before', body: 'Original', images: [fs.readFileSync(screenshot)] });
  const image = note.images[0].id;
  const edited = run('edit', { id: note.id, revision: note.revision, title: 'After', imageIds: [] });
  assert.throws(() => run('edit', { id: note.id, revision: note.revision, body: 'Stale write' }), /已更新/);
  assert.throws(() => run('image', { id: image }), /找不到图片/);
  const restored = run('restoreRevision', { id: note.id, revision: edited.revision, version: 1 });
  assert.equal(restored.title, 'Before');
  assert.equal(restored.images[0].id, image);
  run('delete', { id: note.id, revision: restored.revision });
  let trash = run('list', { view: 'trash' }).items[0];
  run('restore', { id: note.id, revision: trash.revision });
  assert.equal(run('list', { view: 'trash' }).items.length, 0);
  trash = run('get', { id: note.id });
  run('delete', { id: note.id, revision: trash.revision });
  assert.equal(run('purge').count, 1);
  assert.equal(fs.readdirSync(path.join(library, 'images')).length, 0);
});

test('local-only provenance stays private and backup restores to a distinct scope', (t) => {
  const { run, directory, config, configFile, library } = fixture(t);
  const capture = run('create', { kind: 'capture', body: 'restricted 0x80070005', images: [fs.readFileSync(screenshot)] });
  const note = run('create', { title: 'restricted resolution', sources: [capture.id] });
  run('detach', { id: note.id, revision: note.revision, source: capture.id });
  run('edit', { id: capture.id, revision: capture.revision, localOnly: true });
  const agent = { agent: true };
  assert.equal(run('list', { query: 'restricted' }, agent).items.length, 0);
  assert.throws(() => run('get', { id: note.id }, agent), /找不到/);
  assert.throws(() => run('image', { id: capture.images[0].id }, agent), /找不到/);
  const backup = path.join(directory, 'Backup');
  storage.copyLibrary(library, backup);
  storage.validateLibrary(backup);
  const copy = path.join(directory, 'Restored');
  storage.copyLibrary(backup, copy);
  storage.writeConfig(configFile, { ...config, directory: copy, scope: 'restored' });
  assert.throws(() => run('get', { id: note.id, scope: config.scope }), /已切换/);
  assert.equal(run('image', { id: capture.images[0].id }).mime, 'image/png');
  run('create', { title: 'Restored only' });
  storage.writeConfig(configFile, config);
  assert.equal(run('list', { query: 'Restored only' }).items.length, 0);
});

test('file capture migrates old libraries and preserves originals through backup and purge', async (t) => {
  const { run, directory, config, configFile, library } = fixture(t);
  const oldEntry = run('create', { title: 'Legacy entry' });
  const database = new DatabaseSync(path.join(library, 'memory.sqlite'));
  database.exec('DROP TABLE files; PRAGMA user_version=1;');
  database.close();
  fs.rmdirSync(path.join(library, 'files'));
  storage.validateLibrary(library);
  const oldBackup = path.join(directory, 'LegacyBackup');
  storage.copyLibrary(library, oldBackup);
  storage.validateLibrary(oldBackup);

  const binary = path.join(directory, '原始附件.bin');
  const binaryContents = Buffer.from('未索引的二进制内容');
  fs.writeFileSync(binary, binaryContents);
  const word = path.join(__dirname, 'file-summary.docx');
  await assert.rejects(captureFiles(configFile, config.scope, [binary, library]), /只能保存普通文件/);
  const { value: capture } = await captureFiles(configFile, config.scope, [binary, word]);
  assert.deepEqual(run('get', { id: oldEntry.id }).files, []);
  assert.equal(capture.files.length, 2);
  const document = capture.files.find((file) => file.name === 'file-summary.docx');
  assert.equal(document.summary, '简报：试点协调 与 会议议程 下周提交复盘 & 审核。');
  const original = capture.files.find((file) => file.name === '原始附件.bin');
  assert.equal(original.summary, '');
  assert.equal(run('list', { query: '试点协调' }).items[0].id, capture.id);
  assert.equal(run('list', { query: '远端标记不会摘要' }).items.length, 0);
  assert.equal(run('list', { query: '未索引的二进制内容' }).items.length, 0);
  const { value: duplicate } = await captureFiles(configFile, config.scope, [word, binary]);
  assert.deepEqual(duplicate, { id: capture.id, duplicate: true });

  fs.rmSync(binary);
  const backup = path.join(directory, 'FilesBackup');
  storage.copyLibrary(library, backup);
  assert.deepEqual(fs.readFileSync(storage.filePath(backup, original.id)), binaryContents);
  run('delete', { id: capture.id, revision: capture.revision });
  assert.equal(run('purge').count, 1);
  assert.deepEqual(fs.readdirSync(path.join(library, 'files')), []);
});

test('MCP stdio exposes CRUD and original image while respecting revision and scope', async (t) => {
  const { run, configFile, config, directory } = fixture(t);
  const executable = process.env.MEMORY_TEST_EXECUTABLE || process.execPath;
  const script = process.env.MEMORY_TEST_SCRIPT || path.resolve(__dirname, '../src/mcp.cjs');
  const transport = new StdioClientTransport({
    command: executable, args: [script],
    env: { ...process.env, MEMORY_CONFIG: configFile, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'Memory acceptance test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 7);
  const call = (name, args = {}) => client.callTool({ name: 'memory_' + name, arguments: args });
  const capture = run('create', { kind: 'capture', body: 'clipboard source', images: [fs.readFileSync(screenshot)] });
  const result = (await call('search', { view: 'inbox', query: 'clipboard source' })).structuredContent;
  assert.equal(result.items[0].id, capture.id);
  const entry = (await call('get', { id: capture.id, scope: result.scope })).structuredContent;
  assert.equal((await call('image', { id: entry.images[0].id, scope: entry.scope })).content[0].mimeType, 'image/png');
  const sourceFile = path.join(directory, 'planning.txt');
  fs.writeFileSync(sourceFile, 'Summary sentence\n' + 'a'.repeat(19000) + '\nUnindexed trailing contents');
  const { value: fileCapture } = await captureFiles(configFile, config.scope, [sourceFile]);
  const fileEntry = (await call('get', { id: fileCapture.id, scope: result.scope })).structuredContent;
  assert.deepEqual(Object.keys(fileEntry.files[0]).sort(), ['id', 'name', 'size', 'summary']);
  assert.match(fileEntry.files[0].summary, /^Summary sentence/);
  assert.ok(fileEntry.files[0].summary.length <= 260);
  assert.equal((await call('search', { query: 'Unindexed trailing contents' })).structuredContent.items.length, 0);
  assert.equal((await call('image', { id: fileEntry.files[0].id, scope: result.scope })).isError, true);
  const note = (await call('create', {
    title: '0x80070005 resolution', body: 'Check folder permissions', sources: [capture.id], scope: entry.scope
  })).structuredContent;
  assert.equal(run('list', { view: 'inbox' }).items.length, 1);
  const updated = (await call('edit', { id: note.id, scope: note.scope, revision: note.revision, body: 'Verified fix' })).structuredContent;
  assert.equal(updated.body, 'Verified fix');
  assert.equal((await call('edit', { id: note.id, scope: note.scope, revision: note.revision, body: 'Old write' })).isError, true);
  assert.equal((await call('delete', { id: note.id, scope: note.scope, revision: updated.revision })).isError, undefined);
  assert.equal((await call('search', { query: '0x80070005' })).structuredContent.items.length, 0);
  assert.equal(run('list', { view: 'trash' }).items[0].id, note.id);
});

test('offline OCR reads mixed Simplified Chinese and English screenshot', async (t) => {
  const { directory } = fixture(t);
  const recognize = createRecognizer(path.join(directory, 'ocr'));
  t.after(() => recognize.close());
  const text = await recognize(path.join(__dirname, 'mixed.png'));
  assert.match(text, /0x80070005/);
  assert.match(text.replace(/\s/g, ''), /拒绝访问/);
});
