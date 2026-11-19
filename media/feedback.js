// V5 Sim: Report a Problem (webview side). The host
// (src/feedback/feedbackPanel.ts) scans the project folder, packs and sends
// the report; this side is the form.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};

  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  };
  const fmt = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  let folders = [];
  let folder = null;
  let endpoint = null;
  let scan = null;

  const kind = el('select', { id: 'kind', onchange: remember },
    el('option', { value: 'bug' }, 'Something isn\'t working (bug)'),
    el('option', { value: 'idea' }, 'An idea or request'),
    el('option', { value: 'question' }, 'A question'));
  const summary = el('input', { id: 'summary', type: 'text', maxlength: '200', oninput: remember,
    placeholder: 'e.g. The brain screen stays black after Start' });
  const description = el('textarea', { id: 'description', rows: '9', maxlength: '20000', oninput: remember,
    placeholder: 'What did you do, what did you expect, and what happened instead? Error messages help.' });
  const contact = el('input', { id: 'contact', type: 'text', maxlength: '200', oninput: remember,
    placeholder: 'Optional: an email or Discord name if you\'d like a reply' });
  const includeLog = el('input', { id: 'includeLog', type: 'checkbox', checked: true, onchange: remember });
  const includeProject = el('input', { id: 'includeProject', type: 'checkbox', onchange: () => { remember(); projectChanged(); } });
  const folderSelect = el('select', { id: 'folder', onchange: () => vscode.postMessage({ type: 'scan', folder: folderSelect.value }) });
  const pickFolder = el('button', { type: 'button', class: 'secondary', onclick: () => vscode.postMessage({ type: 'pickFolder' }) },
    'Choose folder…');
  const projectBox = el('div', { class: 'project', hidden: true });
  const status = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const send = el('button', { type: 'submit', id: 'send' }, 'Send report');
  const where = el('p', { class: 'hint' });

  const form = el('form', { onsubmit: e => { e.preventDefault(); submit(); } },
    el('h1', {}, 'Report a problem or send feedback'),
    el('p', { class: 'hint' }, 'Goes to the V5 Brain Simulator maintainers. Nothing is sent until you press Send.'),
    el('label', { for: 'kind' }, 'What is it?'), kind,
    el('label', { for: 'summary' }, 'Summary'), summary,
    el('label', { for: 'description' }, 'Details'), description,
    el('label', { for: 'contact' }, 'Contact (optional)'), contact,
    el('fieldset', {},
      el('legend', {}, 'Attach'),
      el('label', { class: 'check' }, includeLog,
        el('span', {}, 'The V5 Sim log and my setup (VS Code and extension version, OS, V5 Sim settings). ',
          el('a', { href: '#', onclick: e => { e.preventDefault(); vscode.postMessage({ type: 'showLog' }); } }, 'Show log'))),
      el('label', { class: 'check' }, includeProject,
        el('span', {}, 'My project folder (source code), so the problem can be reproduced.')),
      projectBox),
    where, status,
    el('div', { class: 'actions' }, send));
  app.append(form);

  function remember() {
    vscode.setState({ kind: kind.value, summary: summary.value, description: description.value, contact: contact.value,
      includeLog: includeLog.checked, includeProject: includeProject.checked });
  }

  function setStatus(text, cls) {
    status.textContent = text || '';
    status.className = `status ${cls || ''}`;
  }

  function projectChanged() {
    projectBox.hidden = !includeProject.checked;
    if (includeProject.checked) {
      renderProject(true);
      vscode.postMessage({ type: 'scan', folder: folder });
    }
  }

  function renderProject(loading) {
    projectBox.replaceChildren();
    folderSelect.replaceChildren(...folders.map(f => el('option', { value: f.path, selected: f.path === folder }, f.name)));
    projectBox.append(el('div', { class: 'row' },
      folders.length ? folderSelect : el('span', { class: 'hint' }, 'No folder is open.'), pickFolder));
    if (loading) { projectBox.append(el('p', { class: 'hint' }, 'Looking at the folder…')); return; }
    if (!scan) return;
    projectBox.append(el('p', { class: 'hint' },
      `${scan.files.length} files, ${fmt(scan.totalBytes)} will be included. Build output, Git data, dependencies and ` +
      'files that may hold passwords or keys are left out.'));
    const list = el('ul', { class: 'files' }, scan.files.map(f => el('li', {}, el('span', {}, f.rel), el('span', { class: 'size' }, fmt(f.size)))));
    projectBox.append(el('details', {}, el('summary', {}, `Files to send (${scan.files.length})`), list));
    if (scan.skipped.length) {
      projectBox.append(el('details', {}, el('summary', {}, `Left out (${scan.skipped.length})`),
        el('ul', { class: 'files' }, scan.skipped.map(s => el('li', {}, el('span', {}, s.rel), el('span', { class: 'size' }, s.reason))))));
    }
  }

  function setBusy(busy) {
    for (const c of [kind, summary, description, contact, includeLog, includeProject, folderSelect, pickFolder, send]) c.disabled = busy;
  }

  function submit() {
    if (!summary.value.trim()) { setStatus('Write a short summary.', 'error'); summary.focus(); return; }
    setBusy(true);
    setStatus('Packing the report…');
    vscode.postMessage({ type: 'submit', form: {
      kind: kind.value, summary: summary.value, description: description.value, contact: contact.value,
      includeLog: includeLog.checked, includeProject: includeProject.checked,
    } });
  }

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'init': {
        folders = m.folders; folder = m.folder; endpoint = m.endpoint;
        const s = Object.assign({}, m.initial, saved);
        if (s.kind) kind.value = s.kind;
        if (s.summary) summary.value = s.summary;
        if (s.description) description.value = s.description;
        if (s.contact) contact.value = s.contact;
        if (typeof s.includeLog === 'boolean') includeLog.checked = s.includeLog;
        if (typeof s.includeProject === 'boolean') includeProject.checked = s.includeProject;
        where.textContent = endpoint
          ? `Sent privately to ${endpoint}.`
          : 'No feedback server is set (v5sim.feedbackEndpoint): the report is saved as a zip for you to attach to a GitHub issue, which is public.';
        send.textContent = endpoint ? 'Send report' : 'Save report & open GitHub';
        projectChanged();
        summary.focus();
        break;
      }
      case 'folders':
        folders = m.folders; folder = m.folder;
        renderProject(true);
        break;
      case 'scan':
        scan = m.scan; folder = scan ? scan.folder : folder;
        renderProject(false);
        break;
      case 'progress':
        setStatus(m.message);
        break;
      case 'error':
        setBusy(false);
        setStatus(m.message, 'error');
        break;
      case 'sent':
        vscode.setState({});
        form.replaceChildren(el('h1', {}, 'Thanks — your report was sent.'),
          el('p', {}, 'Reference: ', el('code', {}, m.id)),
          el('p', { class: 'hint' }, 'Mention the reference if you follow up. You can close this tab.'));
        break;
      case 'saved':
        vscode.setState({});
        setBusy(false);
        setStatus(`Saved to ${m.file}. Attach it to the GitHub issue that opened.`, 'ok');
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
