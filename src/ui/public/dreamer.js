import { badge, byId, dateText, definitionList, empty, node, toneFor } from './dom.js';

let shownHistory;

function durationText(startedAt, finishedAt) {
  if (typeof startedAt !== 'number' || typeof finishedAt !== 'number') return '—';
  const ms = Math.max(0, finishedAt - startedAt);
  if (ms < 1000) return ms + 'ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + 'm ' + seconds + 's';
}

const DREAM_STATUS_OPTIONS = [
  ['all', 'Status: All'],
  ['completed', 'Status: Completed'],
  ['dry-run', 'Status: Dry run'],
  ['failed', 'Status: Failed'],
  ['running', 'Status: Running'],
];

const HISTORY_COLUMNS = [
  { label: 'Started', sortKey: 'started_at', className: 'col-time' },
  { label: 'Finished', sortKey: 'finished_at', className: 'col-time' },
  { label: 'Run time', sortKey: 'duration', className: 'col-duration' },
  { label: 'Project', className: 'col-project' },
  { label: 'Runner / model', className: 'col-runner' },
  { label: 'Status', filterKey: 'status', className: 'col-status' },
  { label: 'Reviewed', className: 'col-num' },
  { label: 'Merged', className: 'col-num' },
  { label: 'Archived', className: 'col-num' },
  { label: 'Summary / Error', className: 'col-summary' },
];

function history(runs, projectLabel, { status = 'all', sort = 'started_at', order = 'desc', onStatus, onSort } = {}) {
  if (!runs.length && status === 'all') return empty('No Dreamer runs for this selection.');
  const header = node('tr', {}, ...HISTORY_COLUMNS.map(({ label, sortKey, filterKey, className }) => {
    const cell = node('th', { className });
    cell.scope = 'col';
    cell.setAttribute('role', 'columnheader');
    if (sortKey && onSort) {
      const active = sort === sortKey;
      const ariaSort = active ? (order === 'asc' ? 'ascending' : 'descending') : 'none';
      cell.setAttribute('aria-sort', ariaSort);
      const indicator = node('span', {
        text: active ? (order === 'asc' ? '↑' : '↓') : '↕',
        className: 'sort-indicator' + (active ? ' active' : ''),
      });
      indicator.setAttribute('aria-hidden', 'true');
      const trigger = node('button', {
        className: 'sort-header',
        testId: 'dream-sort-' + sortKey,
      }, node('span', { text: label }), indicator);
      trigger.type = 'button';
      trigger.dataset.sortKey = sortKey;
      trigger.addEventListener('click', () => onSort(sortKey));
      cell.append(trigger);
    } else if (filterKey === 'status' && onStatus) {
      const select = node('select', { className: 'header-filter', testId: 'dream-status-filter' },
        ...DREAM_STATUS_OPTIONS.map(([value, text]) => {
          const option = node('option', { text });
          option.value = value;
          return option;
        }),
      );
      select.value = status;
      select.dataset.filterKey = 'status';
      select.setAttribute('aria-label', 'Filter runs by status');
      select.addEventListener('change', () => onStatus(select.value));
      cell.append(select);
    } else {
      cell.textContent = label;
    }
    return cell;
  }));
  header.setAttribute('role', 'row');
  const rows = runs.length ? runs.map((run) => {
    const projectValue = node('span', { text: projectLabel(run.project_key) });
    projectValue.dataset.projectKey = run.project_key;
    projectValue.title = run.project_key;
    const outcome = run.error
      ? node('span', { text: run.error, className: 'run-error' })
      : (run.summary ?? '—');
    const values = [
      dateText(run.started_at),
      run.finished_at == null ? '—' : dateText(run.finished_at),
      durationText(run.started_at, run.finished_at),
      projectValue,
      [run.runner, run.model].filter(Boolean).join(' / '),
      badge(categoryName(run.status), toneFor(run.status)),
      run.memories_reviewed,
      run.memories_merged,
      run.memories_archived,
      outcome,
    ];
    const cells = values.map((value, index) => {
      const cell = node('td', { className: HISTORY_COLUMNS[index].className },
        node('span', { text: HISTORY_COLUMNS[index].label, className: 'cell-label' }),
        value instanceof Node ? value : node('span', { text: value ?? '—' }),
      );
      cell.setAttribute('role', 'cell');
      cell.firstElementChild.setAttribute('aria-hidden', 'true');
      return cell;
    });
    const row = node('tr', { testId: 'dream-run-row' }, ...cells);
    row.setAttribute('role', 'row');
    return row;
  }) : [(() => {
    const cell = node('td', { text: 'No Dreamer runs match this status filter.', className: 'empty-cell' });
    cell.colSpan = HISTORY_COLUMNS.length;
    const row = node('tr', { className: 'empty-row' }, cell);
    row.setAttribute('role', 'row');
    return row;
  })()];
  const head = node('thead', {}, header);
  const body = node('tbody', {}, ...rows);
  head.setAttribute('role', 'rowgroup');
  body.setAttribute('role', 'rowgroup');
  const table = node('table', {}, head, body);
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Dreamer run history');
  return table;
}

