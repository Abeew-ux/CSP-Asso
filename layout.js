// En-tête, pied de page et utilitaires partagés par toutes les pages.
(function () {
  const URL_API = 'https://vgnxmwwvdgyqmthoovwf.supabase.co';
  const KEY = 'sb_publishable_rbIdP1IyapQaA6vm73HeIQ_2vMM6VZ6'; // clé publique (RLS protège les données)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let cache;
  async function infos() { // textes modifiables depuis le bot Telegram (/info clé | valeur)
    if (cache) return cache;
    try {
      const r = await fetch(`${URL_API}/rest/v1/infos?select=cle,valeur`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
      cache = Object.fromEntries((r.ok ? await r.json() : []).map((x) => [x.cle, x.valeur]));
    } catch (e) { cache = {}; }
    return cache;
  }
  window.CSP = { URL_API, KEY, esc, infos };

  const liens = [['index.html', 'Accueil'], ['apropos.html', 'À propos'], ['formations.html', 'Formations'], ['inscription.html', 'Inscriptions'], ['contact.html', 'Contact']];
  const page = location.pathname.split('/').pop() || 'index.html';
  const lien = ([h, t], mobile) =>
    `<a href="${h}" class="${mobile ? 'block py-2' : ''} ${page === h ? 'text-blue-300' : 'hover:text-blue-300'} transition">${t}</a>`;

  const header = document.getElementById('app-header');
  if (header) header.innerHTML = `
  <header class="bg-blue-900 text-white shadow-md sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
      <a href="index.html" class="flex items-center space-x-3">
        <div class="bg-white text-blue-900 font-bold p-2 rounded-lg text-xl"><i class="fa-solid fa-graduation-cap"></i></div>
        <div><span class="text-xl font-extrabold tracking-wide">CSP ASSO</span><p class="text-xs text-blue-200">Excellence &amp; Discipline</p></div>
      </a>
      <nav class="hidden md:flex space-x-6 font-medium">${liens.map((l) => lien(l)).join('')}</nav>
      <div class="flex items-center space-x-2">
        <a href="login.html" class="bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg font-medium shadow transition flex items-center space-x-2">
          <i class="fa-solid fa-user-lock"></i><span class="hidden sm:inline">Espace Notes</span>
        </a>
        <button id="menu-btn" aria-label="Menu" class="md:hidden px-3 py-2 rounded-lg hover:bg-blue-800"><i class="fa-solid fa-bars"></i></button>
      </div>
    </div>
    <nav id="menu-mobile" class="hidden md:hidden px-4 pb-3 font-medium border-t border-blue-800">${liens.map((l) => lien(l, true)).join('')}</nav>
  </header>`;
  const btn = document.getElementById('menu-btn');
  if (btn) btn.addEventListener('click', () => document.getElementById('menu-mobile').classList.toggle('hidden'));

  const footer = document.getElementById('app-footer');
  if (footer) footer.innerHTML = `
  <footer class="bg-blue-950 text-white py-6 text-center mt-8">
    <p>&copy; 2026 CSP ASSO - Tous droits réservés.</p>
  </footer>`;
})();
