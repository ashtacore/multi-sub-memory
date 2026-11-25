import { api } from './api.js';
import { badge, button, categoryText, dateText, definitionList, empty, node, toneFor } from './dom.js';
import { confirmDelete, editMemory, editNote } from './dialogs.js';

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
    ]),
    node('h4', { text: 'Metadata' }),
    node('pre', { text: prettyMetadata(memory.metadata_json) }),
  );
  return details;
}

export function renderRecords(list, records, kind, {
  onSaved, onError, fallbackFocus, append = false, projectLabel = (key) => key,
}) {
  const previousFocus = document.activeElement;
  const previousCard = list.contains(previousFocus) && previousFocus.closest('article');
  const isMemory = kind === 'memory';
  const existing = append ? new Set([...list.children].map((card) => card.dataset.recordId)) : new Set();
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
        () => onSaved(isMemory ? 'Memory deleted.' : 'Note deleted.'));
    }, 'danger-subtle');
    const card = node('article', { className: 'card record', testId: kind + '-card' },
      node('div', { className: 'tags' }, ...tags),
      node('p', { text: record.content, className: 'record-content' }),
      isMemory ? memoryDetails(record, projectLabel) : definitionList([
        ['Created', dateText(record.created_at)], ['Updated', dateText(record.updated_at)],
      ]),
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
    const target = card && [...card.querySelectorAll('button, summary')]
      .find((item) => item.dataset.testid === previousFocus.dataset.testid);
    if (target?.tagName === 'SUMMARY' && previousFocus.parentElement.open) target.parentElement.open = true;
    (target ?? card?.querySelector('button') ?? fallbackFocus).focus();
  }
}