function categoryName(status) {
  return status === 'dry-run' ? 'Dry run' : status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function renderDreamControls(data, project, running, preferredCheckout) {
  const select = byId('dream-checkout');
  const checkouts = data?.project_key === project && data.runnable_project_key === project ? data.checkouts : [];
  if (JSON.stringify([...select.options].map(({ value }) => value)) !== JSON.stringify(checkouts)) {
    select.replaceChildren(...checkouts.map((checkout) => new Option(checkout, checkout)));
  }
  select.value = checkouts.includes(preferredCheckout) ? preferredCheckout : checkouts[0] ?? '';
  select.title = select.value;
  byId('dream-checkout-field').hidden = checkouts.length < 2;
  select.disabled = running;
  let hint = '';
  if (running) hint = 'Dreamer is running…';
  else if (project === 'all' || project === 'global') hint = 'Select a specific project to run Dreamer.';
  else if (!data || data.project_key !== project) hint = 'Waiting for Dreamer status.';
  else if (!checkouts.length) hint = 'No local Git checkout is available for this project. Add an existing directory to this project’s checkouts in config.yaml.';
  else if (!data.config.enabled) hint = 'Dreamer is disabled in configuration.';
  else if (!data.config.authorized) hint = 'Authorize this Dreamer runner in user settings.';
  else if (data.active_leases.some(({ project_key }) => project_key === project)) {
    hint = 'Dreamer already holds a lease for this project.';
  }
  byId('dream-trigger').disabled = byId('dream-dryrun').disabled = Boolean(hint);
  const help = byId('dream-hint');
  help.hidden = !hint;
  if (help.textContent !== hint) help.textContent = hint;
}

export function renderDream(data, projectLabel = (key) => key, sortState = {}) {
  const { active_leases: leases, config, runs } = data;
  const status = byId('dream-status');
  const nextStatus = leases.length ? 'Active · ' + leases.length + (leases.length === 1 ? ' lease' : ' leases') : 'Idle';
  if (status.querySelector('.badge')?.textContent !== nextStatus) {
    status.replaceChildren(badge(nextStatus, leases.length ? 'warning' : 'success'));
  }
  let active = status.querySelector('ul');
  if (leases.length) {
    if (!active) {
      active = node('ul', { className: 'leases' });
      status.append(active);
    }
    const descriptions = leases.map((lease) => projectLabel(lease.project_key) + ' · expires ' + dateText(lease.expires_at));
    if (JSON.stringify([...active.children].map((item) => item.textContent)) !== JSON.stringify(descriptions)) {
      active.replaceChildren(...leases.map((lease, index) => {
        const item = node('li', { text: descriptions[index] });
        item.dataset.projectKey = lease.project_key;
        item.dataset.projectSuffix = ' · expires ' + dateText(lease.expires_at);
        item.title = lease.project_key;
        return item;
      }));
    }
  } else active?.remove();
  const { runner } = config;
  byId('dream-config').replaceChildren(definitionList([
    ['Enabled', config.enabled ? 'Yes' : 'No'], ['Mode', config.mode], ['Cadence', config.cadence],
    ['Interval', config.interval_hours + ' hours'], ['Minimum new memories', config.min_new_memories],
    ['Runner', runner.type], ['Model', runner.model],
    ...(runner.endpoint_host ? [['Endpoint', runner.endpoint_host], ['API key', runner.api_key_configured ? 'Configured' : 'Missing']] : []),
    ...(runner.executable ? [['Executable', runner.executable]] : []),
  ]));
  const container = byId('dream-history');
  const snapshot = JSON.stringify({ runs, status: sortState.status, sort: sortState.sort, order: sortState.order });
  if (snapshot !== shownHistory) {
    const activeEl = container.contains(document.activeElement) ? document.activeElement : null;
    const focusedSortKey = activeEl?.dataset?.sortKey;
    const focusedFilterKey = activeEl?.dataset?.filterKey;
    container.replaceChildren(history(runs, projectLabel, sortState));
    shownHistory = snapshot;
    if (focusedSortKey) {
      container.querySelector(`button[data-sort-key="${focusedSortKey}"]`)?.focus({ preventScroll: true });
    } else if (focusedFilterKey) {
      container.querySelector(`select[data-filter-key="${focusedFilterKey}"]`)?.focus({ preventScroll: true });
    }
  }
}

export function dreamResult(result) {
  if (result.skipped) {
    const reason = {
      disabled: 'Dreamer is disabled.',
      'lease-held': 'Another run holds the lease for this project.',
      cadence: 'The automatic cadence is not due.',
    }[result.reason] ?? 'No run was started.';
    return 'Run skipped. ' + reason;
  }
  const title = result.status === 'dry-run' ? 'Dry run complete.' : 'Dream run complete.';
  const compactions = result.operations?.filter(({ type }) => type === 'compact_note_comments') ?? [];
  const commentActivity = compactions.length
    ? `${compactions.length} note ${compactions.length === 1 ? 'chain' : 'chains'} ${result.dryRun ? 'proposed for compaction' : 'compacted'}.` : '';
  const tagOperations = result.tag_operations ?? [];
  const tagActivity = tagOperations.length
    ? `${tagOperations.length} tag ${tagOperations.length === 1 ? 'change' : 'changes'} ${result.dryRun ? 'proposed' : 'applied'}.` : '';
  const message = [title, result.memoriesReviewed + ' reviewed, ' + result.memoriesMerged + ' merged, '
    + result.memoriesArchived + ' archived.', commentActivity, tagActivity, result.summary, result.warning].filter(Boolean).join(' ');
  if (!result.dryRun) return message;
  const comments = compactions.map(({ note_id, source_comment_ids, summary }) =>
    `Note ${note_id} · Source comments ${source_comment_ids.join(', ')}\n${summary}`);
  const tags = tagOperations.map(({ type, tag, from_tag, to_tag, description }) => {
    const action = type === 'merge' ? `Merge tag ${from_tag} into ${to_tag}` : `Describe tag ${tag}`;
    return description ? action + ' · ' + description : action;
  });
  return [message, ...comments, ...tags].join('\n');
}
