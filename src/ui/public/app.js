import { api } from './api.js';
import { addOptions, byId, node } from './dom.js';
import { dreamResult, renderDream, renderDreamControls } from './dreamer.js';
import { renderRecords } from './records.js';

const categories = ['ARCHITECTURE', 'CONFIG_VALUES', 'CONSTRAINTS', 'PROJECT_RULES', 'DECISIONS', 'WORKFLOW', 'GENERAL'];
const projectSelect = byId('project');
const editMemoryProjectSelect = byId('edit-memory-dialog').querySelector('select[name="project_key"]');
const search = byId('mem-search');
const memSort = byId('mem-sort');
const memoryCount = byId('mem-count');
const notesLoadMore = byId('notes-load-more');
const navigation = [...document.querySelectorAll('[data-view]')];
const noteStatuses = [...document.querySelectorAll('[data-status]')];
const errors = new Map();
const projectNames = new Map();
const dreamResults = new Map();
let savedMemorySort = null;

function projectLabel(projectKey) {
  if (projectKey === 'global') return 'Global';
  return projectNames.get(projectKey) ?? projectKey;
}

function syncProjectLabels() {
  for (const element of document.querySelectorAll('[data-project-key]')) {
    const key = element.dataset.projectKey;
    const label = projectLabel(key);
    if (element.dataset.projectSuffix) {
      const text = label + element.dataset.projectSuffix;
      if (element.textContent !== text) element.textContent = text;
    } else if (element.textContent !== label) {
      element.textContent = label;
    }
  }
}
const dreamRequests = new Set();
const recordQueries = new Map();
let view = 'memories';
let noteStatus = 'active';
let dreamStatus = 'all';
let dreamSort = 'started_at';
let dreamOrder = 'desc';
let overview;
let overviewRequest;
let viewRequest;
let searchTimer;
let toastTimer;
let dreamData;
let notesNextCursor = null;

addOptions(byId('mem-category'), categories);
addOptions(byId('edit-memory-dialog').querySelector('select[name="category"]'), categories);

function showError(source, error) {
  if (error) errors.set(source, error.message);
  else errors.delete(source);
  byId('error-message').textContent = [...errors.values()].join(' ');
  byId('error-banner').hidden = !errors.size;
  byId('retry').hidden = ![...errors.keys()].some((key) => key !== 'mutation');
}

function toast(text) {
  clearTimeout(toastTimer);
  byId('toast-region').replaceChildren(node('p', { text, className: 'toast', testId: 'toast' }));
  toastTimer = setTimeout(() => byId('toast-region').replaceChildren(), 4500);
}

function refreshStats() {
  if (!overview) return;
  const selected = projectSelect.value;
  const data = selected === 'all' ? overview.totals : selected === 'global' ? overview.global
    : overview.projects.find(({ project_key }) => project_key === selected);
  const groups = [
    ['Memories', data?.memories, ['active', 'archived', 'superseded']],
    ['Notes', data?.notes, ['active', 'pending', 'dismissed']],
    ['Transcripts', data?.transcripts, ['files', 'messages']],
  ];
  byId('stats').replaceChildren(...groups.map(([label, counts, fields]) =>
    node('div', { className: 'stat' },
      node('h2', { text: label }),
      node('dl', {}, ...fields.map((field) =>
        node('div', {}, node('dt', { text: field }), node('dd', { text: counts?.[field] ?? 0 })),
      )),
    ),
  ));
}

function updateProjectOptions(projects, defaultKey) {
  projectNames.clear();
  for (const { project_key, display_name } of projects) {
    projectNames.set(project_key, display_name || project_key);
  }
  syncProjectLabels();
  const labels = projects.map(({ project_key, display_name }) => [
    project_key, (display_name || project_key) + (project_key === defaultKey ? ' · current' : ''),
  ]);
  syncSelectOptions(projectSelect, 2, labels);
  syncSelectOptions(editMemoryProjectSelect, 1, labels);
}

function syncSelectOptions(select, fixedCount, labels) {
  if (JSON.stringify(labels) === JSON.stringify([...select.options].slice(fixedCount).map((item) => [item.value, item.text]))) return;
  const selected = select.value;
  select.replaceChildren(...[...select.options].slice(0, fixedCount));
  for (const [key, label] of labels) {
    const option = node('option', { text: label });
    option.value = key;
    select.append(option);
  }
  if (selected && ![...select.options].some(({ value }) => value === selected)) {
    const option = node('option', { text: projectLabel(selected) });
    option.value = selected;
    select.append(option);
  }
  if (selected) select.value = selected;
}

