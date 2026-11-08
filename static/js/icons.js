// Icônes SVG au trait (24 × 24), construites sans innerHTML.
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  refresh: ['M20.5 12a8.5 8.5 0 1 1-2.49-6.01L20.5 8.5', 'M20.5 3.5v5h-5'],
  history: ['M3.5 12a8.5 8.5 0 1 0 2.49-6.01L3.5 8.5', 'M3.5 3.5v5h5', 'M12 7.5V12l3 2'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4.2-4.2'],
  pin: ['M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z', 'M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z'],
  edit: ['M4 20l1-4.5L16 4.5a2.12 2.12 0 0 1 3 3L8 18.5z', 'M14 6.5l3 3'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13', 'M10 11v5.5', 'M14 11v5.5'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2.5v2', 'M12 19.5v2', 'M2.5 12h2', 'M19.5 12h2',
    'M5.3 5.3l1.4 1.4', 'M17.3 17.3l1.4 1.4', 'M5.3 18.7l1.4-1.4', 'M17.3 6.7l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  alert: ['M12 3.5L2.5 20h19z', 'M12 10v4.5', 'M12 17.4v.1'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.9v.1'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  table: ['M4 5h16v14H4z', 'M4 10h16', 'M4 14.5h16', 'M10 10v9'],
  swap: ['M7 7h12', 'M16 4l3 3-3 3', 'M17 17H5', 'M8 14l-3 3 3 3'],
};

export function icon(name, { size = 16, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon ${className}`.trim());
  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Remplit les <span data-icon="…"> du HTML statique.
export function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) {
    slot.replaceChildren(icon(slot.dataset.icon));
    slot.removeAttribute('data-icon');
  }
}
