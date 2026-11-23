import { icon } from './icons.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const workspace = $('#workspace');
const sidebar = $('#sidebar');
const mainbar = $('#mainbar');
const columns = $('#columns');
const listing = $('#listing');
const detail = $('#detail');
const modal = $('#modal');
const status = $('#status');
const views = {
  inbox: { name: '收件箱', icon: 'inbox', caption: '刚保存的片段，等你整理。', empty: '收件箱是空的' },
  notes: { name: '知识库', icon: 'library-big', caption: '整理过的经验和笔记。', empty: '还没有笔记' },
  filed: { name: '已整理', icon: 'archive', caption: '已经关联到笔记的原始素材。', empty: '还没有已整理的素材' },
  all: { name: '全部记录', icon: 'layers', caption: '浏览素材和笔记。', empty: '还没有记录' },
  trash: { name: '回收站', icon: 'trash-2', caption: '你可以恢复误删的内容。', empty: '回收站是空的' }
};
const state = {
  view: 'inbox', tag: '', scope: '', selected: '', entry: null, items: [], tags: [],
  more: false, pages: 1, multi: false, checked: new Set(), settings: null, showDetail: false
};
const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateLong = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const timeOnly = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortDate = (value) => new Date(value).toDateString() === new Date().toDateString()
  ? timeOnly.format(new Date(value)) : date.format(new Date(value));
const e = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
const nameOf = (entry) => entry.title || (entry.body || entry.excerpt || '').trim().split('\n')[0].slice(0, 65)
  || (entry.imageCount || entry.images?.length ? '剪贴板截图' : '未命名记录');
const typeOf = (entry) => entry.kind === 'note' ? 'file-text'
  : entry.imageCount || entry.images?.length ? 'image' : 'clipboard';
const action = (name, text, glyph, style = '', data = '') =>
  `<button type="button" class="button ${style}" data-action="${name}" ${data}>${glyph ? icon(glyph) : ''}<span>${e(text)}</span></button>`;
const iconAction = (name, text, glyph, style = '', data = '') =>
  `<button type="button" class="icon-button ${style}" data-action="${name}" title="${e(text)}" aria-label="${e(text)}" ${data}>${icon(glyph)}</button>`;

let toastTimer;
let listRequest = 0;
let detailRequest = 0;
let renderVersion = 0;
let loaded = false;
let dialogOrigin;
let dialogMode;
let editor;
let agentTab = 'codex';
const imageCache = new Map();

async function request(operation, input = {}) {
  const response = await window.memory.request(operation, input);
  if (response.error) throw new Error(response.error);
  return response;
}

function say(message, error = false) {
  clearTimeout(toastTimer);
  $('.modal-status', modal)?.remove();
  status.className = 'toast';
  status.textContent = '';
  const alert = modal.open ? Object.assign(document.createElement('div'), { className: 'modal-status', role: 'status' }) : status;
  if (modal.open) modal.append(alert);
  alert.innerHTML = icon(error ? 'circle-alert' : 'circle-check') + '<span>' + e(message) + '</span>';
  alert.classList.add('visible');
  if (error) alert.classList.add('error');
  toastTimer = setTimeout(() => {
    if (alert === status) { status.className = 'toast'; status.textContent = ''; }
    else alert.remove();
  }, error ? 4800 : 2300);
}

function failure(error) {
  say(error.message, true);
}

function shortcutLabel() {
  return (state.settings?.shortcut || 'Control+Shift+Alt+V').replace('Control', 'Ctrl').replace('Super', 'Win');
}

function navButton(key, label, glyph, tag = false) {
  const selected = tag ? state.tag === key : !state.tag && state.view === key;
  return `<button class="nav-button" data-action="${tag ? 'tag' : 'nav'}" data-key="${e(key)}"
    ${selected ? 'aria-current="page"' : ''}>${glyph ? icon(glyph) : '<i class="tag-dot" aria-hidden="true"></i>'}
    <span class="nav-text">${e(label)}</span></button>`;
}

function renderSidebar() {
  const offset = $('.tags-nav', sidebar)?.scrollTop ?? 0;
  sidebar.innerHTML = `
    <div class="brand"><img src="app.png" alt=""><div><strong>Memory</strong><small>个人知识库</small></div></div>
    <div class="side-actions">${action('new', '新建笔记', 'plus', 'primary')}</div>
    <p class="side-label">工作区</p>
    <nav class="nav" aria-label="工作区">${Object.entries(views).map(([key, view]) => navButton(key, view.name, view.icon)).join('')}</nav>
    ${state.tags.length ? `<p class="side-label">标签</p><nav class="nav tags-nav" aria-label="标签">${state.tags.map((tag) => navButton(tag, tag, '', true)).join('')}</nav>` : ''}
    <div class="sidebar-bottom">
      ${navButtonForAction('agent', 'Agent 接入', 'plug-zap')}
      ${navButtonForAction('settings', '设置', 'settings-2')}
      <div class="connection"><i class="dot"></i><span>本地知识库</span></div>
    </div>`;
  if ($('.tags-nav', sidebar)) $('.tags-nav', sidebar).scrollTop = offset;
}