async function refreshOverview() {
  overviewRequest?.abort();
  const request = new AbortController();
  overviewRequest = request;
  try {
    const data = await api('overview', { signal: request.signal });
    if (request.signal.aborted) return;
    overview = data;
    showError('overview');
    updateProjectOptions(data.projects, data.default_project_key);
    refreshStats();
    const db = document.querySelector('[data-testid="health-db"]');
    db.textContent = 'DB ready · v' + data.db.schema_version + ' · ' + data.db.journal_mode.toUpperCase();
    db.className = 'badge success';
    const embedding = document.querySelector('[data-testid="health-embedding"]');
    const label = {
      disabled: 'Embeddings off', onnx: 'Embeddings ready', 'fts-only': 'FTS only', uninitialized: 'Embeddings on demand',
    }[data.embedding.status] ?? 'Embeddings';
    embedding.textContent = [label, data.embedding.enabled && data.embedding.model].filter(Boolean).join(' · ');
    embedding.className = 'badge' + (data.embedding.status === 'onnx' ? ' success' : '');
  } catch (error) {
    if (!request.signal.aborted) {
      const db = document.querySelector('[data-testid="health-db"]');
      db.textContent = 'Database status unavailable';
      db.className = 'badge failure';
      const embedding = document.querySelector('[data-testid="health-embedding"]');
      embedding.textContent = 'Embedding status unavailable';
      embedding.className = 'badge';
      showError('overview', error);
    }
  }
}

function saved(message) {
  showError('mutation');
  toast(message);
  void refreshOverview();
  void refreshView();
}

function recordError(error) {
  showError('mutation', error);
  if (error.status === 409) {
    void refreshOverview();
    void refreshView();
  }
}

function updateDreamControls() {
  const project = projectSelect.value;
  renderDreamControls(dreamData, project, dreamRequests.has(project));
  const result = byId('dream-result');
  const state = dreamResults.get(project);
  result.hidden = !state;
  const text = state?.message ?? '';
  if (result.textContent !== text) result.textContent = text;
  result.className = 'banner' + (state?.tone ? ' ' + state.tone : '');
}

function splitSort(value) {
  const [sort, order] = value.split(':');
  return { sort, order };
}

function syncMemorySort() {
  if (search.value.trim().length > 0) {
    if (savedMemorySort === null) {
      savedMemorySort = memSort.value;
      memSort.add(new Option('Relevance', 'relevance'));
      memSort.value = 'relevance';
      memSort.disabled = true;
    }
  } else if (savedMemorySort !== null) {
    memSort.querySelector('option[value="relevance"]').remove();
    memSort.disabled = false;
    memSort.value = savedMemorySort;
    savedMemorySort = null;
  }
}

function syncDreamMobileControls() {
  byId('dream-status-mobile').value = dreamStatus;
  byId('dream-sort-mobile').value = `${dreamSort}:${dreamOrder}`;
}

function handleDreamStatus(status) {
  dreamStatus = status;
  syncDreamMobileControls();
  void refreshView();
}

function handleDreamSort(column) {
  if (dreamSort === column) {
    dreamOrder = dreamOrder === 'desc' ? 'asc' : 'desc';
  } else {
    dreamSort = column;
    dreamOrder = 'desc';
  }
  syncDreamMobileControls();
  void refreshView();
}

async function refreshView({ quiet = false, append = false } = {}) {
  clearTimeout(searchTimer);
  viewRequest?.abort();
  const request = new AbortController();
  viewRequest = request;
  const current = view;
  const panel = byId('view-' + current);
  const params = { project_key: projectSelect.value };
  if (current === 'memories') {
    syncMemorySort();
    Object.assign(params, {
      q: search.value, scope: byId('mem-scope').value, category: byId('mem-category').value,
      status: byId('mem-status').value, ...splitSort(savedMemorySort ?? memSort.value),
    });
    if (!quiet) memoryCount.textContent = 'Loading…';
  }
  if (current === 'notes') {
    Object.assign(params, { status: noteStatus, ...splitSort(byId('note-sort').value) });
    if (append) {
      params.cursor = notesNextCursor;
      notesLoadMore.setAttribute('aria-disabled', 'true');
    } else {
      notesNextCursor = null;
      notesLoadMore.hidden = true;
      notesLoadMore.removeAttribute('aria-disabled');
    }
  }
  if (current === 'dreamer') {
    Object.assign(params, { status: dreamStatus, sort: dreamSort, order: dreamOrder });
  }
  if (current !== 'dreamer' && !append) {
    const key = new URLSearchParams(params).toString();
    if (recordQueries.get(current) !== key) {
      recordQueries.set(current, key);
      if (current === 'memories') byId('memory-list').replaceChildren();
      else byId('note-list').replaceChildren(node('p', { text: 'Loading notes…', className: 'muted' }));
    }
  }
  if (!quiet) panel.setAttribute('aria-busy', 'true');
  try {
    const data = await api(current, { params, signal: request.signal });
    if (request.signal.aborted) return;
    showError('view');
    if (current === 'dreamer') {
      dreamData = data;
      renderDream(data, projectLabel, {
        status: dreamStatus,
        sort: dreamSort,
        order: dreamOrder,
        onStatus: handleDreamStatus,
        onSort: handleDreamSort,
      });
      updateDreamControls();
      return;
    }
    const kind = current === 'memories' ? 'memory' : 'note';
    const heading = byId(current + '-heading');
    const firstAdded = renderRecords(byId(kind + '-list'), data[current], kind, {
      onSaved: saved, onError: recordError, fallbackFocus: heading, append, projectLabel,
    });
    if (current === 'notes') {
      notesNextCursor = data.next_cursor;
      if (append && document.activeElement === notesLoadMore) {
        (firstAdded?.querySelector('button') ?? (notesNextCursor ? notesLoadMore : heading)).focus({ preventScroll: true });
      }
      notesLoadMore.hidden = !notesNextCursor;
    }
    if (current === 'memories') {
      const count = data.memories.length;
      const mode = { hybrid: ' · Hybrid search', 'fts-only': ' · Full-text search' }[data.mode] ?? '';
      memoryCount.textContent = count + (count === 1 ? ' result' : ' results') + mode;
    }
    if (current === 'memories' && params.q.trim()) void refreshOverview();
  } catch (error) {
    if (!request.signal.aborted) {
      showError('view', error);
      if (current === 'memories') memoryCount.textContent = 'Results unavailable';
      if (current === 'notes' && !byId('note-list').querySelector('article')) byId('note-list').replaceChildren();
      if (current === 'dreamer') {
        dreamData = undefined;
        updateDreamControls();
      }
    }
  } finally {
    if (viewRequest === request) {
      panel.removeAttribute('aria-busy');
      if (current === 'notes') notesLoadMore.removeAttribute('aria-disabled');
    }
  }
}

