const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const storage = require('../src/store.cjs');

async function smoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-desktop-'));
  const packaged = process.env.MEMORY_TEST_EXECUTABLE;
  const profile = packaged ? path.join(root, 'Memory') : root;
  const config = path.join(profile, 'settings.json');
  const executable = packaged || process.env.MEMORY_DEV_EXECUTABLE;
  const library = path.join(profile, 'Library');
  const { theme, ...legacySettings } = storage.initialize(config, library);
  assert.equal(theme, 'system');
  storage.writeConfig(config, legacySettings);
  const launch = () => _electron.launch({
    executablePath: executable,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...(packaged ? [] : [path.join(__dirname, '..')])],
    env: { ...process.env, MEMORY_DEV_DATA: root, XDG_CONFIG_HOME: root, APPDATA: root },
    timeout: 25000
  });
  let app = await launch();
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('heading', { name: '先保存一条记录' }).waitFor();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const appearance = page.getByRole('group', { name: '外观' });
    assert.equal(await appearance.getByRole('radio', { name: '深色' }).isChecked(), true);
    await appearance.getByText('浅色', { exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'light');
    await appearance.getByRole('radio', { name: '浅色' }).press('ArrowRight');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark');
    await appearance.getByText('跟随系统', { exact: true }).click();
    await page.waitForFunction(async () => (await window.memory.request('settings')).value.theme === 'system');
    const systemScheme = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    await page.waitForFunction((scheme) => getComputedStyle(document.documentElement).colorScheme === scheme, systemScheme);
    await appearance.getByText('浅色', { exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'light');
    await page.getByRole('button', { name: '关闭' }).click();
    await app.evaluate(({ clipboard, ClipboardItem }, image) => clipboard.write([new ClipboardItem({
      'text/plain': '目录权限检查',
      'image/png': new Blob([Uint8Array.from(atob(image), (byte) => byte.charCodeAt(0))], { type: 'image/png' })
    })]), fs.readFileSync(path.join(__dirname, 'mixed.png')).toString('base64'));
    await page.locator('body').press('Control+v');
    const captured = page.getByRole('heading', { name: '目录权限检查' });
    await captured.waitFor({ timeout: 10000 });
    await page.getByText('查看识别文字', { exact: true }).waitFor({ timeout: 20000 });
    await page.locator('.search-top').click();
    await page.getByRole('searchbox').fill('0x80070005');
    await page.locator('.search-results .entry').filter({ hasText: '目录权限检查' }).waitFor();
    await page.getByRole('searchbox').press('Enter');
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await captured.waitFor();
    await page.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('button', { name: '整理成笔记' }).click();
    await page.getByRole('button', { name: '手动整理' }).click();
    await page.getByLabel('标题').fill('发布问题的修复办法');
    await page.getByLabel('正文').fill('修复 0x80070005 后验证发布成功。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('heading', { name: '发布问题的修复办法' }).waitFor();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('正文').fill('更新后的验证步骤');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.doc-body').getByText('更新后的验证步骤').waitFor();
    await page.getByRole('button', { name: '历史版本' }).click();
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await page.locator('.doc-body').getByText('修复 0x80070005 后验证发布成功。').waitFor();
    await page.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('button', { name: '移到回收站' }).click();
    await page.getByRole('button', { name: '回收站', exact: true }).click();
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    assert.equal(storage.run(config, 'list', { view: 'notes' }).value.items.length, 1);
    await page.getByRole('button', { name: 'Agent 接入' }).click();
    for (const client of ['Codex', 'OpenCode', 'Claude Code']) {
      await page.getByRole('button', { name: client, exact: true }).click();
      assert.match(await page.locator('.snippet').textContent(), /MEMORY_CONFIG/);
    }
    await page.getByRole('button', { name: '关闭' }).click();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, root);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '创建备份' }).click();
    await page.getByText(/备份已保存至/).waitFor();
    const backup = fs.readdirSync(root).find((name) => name.startsWith('Memory-'));
    storage.validateLibrary(path.join(root, backup));
    await app.evaluate(({ dialog }, [backupPath, output]) => {
      const paths = [backupPath, output];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift()] });
    }, [path.join(root, backup), root]);
    await page.getByRole('button', { name: '恢复备份' }).click();
    await page.getByText('已打开知识库副本').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(710, 640));
    await page.getByRole('button', { name: '显示导航' }).click();
    await page.getByRole('button', { name: '知识库', exact: true }).click();
    await page.locator('.entry').filter({ hasText: '发布问题的修复办法' }).click();
    await page.getByRole('button', { name: '返回列表' }).click();
    await page.getByRole('heading', { name: '知识库', exact: true }).waitFor();
    assert.notEqual(storage.readConfig(config).directory, library);
    assert.deepEqual(errors, []);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await reopened.getByRole('radio', { name: '浅色' }).isChecked(), true);
    await reopened.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'light');
    console.log('Desktop flow passed: theme switching and persistence, clipboard, OCR, search, organization, edit, history, trash, MCP setup, backup and restore.');
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

smoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
