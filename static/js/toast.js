import { h } from './dom.js';
import { icon } from './icons.js';

const ICONS = { error: 'alert', success: 'check', info: 'info' };

export function toast(message, { type = 'info', timeout = 4500 } = {}) {
  const root = document.getElementById('toasts');
  while (root.children.length >= 3) root.firstElementChild.remove(); // trois notifications au plus
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(ICONS[type] ?? 'info'),
    h('span', {}, message));
  root.append(el);
  const remove = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  const timer = setTimeout(remove, timeout);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}