function scheduleSearch() {
  syncMemorySort();
  clearTimeout(searchTimer);
  viewRequest?.abort();
  searchTimer = setTimeout(() => void refreshView(), 275);
}

function switchView(selected) {
  if (selected === view) return;
  byId('view-' + view).hidden = true;
  byId('view-' + view).removeAttribute('aria-busy');
  view = selected;
  byId('view-' + view).hidden = false;
  for (const tab of navigation) tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
  showError('view');
  showError('mutation');
  void refreshView();
}

async function dream(dryRun) {
  const project = projectSelect.value;
  const fingerprint = dreamData?.config.config_fingerprint;
  if (!fingerprint || dreamRequests.has(project)) return;
  const trigger = document.activeElement;
  dreamRequests.add(project);
  dreamResults.delete(project);
  updateDreamControls();
  try {
    const result = await api('dreamer/run', {
      method: 'POST',
      body: { project_key: project, dry_run: dryRun, expected_config_fingerprint: fingerprint },
    });
    dreamResults.set(project, { message: dreamResult(result), tone: result.skipped ? '' : 'success' });
  } catch (error) {
    dreamResults.set(project, { message: error.message, tone: 'error' });
    if (error.status === 409) dreamData = undefined;
  } finally {
    dreamRequests.delete(project);
    updateDreamControls();
    if (view === 'dreamer' && projectSelect.value === project && document.activeElement === document.body) trigger.focus();
    void refreshOverview();
    void refreshView();
  }
}

for (const tab of navigation) tab.addEventListener('click', () => switchView(tab.dataset.view));
for (const tab of noteStatuses) {
  tab.addEventListener('click', () => {
    noteStatus = tab.dataset.status;
    for (const item of noteStatuses) item.setAttribute('aria-pressed', String(item === tab));
    void refreshView();
  });
}
projectSelect.addEventListener('change', () => {
  refreshStats();
  updateDreamControls();
  void refreshView();
});
search.addEventListener('input', scheduleSearch);
for (const id of ['mem-scope', 'mem-category', 'mem-status', 'mem-sort', 'note-sort']) {
  byId(id).addEventListener('change', () => void refreshView());
}
byId('dream-status-mobile').addEventListener('change', (event) => handleDreamStatus(event.target.value));
byId('dream-sort-mobile').addEventListener('change', (event) => {
  const { sort, order } = splitSort(event.target.value);
  dreamSort = sort;
  dreamOrder = order;
  void refreshView();
});
byId('dream-trigger').addEventListener('click', () => void dream(false));
byId('dream-dryrun').addEventListener('click', () => void dream(true));
notesLoadMore.addEventListener('click', () => {
  if (notesNextCursor && !notesLoadMore.hasAttribute('aria-disabled')) void refreshView({ append: true });
});
byId('retry').addEventListener('click', () => {
  void refreshOverview();
  void refreshView();
});
setInterval(() => {
  if (view === 'dreamer' && !document.hidden && !byId('view-dreamer').hasAttribute('aria-busy')) {
    void refreshView({ quiet: true });
  }
}, 5000);
void refreshOverview();
void refreshView();
