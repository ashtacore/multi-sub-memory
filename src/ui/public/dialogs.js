import { byId } from './dom.js';

function bindDialog(id) {
  const dialog = byId(id);
  const form = dialog.querySelector('form');
  const error = form.querySelector('[role="alert"]');
  const cancel = form.querySelector('[data-cancel]');
  const submit = form.querySelector('button:not([type="button"])');
  let action;
  let afterSave;
  let onConflict;
  let initialValues;
  let opener;
  let fallbackFocus;
  let saving = false;

  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    (opener?.isConnected ? opener : fallbackFocus)?.focus();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    const submitted = [...new FormData(form)];
    const values = Object.fromEntries(initialValues
      ? submitted.filter(([key, value]) => initialValues.get(key) !== value) : submitted);
    if (initialValues && !Object.keys(values).length) {
      dialog.close();
      return;
    }
    if ('content' in values && !values.content.trim()) {
      error.textContent = 'Enter some content before saving.';
      error.hidden = false;
      form.elements.content.focus();
      return;
    }
    saving = true;
    cancel.disabled = submit.disabled = true;
    error.hidden = true;
    try {
      await action(values);
    } catch (failure) {
      if (failure.status === 409 && onConflict) {
        dialog.close();
        onConflict(failure);
        return;
      }
      error.textContent = failure.message;
      error.hidden = false;
      return;
    } finally {
      saving = false;
      cancel.disabled = submit.disabled = false;
    }
    dialog.close();
    if (opener?.isConnected) opener.focus();
    afterSave();
  });

  return (trigger, values, save, onSaved, conflict) => {
    opener = trigger;
    fallbackFocus = trigger.closest('.panel')?.querySelector('h2');
    action = save;
    afterSave = onSaved;
    onConflict = conflict;
    error.hidden = true;
    for (const [key, value] of Object.entries(values ?? {})) form.elements[key].value = value;
    initialValues = values ? new Map(new FormData(form)) : null;
    dialog.showModal();
  };
}

const openMemory = bindDialog('edit-memory-dialog');
const memoryStatus = byId('edit-memory-dialog').querySelector('select[name="status"]');
const memoryProject = byId('edit-memory-dialog').querySelector('select[name="project_key"]');
const supersededOption = new Option('Superseded', 'superseded');

export function editMemory(trigger, values, save, onSaved, onConflict, projectLabel = (key) => key) {
  if (values.status === 'superseded') {
    memoryStatus.add(supersededOption);
  } else {
    supersededOption.remove();
  }
  if (values.project_key && ![...memoryProject.options].some(({ value }) => value === values.project_key)) {
    memoryProject.add(new Option(projectLabel(values.project_key), values.project_key));
  }
  openMemory(trigger, values, save, onSaved, onConflict);
}

export const editNote = bindDialog('edit-note-dialog');
const confirm = bindDialog('confirm-dialog');

export function confirmDelete(trigger, kind, remove, onDeleted) {
  byId('confirm-title').textContent = 'Delete ' + kind + '?';
  byId('confirm-description').textContent = 'This permanently deletes the ' + kind + ' from the database.';
  confirm(trigger, null, remove, onDeleted);
}
