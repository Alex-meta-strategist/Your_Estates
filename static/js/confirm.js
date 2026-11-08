// Confirmation modale ; renvoie une promesse résolue à true (confirmé) ou false.
import { t } from './i18n.js';

export function confirmAction({ title = t('Confirmer', 'Confirm'), message = '', confirmLabel = t('Confirmer', 'Confirm') } = {}) {
  const dialog = document.getElementById('confirm-dialog');
  const confirm = dialog.querySelector('[data-confirm]');
  const cancel = dialog.querySelector('[data-cancel]');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  confirm.textContent = confirmLabel;

  return new Promise((resolve) => {
    const finish = (value) => {
      confirm.removeEventListener('click', onConfirm);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false); // touche Échap
    confirm.addEventListener('click', onConfirm);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    cancel.focus();
  });
}
