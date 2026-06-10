// NewsRadar — dashboard des tendances.

const $ = (id) => document.getElementById(id);
const WINDOW_LABELS = { '7d': '7 derniers jours', '30d': '30 derniers jours', '180d': '6 derniers mois', '365d': '12 derniers mois', custom: 'période personnalisée' };

let currentWindow = localStorage.getItem('nr_window') || '7d';
let currentTrends = [];

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { location.href = '/login'; throw new Error('auth'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtDate(unix) {
  return new Date(unix * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function setState(html) { $('trends').innerHTML = html; }

function loadingState(msg) {
  setState(`<div class="state"><div class="spin"></div><em>${esc(msg)}</em>
    <span class="micro">L'analyse d'une nouvelle période peut prendre jusqu'à une minute</span></div>`);
}

async function loadTrends({ force = false, from = null, to = null } = {}) {
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.window === currentWindow));
  $('customRange').classList.toggle('open', currentWindow === 'custom');
  if (currentWindow === 'custom' && (!from || !to)) { setState(''); $('metaLine').innerHTML = ''; return; }

  loadingState('Analyse des tendances en cours…');
  $('refreshBtn').disabled = true;
  try {
    let qs = currentWindow === 'custom'
      ? `from=${from}&to=${to}`
      : `window=${currentWindow}`;
    if (force) qs += '&refresh=1';
    const { set, trends } = await api(`/api/trends?${qs}`);
    currentTrends = trends;
    renderMeta(set);
    renderTrends(trends);
  } catch (e) {
    if (e.message !== 'auth') setState(`<div class="state"><em>Erreur</em><span class="micro">${esc(e.message)}</span></div>`);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

function renderMeta(set) {
  $('metaLine').innerHTML = `
    <span class="micro">${esc(WINDOW_LABELS[currentWindow] || set.window_key)} · ${fmtDate(set.period_start)} → ${fmtDate(set.period_end)}</span>
    <span class="micro">${set.article_count} actualités analysées</span>
    <span class="micro">généré le ${new Date(set.generated_at * 1000).toLocaleString('fr-FR')}</span>
    <span class="micro">moteur : ${esc(set.provider || '—')}</span>`;
}

function renderTrends(trends) {
  if (!trends.length) {
    setState(`<div class="state"><em>Pas encore de tendances</em>
      <span class="micro">Lancez une collecte depuis les réglages, puis recalculez.</span></div>`);
    return;
  }
  setState(trends.map((t, i) => `
    <article class="trend" data-id="${t.id}">
      <div class="rank">${String(i + 1).padStart(2, '0')}</div>
      <div>
        <h2>${esc(t.title)}</h2>
        <p class="summary">${esc(t.summary)}</p>
      </div>
      <div class="side">
        <span class="tag ${esc(t.theme || 'autre')}">${esc(t.theme || 'autre')}</span>
        <div class="score">
          <span class="num">${Math.round(t.score)}</span>
          <div class="meter"><i style="width:${Math.round(t.score)}%"></i></div>
        </div>
        <span class="count">${t.article_count} article${t.article_count > 1 ? 's' : ''} →</span>
      </div>
    </article>`).join(''));
  document.querySelectorAll('.trend').forEach((el) =>
    el.addEventListener('click', () => openDrawer(Number(el.dataset.id))));
}

async function openDrawer(trendId) {
  const t = currentTrends.find((x) => x.id === trendId);
  if (!t) return;
  $('drawerTitle').textContent = t.title;
  $('drawerSummary').textContent = t.summary || '';
  $('drawerMeta').textContent = `${(t.theme || 'autre').toUpperCase()} · score ${Math.round(t.score)}`;
  $('drawerList').innerHTML = '<div class="state"><div class="spin"></div></div>';
  $('overlay').classList.add('open');
  $('drawer').classList.add('open');
  try {
    const { articles } = await api(`/api/trends/${trendId}/articles`);
    $('drawerList').innerHTML = articles.length
      ? articles.map((a) => `
        <a class="article" href="${esc(a.url)}" target="_blank" rel="noopener">
          <h4>${esc(a.title)}</h4>
          <span class="src"><b>${esc(a.source)}</b> · ${fmtDate(a.published_at)}${a.duplicate_of ? ' · repris' : ''}</span>
        </a>`).join('')
      : '<div class="state"><span class="micro">Aucun article lié</span></div>';
  } catch (e) {
    $('drawerList').innerHTML = `<div class="state"><span class="micro">${esc(e.message)}</span></div>`;
  }
}

function closeDrawer() {
  $('overlay').classList.remove('open');
  $('drawer').classList.remove('open');
}

// ---- wiring

document.querySelectorAll('.chip').forEach((c) =>
  c.addEventListener('click', () => {
    currentWindow = c.dataset.window;
    localStorage.setItem('nr_window', currentWindow);
    loadTrends();
  }));

$('applyCustom').addEventListener('click', () => {
  const from = $('dateFrom').value;
  const to = $('dateTo').value;
  if (from && to) loadTrends({ from, to });
});

$('refreshBtn').addEventListener('click', () => {
  if (currentWindow === 'custom') {
    const from = $('dateFrom').value, to = $('dateTo').value;
    if (from && to) loadTrends({ force: true, from, to });
  } else {
    loadTrends({ force: true });
  }
});

$('overlay').addEventListener('click', closeDrawer);
$('drawerClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// Dates par défaut de la période personnalisée : 90 derniers jours.
const today = new Date();
$('dateTo').value = today.toISOString().slice(0, 10);
$('dateFrom').value = new Date(today - 90 * 86400e3).toISOString().slice(0, 10);

loadTrends();
