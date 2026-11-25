export const byId = (id) => document.getElementById(id);

export function node(tag, { text, className, testId } = {}, ...children) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  if (testId) element.dataset.testid = testId;
  element.append(...children);
  return element;
}

export function button(text, testId, onClick, className) {
  const element = node('button', { text, testId, className });
  element.type = 'button';
  element.addEventListener('click', () => onClick(element));
  return element;
}

export const badge = (text, tone = '') => node('span', { text, className: ('badge ' + tone).trim() });
export const empty = (text) => node('p', { text, className: 'empty', testId: 'empty-state' });

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function dateText(timestamp) {
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? dates.format(timestamp) : '—';
}

export function definitionList(rows) {
  const list = node('dl');
  for (const [label, value] of rows) {
    list.append(node('dt', { text: label }), node('dd', { text: value ?? '—' }));
  }
  return list;
}

export function categoryText(category) {
  return category.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function addOptions(select, values) {
  for (const value of values) {
    const option = node('option', { text: categoryText(value) });
    option.value = value;
    select.append(option);
  }
}

export const toneFor = (status) => ({
  active: 'success', pending: 'warning', superseded: 'warning', 'dry-run': 'warning',
  completed: 'success', failed: 'failure',
}[status] ?? '');