function navButtonForAction(key, name, glyph) {
  return `<button type="button" class="nav-button" data-action="${key}">${icon(glyph)}<span>${name}</span></button>`;
}

function renderMainbar() {
  const view = views[state.view];
  mainbar.innerHTML = `<div class="breadcrumb">
    ${iconAction('side', '显示导航', 'panel-left', 'sidebar-toggle')}
    <span class="crumb-muted">工作区</span>${icon('chevron-right', 'divider')}
    ${icon(state.tag ? 'hash' : view.icon)}<span class="crumb-current">${e(state.tag || view.name)}</span>
    </div><div class="main-actions">
    <button class="button outline search-top" data-action="search">${icon('search')}<span>搜索</span><kbd>Ctrl K</kbd></button>
    ${action('capture', '保存剪贴板', 'clipboard-paste', 'outline', `title="${e(shortcutLabel())}"`)}
    </div>`;
}

function entryRow(item, search = false) {
  const selected = !search && item.id === state.selected;
  const tags = item.tags.slice(0, 2).join(' · ');
  return `<button type="button" class="entry ${selected ? 'active' : ''}" data-action="${search ? 'result' : 'entry'}"
      data-id="${e(item.id)}" ${!search ? `aria-pressed="${state.multi ? state.checked.has(item.id) : selected}"` : ''}>
    ${state.multi && !search ? `<span class="entry-check">${icon(state.checked.has(item.id) ? 'check' : 'square-pen')}</span>` : ''}
    <span class="entry-type">${icon(typeOf(item))}</span>
    <span class="entry-content">
      <span class="entry-top"><span class="entry-title">${e(nameOf(item))}</span><time datetime="${e(item.updated)}">${e(shortDate(item.updated))}</time></span>
      <span class="entry-excerpt">${e(item.excerpt || (item.imageCount ? '图片附件' : ''))}</span>
      <span class="entry-labels">
        ${item.imageCount ? `<span class="label">${icon('image')}${item.imageCount} 张图片</span>` : ''}
        ${item.localOnly ? `<span class="label">${icon('lock-keyhole')} 仅本机</span>` : ''}
        ${tags ? `<span class="label">${icon('hash')}${e(tags)}</span>` : ''}
      </span>
    </span></button>`;
}

function renderList() {
  const before = $('.list-scroll', listing)?.scrollTop ?? 0;
  const focus = document.activeElement;
  const focusId = listing.contains(focus) ? focus.dataset.id : '';
  const view = views[state.view];
  const selectable = state.items.some((item) => item.kind === 'capture') && state.view !== 'trash';
  const count = state.items.length + (state.more ? '+' : '');
  listing.innerHTML = `
    <div class="list-head"><div class="list-headline"><h1>${e(state.tag || view.name)}</h1>
      ${state.view === 'trash' && state.items.length ? iconAction('purge', '清空回收站', 'trash-2') : ''}
    </div><p>${e(state.tag ? '带有此标签的记录。' : view.caption)}</p></div>
    <div class="list-tools"><div class="group-label">${icon('arrow-down-wide-narrow')} 最近更新 <span>${count}</span></div>
      ${selectable ? iconAction('multi', state.multi ? '退出多选' : '选择素材', 'list-checks', state.multi ? 'pressed' : '', `aria-pressed="${state.multi}"`) : ''}
    </div>
    <div class="list-scroll">${state.items.length ? state.items.map((item) => entryRow(item)).join('') :
      '<p class="list-empty">' + (loaded ? e(state.tag ? '没有带此标签的条目' : view.empty) : '正在打开知识库…') + '</p>'}
      ${state.more ? action('more', '加载更多', 'chevron-down') : ''}
    </div>
    <div class="list-footer">
      <span>${state.multi ? '已选 ' + state.checked.size + ' 条素材' : '共 ' + count + ' 条记录'}</span>
      ${state.multi ? action('organize', '整理', 'layers', 'outline', state.checked.size ? '' : 'disabled')
        : state.view === 'inbox' ? '<kbd>' + e(shortcutLabel()) + '</kbd>' : ''}
    </div>`;
  $('.list-scroll', listing).scrollTop = before;
  if (focusId) $('.entry[data-id="' + CSS.escape(focusId) + '"]', listing)?.focus({ preventScroll: true });
}

