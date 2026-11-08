// Petits composants partagés.
import { h } from './dom.js';
import { isNum } from './format.js';

// Variation colorée, toujours doublée d'une flèche : la couleur ne porte jamais seule le sens.
export function delta(value, text, { title } = {}) {
  const direction = !isNum(value) || value === 0 ? 'flat' : value > 0 ? 'up' : 'down';
  const arrow = direction === 'up' ? '▲ ' : direction === 'down' ? '▼ ' : '';
  return h('span', { class: `delta delta-${direction}`, title }, `${arrow}${text}`);
}

export function emptyState(text, tag = 'p') {
  return h(tag, { class: 'empty-state' }, text);
}
