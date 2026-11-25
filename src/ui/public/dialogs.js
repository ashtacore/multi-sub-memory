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
    const blankField = ['content', 'comment', 'body'].find((name) => name in values && !values[name].trim());
    if (blankField) {
      error.textContent = blankField === 'content' ? 'Enter some content before saving.' : 'Enter a comment before saving.';
      error.hidden = false;
      form.elements[blankField].focus();
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

const openNote = bindDialog('edit-note-dialog');
const noteForm = byId('edit-note-dialog').querySelector('form');
const transitionComment = noteForm.elements.comment;
let initialNoteStatus;

function showTransitionComment() {
  const changing = noteForm.elements.status.value !== initialNoteStatus;
  transitionComment.closest('label').hidden = !changing;
  transitionComment.disabled = !changing;
  transitionComment.required = changing;
}

noteForm.elements.status.addEventListener('change', showTransitionComment);
export function editNote(trigger, values, save, onSaved, onConflict) {
  initialNoteStatus = values.status;
  noteForm.elements.status.value = values.status;
  transitionComment.value = '';
  showTransitionComment();
  openNote(trigger, values, save, onSaved, onConflict);
}

const openTransition = bindDialog('note-transition-dialog');
const quickComment = byId('note-transition-dialog').querySelector('textarea');
export function transitionNote(trigger, label, save, onSaved, onConflict) {
  byId('note-transition-title').textContent = label + ' note';
  quickComment.value = '';
  openTransition(trigger, null, save, onSaved, onConflict);
}

export const editComment = bindDialog('edit-comment-dialog');
const confirm = bindDialog('confirm-dialog');

export function confirmDelete(trigger, kind, remove, onDeleted, { commentCount, onConflict } = {}) {
  byId('confirm-title').textContent = 'Delete ' + kind + '?';
  const target = commentCount === undefined ? kind
    : `note and its ${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`;
  byId('confirm-description').textContent = 'This permanently deletes the ' + target + ' from the database.';
  confirm(trigger, null, remove, onDeleted, onConflict);
}