function displayBody(value) {
  if (!value.trim()) return '';
  const inline = (line) => e(line).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const blocks = value.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm);
  const content = blocks.map((block, index) => {
    if (index % 2) return '<pre><code>' + e(block.trimEnd()) + '</code></pre>';
    return block.split(/\n\n+/).flatMap((paragraph) => {
      const sections = paragraph.split(/^(#{1,4} .+)$/m).filter((part) => part.trim());
      return sections.map((part) => /^#{1,4} /.test(part)
        ? '<h3>' + inline(part.replace(/^#+ /, '')) + '</h3>'
        : '<p>' + inline(part.trim()) + '</p>');
    }).join('');
  }).join('');
  return '<div class="doc-body">' + content + '</div>';
}

function attachment(image, index) {
  const key = 'data-id="' + e(image.id) + '"';
  const info = image.status === 'done' ? (image.ocr
    ? '<details class="ocr-info"><summary>查看识别文字</summary><p>' + e(image.ocr) + '</p></details>'
    : '<div class="ocr-info">未识别到文字</div>') : image.status === 'pending'
    ? '<div class="ocr-info">正在识别图片文字…</div>'
    : '<div class="ocr-info">识别失败 ' + action('retry', '重试', 'rotate-ccw', '', key) + '</div>';
  return `<figure class="attachment"><figcaption class="attachment-toolbar"><span>${icon('image')} 图片 ${index + 1}</span>
    ${iconAction('preview', '查看原图', 'expand', '', key)}</figcaption>
    <button class="image-preview" data-action="preview" ${key} aria-label="查看图片 ${index + 1}">
      <img data-image="${e(image.id)}" alt="笔记附件 ${index + 1}"></button>${info}</figure>`;
}

async function loadImage(id) {
  const scope = state.scope;
  if (!imageCache.has(id)) {
    const response = await request('image', { id, scope });
    if (scope !== state.scope) throw new Error('知识库已切换。');
    const { mime, data } = response.value;
    if (imageCache.size >= 8) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(id, 'data:' + mime + ';base64,' + data);
  }
  return imageCache.get(id);
}

function renderDetail() {
  const currentRender = ++renderVersion;
  const entry = state.entry;
  const oldScroll = $('.detail-scroll', detail)?.scrollTop ?? 0;
  columns.classList.toggle('show-detail', Boolean(state.showDetail && entry));
  if (!entry) {
    const empty = !state.items.length && state.view !== 'trash';
    detail.innerHTML = `<div class="empty-detail"><div class="empty-icon">${icon(empty ? 'clipboard-paste' : views[state.view].icon)}</div>
      <h2>${empty ? '先保存一条记录' : '选择一条记录'}</h2>
      <p>${empty ? '复制文字或截图后，按快捷键立即保存。' : '选择左侧条目即可查看详情。'}</p>
      ${empty ? action('capture', '保存剪贴板', 'clipboard-paste', 'outline') : ''}</div>`;
    return;
  }
  const section = entry.kind === 'note' ? '笔记' : '收件素材';
  const dateText = dateLong.format(new Date(entry.created));
  detail.innerHTML = `
    <header class="detail-head"><div class="detail-kind">
      ${iconAction('back', '返回列表', 'chevron-left', 'back-control')}${icon(typeOf(entry))}<span>${section}</span>
    </div><div class="detail-tools">${entry.deleted
      ? action('restore', '恢复', 'rotate-ccw', 'outline')
      : action('edit', '编辑', 'pencil', 'outline') + iconAction('history', '历史版本', 'history')
        + iconAction('entry-menu', '更多操作', 'ellipsis')}</div></header>
    <div class="detail-scroll" data-entry="${e(entry.id)}"><div class="document">
      ${state.view === 'inbox' && entry.kind === 'capture' ? `<span class="doc-label">${icon('inbox')}待整理</span>` : ''}
      <h2>${e(nameOf(entry))}</h2>
      <div class="meta"><span>${icon('clock-3')}${e(dateText)}</span>
        ${entry.localOnly ? '<span>' + icon('lock-keyhole') + '仅本机</span>' : ''}
        ${entry.tags.map((tag) => `<button class="tag" data-action="tag" data-key="${e(tag)}">${icon('hash')}${e(tag)}</button>`).join('')}
        ${entry.deleted ? '<span>' + icon('trash-2') + '已删除</span>' : ''}
      </div>
      ${displayBody(entry.body)}
      ${entry.images.length ? '<section class="detail-section"><h3 class="section-heading">' + icon('paperclip') + ' 附件</h3>' + entry.images.map(attachment).join('') + '</section>' : ''}
      ${entry.sources.length ? `<section class="detail-section"><h3 class="section-heading">${icon('link')} 来源素材</h3>
        ${entry.sources.map((source) => `<div class="source-row">${action('source', nameOf(source) + (source.deleted ? '（已删除）' : ''), 'clipboard', '', 'data-id="' + e(source.id) + '"')}
          ${!entry.deleted && !source.deleted ? iconAction('detach', '退回素材', 'unlink', '', 'data-id="' + e(source.id) + '"') : ''}</div>`).join('')}
      </section>` : ''}
    </div></div>`;
  $('.detail-scroll', detail).scrollTop = oldScroll;
  for (const image of detail.querySelectorAll('[data-image]')) {
    loadImage(image.dataset.image).then((source) => {
      if (currentRender === renderVersion) image.src = source;
    }).catch(() => {
      if (currentRender === renderVersion) image.alt = '图片无法读取';
    });
  }
}

async function selectEntry(id, { open = true, preserveScroll = false } = {}) {
  const token = ++detailRequest;
  const previous = state.entry?.id;
  const result = await request('get', { id, scope: state.scope });
  if (token !== detailRequest) return;
  state.selected = result.value.id;
  if (open) state.showDetail = true;
  if (JSON.stringify(state.entry) !== JSON.stringify(result.value) || open) {
    state.entry = result.value;
    if (!preserveScroll && previous !== id && $('.detail-scroll', detail)) $('.detail-scroll', detail).scrollTop = 0;
    renderDetail();
    if (open) renderList();
  }
}

async function refresh({ redraw = false, clear = false } = {}) {
  const token = ++listRequest;
  if (clear) {
    detailRequest++;
    state.selected = '';
    state.entry = null;
    state.showDetail = false;
  }
  const { view, tag, pages } = state;
  const [pageResults, tags] = await Promise.all([
    Promise.all(Array.from({ length: pages }, (_, index) =>
      request('list', { view, tag, limit: 45, offset: index * 45 }))),
    request('tags')
  ]);
  const result = {
    scope: pageResults[0].scope,
    value: { items: [...new Map(pageResults.flatMap((page) => page.value.items).map((item) => [item.id, item])).values()],
      more: pageResults.at(-1).value.more }
  };
  if (token !== listRequest) return;
  if (result.scope !== state.scope) {
    if (state.scope) {
      state.selected = '';
      state.entry = null;
      state.showDetail = false;
      state.checked.clear();
      imageCache.clear();
    }
    state.scope = result.scope;
    redraw = true;
  }
  const changed = JSON.stringify(state.items) !== JSON.stringify(result.value.items) || state.more !== result.value.more;
  const tagsChanged = JSON.stringify(state.tags) !== JSON.stringify(tags.value);
  state.items = result.value.items;
  state.more = result.value.more;
  state.tags = tags.value;
  loaded = true;
  if (redraw || tagsChanged) renderSidebar();
  if (redraw) renderMainbar();
  if (redraw || changed) renderList();
  if (state.selected) {
    try { await selectEntry(state.selected, { open: false, preserveScroll: true }); }
    catch (error) {
      if (token !== listRequest) return;
      if (error.message !== '找不到可访问的条目。') throw error;
      state.selected = '';
      state.entry = null;
      renderDetail();
    }
  } else if (state.items.length && (redraw || changed)) {
    await selectEntry(state.items[0].id, { open: false });
    renderList();
  } else if (redraw || changed) renderDetail();
}

async function navigate(view, tag = '') {
  workspace.classList.remove('nav-open');
  Object.assign(state, { view, tag, multi: false, pages: 1, items: [], more: false });
  state.checked.clear();
  await refresh({ redraw: true, clear: true });
  $('.list-scroll', listing).scrollTop = 0;
}

function closeDialog() {
  if (modal.open) modal.close();
}

function openDialog(mode, title, body, footer = '', options = {}) {
  if (!modal.open) dialogOrigin = document.activeElement;
  dialogMode = mode;
  modal.className = (options.wide ? 'wide ' : '') + (mode === 'search' ? 'search-modal' : '');
  modal.innerHTML = options.bare ? `<h2 id="dialog-title" hidden>${e(title)}</h2>${body}` :
    `<div class="modal-head"><h2 id="dialog-title">${e(title)}</h2>${iconAction('close', '关闭', 'x')}</div>
    <div class="modal-body">${body}</div>${footer ? '<div class="modal-foot">' + footer + '</div>' : ''}`;
  if (!modal.open) modal.showModal();
  (options.focus ? $(options.focus, modal) : $('.modal-head button', modal))?.focus();
}

modal.addEventListener('close', () => {
  dialogMode = '';
  editor = null;
  if (dialogOrigin?.isConnected) dialogOrigin.focus();
  else $('.search-top', mainbar)?.focus();
});

function modalError(error) {
  const target = $('.form-error', modal);
  if (!target) return failure(error);
  target.textContent = error.message;
  target.hidden = false;
}

function showEditor(entry = null, sources = []) {
  editor = { entry, scope: state.scope, images: [], existing: entry?.images.map((image) => image.id) || [], sources };
  const heading = entry ? '编辑条目' : sources.length ? '整理成笔记' : '新建笔记';
  openDialog('editor', heading, `
    <form id="editor-form" class="form">
      <div class="field"><label for="edit-title">标题 <small>可选</small></label>
        <input id="edit-title" name="title" maxlength="500" placeholder="为这条记录命名" value="${e(entry?.title)}"></div>
      <div class="field"><label for="edit-body">正文</label>
        <textarea id="edit-body" name="body" maxlength="2000000" placeholder="写下内容，或粘贴文本和截图…">${e(entry?.body)}</textarea></div>
      <div class="field"><label for="edit-tags">标签 <small>用逗号分隔</small></label>
        <input id="edit-tags" name="tags" maxlength="1000" placeholder="例如：Windows, 排障" value="${e(entry?.tags.join(', '))}"></div>
      <label class="check-label"><input name="private" type="checkbox" ${entry?.localOnly ? 'checked' : ''}>仅本机可见</label>
      ${sources.length ? '<p>关联 ' + sources.length + ' 条原始素材</p>' : ''}
      <div class="list-actions">
        ${action('attach', '添加图片', 'paperclip', 'outline')}
        ${!entry || entry.kind === 'note' ? action('template', '排障模板', 'file-text') : ''}
        <input id="file-input" class="hidden-input" type="file" accept="image/png,image/jpeg" multiple>
      </div>
      <div class="file-list" hidden></div>
      <p class="form-error" role="alert" hidden></p>
    </form>`,
    action('close', '取消', '') + '<button class="button primary" type="submit" form="editor-form">保存</button>',
    { wide: true, focus: '#edit-title' });
  renderFiles();
  $('#file-input', modal).addEventListener('change', (event) => {
    void attachFiles([...event.target.files]);
    event.target.value = '';
  });
}

async function attachFiles(files) {
  const editing = editor;
  if (!editing) return;
  editing.reads = (editing.reads || 0) + 1;
  try {
    for (const file of files) {
      if (editor !== editing || !editing) return;
      if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('请选择 PNG 或 JPEG 图片。');
      if (file.size > 25 * 1024 * 1024) throw new Error('每张图片最多 25 MB。');
      if (editing.images.length >= 5) throw new Error('一次最多添加五张图片。');
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      editing.images.push({ name: file.name || '剪贴板截图', data });
    }
  } catch (error) {
    modalError(error);
  } finally {
    editing.reads--;
    if (editor === editing) renderFiles();
  }
}

function renderFiles() {
  const list = $('.file-list', modal);
  list.hidden = !editor.images.length && !editor.existing.length;
  const existing = editor.existing.map((id, index) => `<span class="file-chip">${icon('image')}图片 ${index + 1}
    ${iconAction('remove-existing', '移除图片', 'x', '', 'data-id="' + e(id) + '"')}</span>`).join('');
  list.innerHTML = existing + editor.images.map((file, index) => `<span class="file-chip">${icon('image')}${e(file.name)}
    ${iconAction('remove-file', '移除图片', 'x', '', 'data-index="' + index + '"')}</span>`).join('');
}

function formBusy(button) {
  if (button.disabled) return false;
  button.disabled = true;
  return true;
}

async function saveEditor(form) {
  const button = $('button[type="submit"]', modal);
  if (editor?.reads) return modalError(new Error('正在读取图片，请稍后保存。'));
  if (!formBusy(button)) return;
  try {
    const fields = new FormData(form);
    const { entry, scope, images, existing, sources } = editor;
    const result = await request(entry ? 'edit' : 'create', {
      ...(entry ? { id: entry.id, revision: entry.revision, imageIds: existing } : { kind: 'note', sources }), scope,
      title: fields.get('title'), body: fields.get('body'), localOnly: fields.has('private'),
      tags: fields.get('tags').split(/[,，]/).map((tag) => tag.trim().slice(0, 100)),
      images: images.map((image) => image.data)
    });
    closeDialog();
    if (!entry) await navigate('notes');
    await selectEntry(result.value.id);
    await refresh();
    say(entry ? '已保存修改' : '笔记已保存');
  } catch (error) {
    modalError(error);
  } finally {
    button.disabled = false;
  }
}

async function showSearch() {
  openDialog('search', '全库搜索', `<div class="search-line">${icon('search')}
      <input type="search" id="search-input" aria-label="搜索知识库" placeholder="搜索标题、正文、标签和图片文字" autocomplete="off">
      <kbd>Esc</kbd></div><div class="search-results" id="search-results"></div>
      <div class="search-hint">↑ ↓ 选择 · Enter 打开</div>`, '', { wide: true, bare: true, focus: '#search-input' });
  const input = $('#search-input');
  const results = $('#search-results');
  let token = 0;
  let timer;
  const update = async () => {
    const current = ++token;
    try {
      const result = await request('list', { view: 'all', query: input.value, limit: 15 });
      if (current !== token || !results.isConnected) return;
      results.innerHTML = result.value.items.map((item) => entryRow(item, true)).join('') ||
        '<p class="list-empty">没有找到匹配的条目。</p>';
    } catch (error) {
      results.textContent = error.message;
    }
  };
  input.addEventListener('input', () => {
    token++;
    clearTimeout(timer);
    timer = setTimeout(() => void update(), 95);
  });
  const keys = new AbortController();
  modal.addEventListener('close', () => keys.abort(), { once: true });
  modal.addEventListener('keydown', (event) => {
    if (!input.isConnected) return;
    const entries = [...results.querySelectorAll('.entry')];
    const index = entries.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) input.focus();
      else entries[Math.min(next, entries.length - 1)]?.focus();
    }
    if (event.key === 'Enter' && document.activeElement === input) {
      event.preventDefault();
      entries[0]?.click();
    }
  }, { signal: keys.signal });
  await update();
}

function scopeData(entry) {
  return { id: entry.id, revision: entry.revision, scope: state.scope };
}

function showItemMenu(entry) {
  const row = (key, text, glyph, style = '') => action(key, text, glyph, style);
  openDialog('item-menu', '条目操作', '<div class="form">' +
    (entry.kind === 'capture' ? row('organize-one', '整理成笔记', 'layers', 'outline') : '') +
    row('copy-id', '复制条目 ID', 'copy', 'outline') + row('delete', '移到回收站', 'trash-2', 'danger outline') + '</div>');
}

function showOrganize(ids) {
  editor = null;
  openDialog('organize', '整理素材',
    '<p>将选中的 ' + ids.length + ' 条素材合成一条笔记。你可自己填写，或复制整理指令到正在使用的 Agent。</p>',
    action('manual', '手动整理', 'pencil', 'outline') + action('agent-organize', '复制 Agent 指令', 'copy', 'primary'));
  modal.dataset.sources = JSON.stringify(ids);
}

async function organizeWithAgent(ids) {
  const entries = await Promise.all(ids.map((id) => request('get', { id, scope: state.scope })));
  if (entries.some((entry) => entry.value.localOnly)) throw new Error('选中素材含有仅本机记录，请手动整理。');
  const instruction = [
    '请用 Memory MCP 将以下收件箱素材整理为一条可复用的知识笔记。',
    '先逐条读取素材。根据内容决定是否使用「现象 / 原因 / 解决步骤 / 验证结果」结构，不确定的原因不要补写。',
    '创建笔记时将这些 ID 都传入 sources，并传入读取时返回的 scope。',
    ...ids
  ].join('\n');
  await request('copy', { text: instruction });
  closeDialog();
  say('整理指令已复制');
}

async function showHistory(entry) {
  const { value } = await request('revisions', { id: entry.id, scope: state.scope });
  openDialog('history', '历史版本', `
    <p>当前版本 v${entry.revision}。恢复会创建新的版本。</p>
    ${value.length ? value.map((version) => `<div class="version"><div><strong>v${version.version} · ${e(dateLong.format(new Date(version.created)))}</strong>
      <p>${e(nameOf(version))}</p><details class="ocr-info"><summary>查看正文</summary><p>${e(version.body || '无正文')}</p></details></div>
      ${action('restore-version', '恢复', 'rotate-ccw', 'outline', 'data-version="' + version.version + '"')}</div>`).join('') : '<div class="list-empty">没有历史版本。</div>'}`);
  modal.dataset.snapshot = JSON.stringify(scopeData(entry));
}

async function showSettings() {
  state.settings = (await request('settings')).value;
  const settings = state.settings;
  openDialog('settings', '设置', `
    <form id="settings-form" class="form">
      <div class="field"><label for="shortcut">全局保存快捷键</label>
        <input id="shortcut" name="shortcut" value="${e(settings.shortcut)}" autocapitalize="off" spellcheck="false">
        <small>使用 Control、Shift、Alt、Super 和一个字母、数字或功能键。</small>
      </div>
      <label class="check-label"><input name="autostart" type="checkbox" ${settings.autoStart ? 'checked' : ''} ${settings.autoStartSupported ? '' : 'disabled'}>
        登录 Windows 后在托盘启动</label>
      <p class="form-error" role="alert" ${settings.shortcutError ? '' : 'hidden'}>${e(settings.shortcutError)}</p>
      <div>${'<button class="button primary" type="submit">保存设置</button>'}</div>
    </form>
    <div class="setting-group"><h3>知识库目录</h3>
      <div class="setting-line"><div><strong>当前目录</strong><small>${e(settings.directory)}</small></div>${iconAction('open-directory', '在文件管理器中打开', 'folder-open', 'outline')}</div>
      <div class="list-actions">${action('backup', '创建备份', 'download', 'outline')}
        ${action('restoreLibrary', '恢复备份', 'rotate-ccw', 'outline')}${action('switchLibrary', '切换目录', 'folder', 'outline')}</div>
      <p>恢复会打开另一份副本。</p>
    </div>`, '', { wide: true });
}

const agentLabels = { codex: 'Codex', opencode: 'OpenCode', claude: 'Claude Code' };
const agentPaths = { codex: '%USERPROFILE%\\.codex\\config.toml', opencode: '%USERPROFILE%\\.config\\opencode\\opencode.json',
  claude: 'PowerShell · claude mcp add' };

async function showAgent(tab = agentTab) {
  if (!state.settings) state.settings = (await request('settings')).value;
  agentTab = tab;
  const snippet = state.settings.snippets[tab];
  openDialog('agent', 'Agent 接入', `
    <div class="form"><p>Agent 客户端按需启动本地 MCP，可在 Memory 窗口关闭时访问知识库。</p>
      <div class="tablist" aria-label="选择客户端">${Object.entries(agentLabels).map(([key, label]) =>
        action('agent-tab', label, '', 'outline', `data-key="${key}" aria-pressed="${key === tab}"`)).join('')}</div>
      <div class="field"><label>${e(agentPaths[tab])}</label>
        <small>${tab === 'claude' ? '在 PowerShell 执行，然后运行 claude mcp list 检查连接。'
          : '将配置合并到现有文件，重启客户端后让 Agent 搜索一条笔记。'}</small>
        <pre class="snippet">${e(snippet)}</pre></div>
      <p>带有「仅本机」标记的记录不会出现在 MCP 中。查询结果可能会进入 Agent 的模型上下文。</p>
    </div>`, action('copy-config', '复制配置', 'copy', 'primary'), { wide: true });
}

async function clipCapture() {
  const result = await request('captureClipboard');
  await refresh();
  if (state.view === 'inbox' && !state.tag && !result.value.duplicate) {
    await selectEntry(result.value.id, { open: false });
    renderList();
  }
  say(result.value.duplicate ? '刚刚已保存' : '已保存到收件箱');
}

async function handle(button) {
  const type = button.dataset.action;
  const { id, key } = button.dataset;
  const entry = state.entry;
  if (type === 'nav') return navigate(key);
  if (type === 'tag') return navigate('all', key);
  if (type === 'side') return workspace.classList.toggle('nav-open');
  if (type === 'back') {
    state.showDetail = false;
    renderDetail();
    $('.entry.active', listing)?.focus();
    return;
  }
  if (type === 'new') return showEditor();
  if (type === 'capture') return clipCapture();
  if (type === 'search') return showSearch();
  if (type === 'close') return closeDialog();
  if (type === 'entry') {
    if (state.multi) {
      if (!state.items.find((item) => item.id === id && item.kind === 'capture')) {
        say('请先退出多选，再打开笔记。', true);
        return;
      }
      if (state.checked.has(id)) state.checked.delete(id);
      else state.checked.add(id);
      return renderList();
    }
    return selectEntry(id);
  }
  if (type === 'source') return selectEntry(id);
  if (type === 'result') {
    closeDialog();
    if (!state.items.some((item) => item.id === id)) await navigate('all');
    return selectEntry(id);
  }
  if (type === 'multi') {
    state.multi = !state.multi;
    state.checked.clear();
    return renderList();
  }
  if (type === 'more') {
    state.pages++;
    return refresh();
  }
  if (type === 'edit') return showEditor(entry);
  if (type === 'entry-menu') return showItemMenu(entry);
  if (type === 'history') return showHistory(entry);
  if (type === 'preview') {
    const source = await loadImage(id);
    return openDialog('preview', '原图', '<img class="preview-full" alt="原图" src="' + e(source) + '">', '', { wide: true });
  }
  if (type === 'retry') {
    await request('retryOcr', { id, scope: state.scope });
    return refresh();
  }
  if (type === 'organize' || type === 'organize-one') return showOrganize(type === 'organize' ? [...state.checked] : [entry.id]);
  if (type === 'manual' || type === 'agent-organize') {
    const sources = JSON.parse(modal.dataset.sources);
    return type === 'manual' ? showEditor(null, sources) : organizeWithAgent(sources);
  }
  if (type === 'copy-id') {
    await request('copy', { text: entry.id });
    closeDialog();
    return say('已复制条目 ID');
  }
  if (type === 'attach') return $('#file-input', modal).click();
  if (type === 'remove-existing') {
    editor.existing = editor.existing.filter((image) => image !== id);
    return renderFiles();
  }
  if (type === 'remove-file') {
    editor.images.splice(Number(button.dataset.index), 1);
    return renderFiles();
  }
  if (type === 'template') {
    const field = $('#edit-body', modal);
    const template = '## 现象\n\n## 原因\n\n## 解决步骤\n\n## 验证结果\n';
    field.value += (field.value ? '\n\n' : '') + template;
    field.focus();
    return;
  }
  if (type === 'delete' || type === 'restore' || type === 'detach' || type === 'restore-version') {
    const input = type === 'restore-version' ? JSON.parse(modal.dataset.snapshot) : scopeData(entry);
    const operation = type === 'restore-version' ? 'restoreRevision' : type;
    await request(operation, { ...input, source: id, version: Number(button.dataset.version) });
    closeDialog();
    if (type === 'delete' || type === 'restore') await refresh({ clear: true, redraw: true });
    else await refresh();
    return say({ delete: '已移到回收站', restore: '已恢复条目', detach: '已解除来源关联', 'restore-version': '已恢复历史版本' }[type]);
  }
  if (type === 'purge') return openDialog('purge', '清空回收站', '<p>回收站中的所有条目及其历史版本将永久删除，无法恢复。</p>',
    action('close', '取消') + action('purge-confirm', '永久删除', '', 'danger-fill'));
  if (type === 'purge-confirm') {
    await request('purge', { scope: state.scope });
    closeDialog();
    await refresh({ clear: true, redraw: true });
    return say('已清空回收站');
  }
  if (type === 'settings') return showSettings();
  if (type === 'agent') return showAgent();
  if (type === 'agent-tab') return showAgent(key);
  if (type === 'copy-config') {
    await request('copy', { text: state.settings.snippets[agentTab] });
    return say('配置已复制');
  }
  if (type === 'open-directory') return request('openDirectory');
  if (['backup', 'restoreLibrary', 'switchLibrary'].includes(type)) {
    if (!formBusy(button)) return;
    try {
      const result = await request(type);
      if (!result.value) return;
      if (type !== 'backup') {
        closeDialog();
        state.settings = (await request('settings')).value;
        await navigate('inbox');
      }
      say(type === 'backup' ? '备份已保存至 ' + result.value.directory : '已打开知识库副本');
    } finally {
      button.disabled = false;
    }
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (button) void handle(button).catch(dialogMode === 'editor' ? modalError : failure);
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'editor-form') void saveEditor(event.target);
  if (event.target.id === 'settings-form') {
    const fields = new FormData(event.target);
    request('saveSettings', { shortcut: fields.get('shortcut').trim(), autoStart: fields.has('autostart') })
      .then((result) => {
        state.settings = result.value;
        closeDialog();
        renderMainbar();
        renderList();
        say('设置已保存');
      }).catch(modalError);
  }
});

