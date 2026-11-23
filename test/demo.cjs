const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/store.cjs');

async function seed(config) {
  if (run(config, 'list').value.items.length) return;
  const example = (kind, title, body, tags, extra = {}) =>
    run(config, 'create', { kind, title, body, tags, ...extra }).value;
  example('note', 'Node.js 版本切换', '## 解决步骤\n\n用 `fnm use` 切换到项目声明的版本。\n\n## 验证结果\n\n`node --version` 与 `.node-version` 一致。', ['开发环境']);
  example('capture', 'WSL 发行版导出与导入', 'wsl --export Ubuntu D:\\backups\\ubuntu.tar\n恢复前先确认目标目录有足够空间。', ['Windows']);
  example('capture', 'PowerShell 检查进程占用', 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10', ['PowerShell']);
  example('capture', '本地开发证书续期', '记录证书的到期时间，更新后重启本地开发服务。', ['开发环境']);
  example('capture', '终端 UTF-8 输出设置', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', ['PowerShell']);
  example('capture', '验证目录写入权限', 'Get-Acl .\\artifacts | Format-List Owner, Access\n改完权限后用普通账户执行验证。', ['排障']);
  example('capture', 'Windows 写入失败 · 0x80070005',
    '发布脚本在写入 artifacts 目录时提示「拒绝访问」。先保存原始报错，检查目录所有者和当前账户的权限。', ['Windows', '排障'],
    { images: [fs.readFileSync(path.join(__dirname, 'terminal.png'))] });
}
module.exports = { seed };
