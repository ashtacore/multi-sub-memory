import { api } from './api.js';
import { badge, button, categoryText, dateText, definitionList, empty, node, toneFor } from './dom.js';
import { confirmDelete, editComment, editMemory, editNote, transitionNote } from './dialogs.js';

function prettyMetadata(value) {
  if (!value) return '—';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function memoryDetails(memory, projectLabel) {
  const details = node('details', { testId: 'mem-provenance' }, node('summary', { text: 'Provenance' }),
    definitionList([
      ['ID', memory.id],
      ['Project', memory.project_name ?? projectLabel(memory.project_key)],
      ['Project path', memory.project_root],
      ['Project key', memory.project_key],
      ['Source orchestrator', memory.source_orchestrator],
      ['Source session', memory.source_session_id],
      ['Created', dateText(memory.created_at)],
      ['Updated', dateText(memory.updated_at)],
      ['Last accessed', dateText(memory.last_accessed_at)],
      ['Access count', memory.access_count],
    ]),
    node('h4', { text: 'Metadata' }),
    node('pre', { text: prettyMetadata(memory.metadata_json) }),
  );
  return details;
}

function noteComments(record, path, { onSaved, onError, open }) {
  const summary = node('summary', { text: `Comments (${record.comment_count})`, testId: 'note-comments-summary' });
  const chain = node('ol', { className: 'comment-chain' });
  const feedback = node('p', { className: 'muted' });
  feedback.setAttribute('role', 'status');
  const field = node('textarea', { testId: 'note-comment-body' });
  field.rows = 3;
  field.required = true;
  const submit = node('button', { text: 'Add comment', testId: 'note-comment-add' });
  const error = node('p', { className: 'banner error' });
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const form = node('form', { className: 'comment-form' },
    node('label', { text: 'Progress comment' }, field), error,
    node('div', { className: 'actions' }, submit));
  let cursor;
  let loaded = false;
  const loadMore = button('Load older comments', 'note-comments-more', load);
  loadMore.hidden = true;

  function renderComment(comment) {
    const { id, body, from_status, to_status, created_at, updated_at } = comment;
    const date = node('span', { className: 'muted', text: dateText(created_at) });
    const tags = from_status
      ? [badge(`${categoryText(from_status)} → ${categoryText(to_status)}`, toneFor(to_status)), badge('Read only')]
      : [];
    const edit = !from_status ? [button('Edit comment', 'note-comment-edit', (trigger) => {
      editComment(trigger, { body }, (values) => api(path + '/' + encodeURIComponent(id), {
        method: 'PATCH', body: { ...values, expected_updated_at: String(updated_at) },
      }), () => onSaved('Comment saved.'), onError);
    })] : [];
    for (const control of edit) control.dataset.commentId = id;
    return node('li', { className: 'comment' },
      node('div', { className: 'tags' }, ...tags, date),
      node('p', { text: body, className: 'record-content' }), ...edit);
  }

  async function load() {
    if (loadMore.disabled || (loaded && !cursor)) return;
    loadMore.disabled = true;
    feedback.textContent = 'Loading comments…';
    try {
      const data = await api(path, { params: cursor ? { cursor } : undefined });
      if (!details.isConnected) return;
      chain.append(...data.comments.map(renderComment));
      cursor = data.next_cursor;
      loaded = true;
      feedback.textContent = chain.childElementCount ? '' : 'No comments yet.';
      if (!cursor && document.activeElement === loadMore) field.focus();
      loadMore.textContent = 'Load older comments';
      loadMore.hidden = !cursor;
    } catch (failure) {
      feedback.textContent = failure.message;
      loadMore.textContent = 'Retry loading comments';
      loadMore.hidden = false;
    } finally {
      loadMore.disabled = false;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    if (!field.value.trim()) {
      error.textContent = 'Enter a comment before adding it.';
      error.hidden = false;
      field.focus();
      return;
    }
    submit.disabled = field.readOnly = true;
    error.hidden = true;
    try {
      await api(path, { method: 'POST', body: { body: field.value } });
      field.value = '';
      field.focus();
      onSaved('Comment added.');
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      submit.disabled = field.readOnly = false;
    }
  });

  const details = node('details', { className: 'note-comments' }, summary,
    node('div', { className: 'comment-panel' }, feedback, chain, node('div', {}, loadMore), form));
  details.addEventListener('toggle', () => {
    if (details.open && !loaded) void load();
  });
  details.open = open;
  return details;
}

export function renderRecords(list, records, kind, {
  onSaved, onError, fallbackFocus, append = false, projectLabel = (key) => key,
}) {
  const previousFocus = document.activeElement;
  const previousCard = list.contains(previousFocus) && previousFocus.closest('article');
  const isMemory = kind === 'memory';
  const existing = append ? new Set([...list.children].map((card) => card.dataset.recordId)) : new Set();
  const openChains = new Set(isMemory || append ? [] : [...list.querySelectorAll('.note-comments[open]')]
    .map((details) => details.closest('article').dataset.recordId));
  const cards = records.filter(({ id }) => !existing.has(id)).map((record) => {
    const path = (isMemory ? 'memories/' : 'notes/') + encodeURIComponent(record.id);
    const update = (body) => api(path, {
      method: 'PATCH', body: { ...body, expected_updated_at: String(record.updated_at) },
    });
    const prefix = isMemory ? 'mem' : 'note';
    const tags = isMemory ? [
      badge(categoryText(record.category)), badge('I' + record.importance), badge(categoryText(record.scope)),
    ] : [];
    const projectBadge = badge(projectLabel(record.project_key));
    projectBadge.dataset.projectKey = record.project_key;
    projectBadge.title = record.project_key;
    tags.push(badge(categoryText(record.status), toneFor(record.status)), projectBadge);
    if (!isMemory && record.surface_condition) tags.push(badge(record.surface_condition));

    const edit = button('Edit', prefix + '-edit', (trigger) => {
      if (isMemory) {
        const { content, category, importance, status, project_key } = record;
        editMemory(trigger, { content, category, importance, status, project_key },
          (values) => {
            if ('importance' in values) values.importance = Number(values.importance);
            if ('project_key' in values) {
              values.scope = values.project_key === 'global' ? 'global' : 'project';
            }
            return update(values);
          },
          () => onSaved('Memory saved.'), onError, projectLabel);
      } else {
        const { content, status, surface_condition } = record;
        editNote(trigger, { content, status, surface_condition: surface_condition ?? '' },
          (values) => {
            if ('surface_condition' in values && values.surface_condition === '') values.surface_condition = null;
            return update(values);
          },
          () => onSaved('Note saved.'), onError);
      }
    });
    const restoring = isMemory ? record.status !== 'active' : record.status === 'dismissed';
    const nextStatus = restoring ? 'active' : isMemory ? 'archived' : 'dismissed';
    const action = restoring ? 'Restore' : isMemory ? 'Archive' : 'Dismiss';
    function statusButton(label, targetStatus, testSuffix, message) {
      return button(label, prefix + '-' + testSuffix, async (trigger) => {
        if (!isMemory) {
          transitionNote(trigger, label, ({ comment }) => update({ status: targetStatus, comment }),
            () => onSaved(message), onError);
          return;
        }
        trigger.disabled = true;
        try {
          await update({ status: targetStatus });
          if (trigger.isConnected && document.activeElement === document.body) {
            trigger.disabled = false;
            trigger.focus();
          }
          onSaved(message);
        } catch (error) {
          onError(error);
        } finally {
          trigger.disabled = false;
        }
      });
    }
    const activate = !isMemory && record.status === 'pending'
      ? statusButton('Activate', 'active', 'activate', 'Note activated.')
      : null;
    const changeStatus = statusButton(
      action, nextStatus, action.toLowerCase(),
      (isMemory ? 'Memory' : 'Note') + ' ' + (restoring ? 'restored' : nextStatus) + '.',
    );
    const remove = button('Delete', prefix + '-delete', (trigger) => {
      confirmDelete(trigger, kind, () => api(path, { method: 'DELETE' }),
        () => onSaved(isMemory ? 'Memory deleted.' : 'Note deleted.'), record.comment_count);
    }, 'danger-subtle');
    const card = node('article', { className: 'card record', testId: kind + '-card' },
      node('div', { className: 'tags' }, ...tags),
      node('p', { text: record.content, className: 'record-content' }),
      isMemory ? memoryDetails(record, projectLabel) : definitionList([
        ['Created', dateText(record.created_at)], ['Updated', dateText(record.updated_at)],
        ['Last accessed', dateText(record.last_accessed_at)], ['Access count', record.access_count],
      ]),
      ...(!isMemory ? [
        noteComments(record, path + '/comments', { onSaved, onError, open: openChains.has(record.id) }),
        ...(record.latest_comment_preview
          ? [node('p', { className: 'muted comment-preview', text: record.latest_comment_preview })] : []),
      ] : []),
      node('div', { className: 'actions' }, edit, ...(activate ? [activate] : []), changeStatus, remove),
    );
    card.dataset.recordId = record.id;
    return card;
  });
  if (append) {
    list.append(...cards);
    return cards[0];
  }
  list.replaceChildren(...(cards.length ? cards : [empty('No ' + (isMemory ? 'memories match these filters.' : 'notes match this selection.'))]));
  if (previousCard) {
    const card = cards.find((item) => item.dataset.recordId === previousCard.dataset.recordId);
    const target = card && [...card.querySelectorAll('button, summary, textarea')]
      .find((item) => item.dataset.testid === previousFocus.dataset.testid
        && item.dataset.commentId === previousFocus.dataset.commentId);
    if (target?.tagName === 'SUMMARY' && previousFocus.parentElement.open) target.parentElement.open = true;
    const commentSummary = previousFocus.closest('.note-comments') ? card?.querySelector('.note-comments summary') : null;
    (target ?? commentSummary ?? card?.querySelector('button') ?? fallbackFocus).focus();
  }
}
