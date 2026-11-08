// Préférences d'affichage propres à ce navigateur (thème, sélection, couleurs…).
// Les données du patrimoine, elles, sont stockées côté serveur dans SQLite.
const PREFIX = 'patrimony.';

export const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* stockage indisponible (navigation privée…) : sans conséquence */
    }
  },
};
