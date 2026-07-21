'use strict';

const STARTER = `// ==UserScript==
// @name         New Zalo userscript
// @namespace    zalo-for-linux
// @version      1.0.0
// @description  Describe what this script does
// @match        https://chat.zalo.me/*
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  console.log('Hello from Zalo userscript');
})();
`;

const elements = {
  list: document.getElementById('script-list'),
  empty: document.getElementById('empty-state'),
  welcome: document.getElementById('welcome'),
  editor: document.getElementById('editor'),
  name: document.getElementById('script-name'),
  enabled: document.getElementById('script-enabled'),
  code: document.getElementById('script-code'),
  search: document.getElementById('search-input'),
  deleteButton: document.getElementById('delete-button'),
  toast: document.getElementById('toast')
};

let scripts = [];
let selectedId = null;
let toastTimer;

function showToast(message, isError) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = 'toast visible' + (isError ? ' error' : '');
  toastTimer = setTimeout(() => { elements.toast.className = 'toast'; }, 2600);
}

function errorMessage(error) {
  return (error && error.message ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
}

function renderList() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const filtered = scripts.filter((script) =>
    script.name.toLocaleLowerCase().includes(query) ||
    (script.description || '').toLocaleLowerCase().includes(query)
  );
  elements.list.replaceChildren();
  elements.empty.classList.toggle('visible', scripts.length === 0);
  elements.list.classList.toggle('hidden', scripts.length === 0);

  for (const script of filtered) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'script-item' + (script.id === selectedId ? ' selected' : '');
    const state = document.createElement('span');
    state.className = 'script-state' + (script.enabled ? ' enabled' : '');
    const details = document.createElement('span');
    details.className = 'script-details';
    const title = document.createElement('div');
    title.className = 'script-title';
    title.textContent = script.name;
    const description = document.createElement('div');
    description.className = 'script-description';
    description.textContent = script.description || (script.version ? 'Version ' + script.version : 'Không có mô tả');
    details.append(title, description);
    item.append(state, details);
    item.addEventListener('click', () => selectScript(script.id));
    elements.list.appendChild(item);
  }
}

function openEditor(script) {
  elements.welcome.classList.add('hidden');
  elements.editor.classList.remove('hidden');
  elements.name.value = script.name || '';
  elements.enabled.checked = script.enabled !== false;
  elements.code.value = script.code || '';
  elements.deleteButton.classList.toggle('hidden', !script.id);
  setTimeout(() => elements.name.focus(), 0);
}

function selectScript(id) {
  const script = scripts.find((item) => item.id === id);
  if (!script) return;
  selectedId = id;
  openEditor(script);
  renderList();
}

function createScript(code = STARTER, name = 'New Zalo userscript') {
  selectedId = null;
  openEditor({ name, code, enabled: true });
  renderList();
}

async function refresh(preferredId) {
  scripts = await window.userscripts.list();
  renderList();
  if (preferredId && scripts.some((script) => script.id === preferredId)) selectScript(preferredId);
}

document.getElementById('create-button').addEventListener('click', () => createScript());
document.getElementById('import-button').addEventListener('click', async () => {
  try {
    const imported = await window.userscripts.importFile();
    if (imported) createScript(imported.code, imported.suggestedName);
  } catch (error) { showToast(errorMessage(error), true); }
});
elements.search.addEventListener('input', renderList);

elements.editor.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const saved = await window.userscripts.save({
      id: selectedId,
      name: elements.name.value,
      enabled: elements.enabled.checked,
      code: elements.code.value
    });
    selectedId = saved.id;
    await refresh(saved.id);
    showToast('Đã lưu. Script sẽ chạy từ lần tải trang Zalo tiếp theo.');
  } catch (error) { showToast(errorMessage(error), true); }
});

elements.enabled.addEventListener('change', async () => {
  if (!selectedId) return;
  try {
    const updated = await window.userscripts.toggle(selectedId, elements.enabled.checked);
    const index = scripts.findIndex((script) => script.id === selectedId);
    if (index >= 0) scripts[index] = updated;
    renderList();
    showToast(elements.enabled.checked ? 'Đã bật userscript.' : 'Đã tắt userscript.');
  } catch (error) { showToast(errorMessage(error), true); }
});

elements.deleteButton.addEventListener('click', async () => {
  if (!selectedId) return;
  const script = scripts.find((item) => item.id === selectedId);
  if (!confirm(`Xóa userscript “${script ? script.name : ''}”?`)) return;
  try {
    await window.userscripts.remove(selectedId);
    selectedId = null;
    elements.editor.classList.add('hidden');
    elements.welcome.classList.remove('hidden');
    await refresh();
    showToast('Đã xóa userscript.');
  } catch (error) { showToast(errorMessage(error), true); }
});

document.getElementById('cancel-button').addEventListener('click', () => {
  if (selectedId) selectScript(selectedId);
  else {
    elements.editor.classList.add('hidden');
    elements.welcome.classList.remove('hidden');
  }
});

elements.code.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const start = elements.code.selectionStart;
    elements.code.setRangeText('  ', start, elements.code.selectionEnd, 'end');
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    elements.editor.requestSubmit();
  }
});

refresh().catch((error) => showToast(errorMessage(error), true));