document.addEventListener('paste', (event) => {
  if (dialogMode === 'editor') {
    const files = [...event.clipboardData.files];
    if (files.length) void attachFiles(files);
  } else if (!modal.open && !event.target.closest('input,textarea,[contenteditable]')) {
    event.preventDefault();
    void clipCapture().catch(failure);
  }
});

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'k' && dialogMode !== 'editor') {
    event.preventDefault();
    void showSearch().catch(failure);
  }
  if (!modal.open && (event.ctrlKey || event.metaKey) && key === 'n') {
    event.preventDefault();
    showEditor();
  }
  if (!modal.open && event.key === 'Escape') workspace.classList.remove('nav-open');
  if (!modal.open && event.target.closest('.list-scroll') && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    const entries = [...listing.querySelectorAll('.entry')];
    const index = entries.indexOf(document.activeElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (entries[next]) {
      event.preventDefault();
      entries[next].focus();
    }
  }
});

window.memory.subscribe(({ type, message }) => {
  if (type === 'error') say(message, true);
  if (type === 'capture') say(message);
  if (type === 'switch') void navigate('inbox').catch(failure);
  else if (type !== 'error') void refresh().catch(failure);
});

renderSidebar();
renderMainbar();
renderList();
renderDetail();
request('settings').then((result) => {
  state.settings = result.value;
  if (state.settings.shortcutError) say(state.settings.shortcutError, true);
  return refresh({ redraw: true });
}).catch(failure);
