import { badge, byId, dateText, definitionList, empty, node, toneFor } from './dom.js';

let shownHistory;

function history(runs) {
  if (!runs.length) return empty('No Dreamer runs for this selection.');
  const labels = ['Started', 'Project', 'Runner / model', 'Status', 'Reviewed', 'Merged', 'Archived', 'Summary', 'Error'];
  const header = node('tr', {}, ...labels.map((label) => {
    const cell = node('th', { text: label });
    cell.scope = 'col';
    cell.setAttribute('role', 'columnheader');
    return cell;
  }));
  header.setAttribute('role', 'row');
  const rows = runs.map((run) => {
    const values = [
      dateText(run.started_at), run.project_key, [run.runner, run.model].filter(Boolean).join(' / '),
      badge(categoryName(run.status), toneFor(run.status)),
      run.memories_reviewed, run.memories_merged, run.memories_archived, run.summary, run.error,
    ];
    const cells = values.map((value, index) => {
      const cell = node('td', {},
        node('span', { text: labels[index], className: 'cell-label' }),
        value instanceof Node ? value : node('span', { text: value ?? '—' }),
      );
      cell.setAttribute('role', 'cell');
      cell.firstElementChild.setAttribute('aria-hidden', 'true');
      return cell;
    });
    const row = node('tr', { testId: 'dream-run-row' }, ...cells);
    row.setAttribute('role', 'row');
    return row;
  });
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

export function renderDreamControls(data, project, running) {
  let hint = '';
  if (running) hint = 'Dreamer is running…';
  else if (!data) hint = 'Waiting for Dreamer status.';
  else if (project === 'all' || project === 'global') hint = 'Select a specific project to run Dreamer.';
  else if (data.runnable_project_key && project !== data.runnable_project_key) {
    hint = 'Dreamer can only run for the workspace this dashboard was launched in. Restart with --cwd for another project.';
  }
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

export function renderDream(data) {
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
    const descriptions = leases.map((lease) => lease.project_key + ' · expires ' + dateText(lease.expires_at));
    if (JSON.stringify([...active.children].map((item) => item.textContent)) !== JSON.stringify(descriptions)) {
      active.replaceChildren(...descriptions.map((text) => node('li', { text })));
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
  const snapshot = JSON.stringify(runs);
  if (snapshot !== shownHistory) {
    byId('dream-history').replaceChildren(history(runs));
    shownHistory = snapshot;
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
  return [title, result.memoriesReviewed + ' reviewed, ' + result.memoriesMerged + ' merged, '
    + result.memoriesArchived + ' archived.', result.summary].filter(Boolean).join(' ');
}
