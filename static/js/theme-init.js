// Applique le thème mémorisé avant le premier affichage (évite un flash clair puis sombre).
(function () {
  try {
    var theme = JSON.parse(localStorage.getItem('patrimony.theme'));
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* stockage indisponible : on suit le thème du système */
  }
})();
