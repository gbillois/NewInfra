// NewsRadar — réglages : flux, collecte, état.

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { location.href = '/login'; throw new Error('auth'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function notice(msg) { $('notice').textContent = msg; }

async function loadStatus() {
  const s = await api('/api/status');
  const last = s.last_collect ? new Date(s.last_collect * 1000).toLocaleString('fr-FR') : '—';
  $('stats').innerHTML = `
    <div class="stat"><span class="v">${s.articles ?? 0}</span><span class="l">articles</span></div>
    <div class="stat"><span class="v">${s.duplicates ?? 0}</span><span class="l">doublons détectés</span></div>
    <div class="stat"><span class="v">${s.feeds ?? 0}</span><span class="l">flux actifs</span></div>
    <div class="stat"><span class="v" style="font-size:14px;line-height:2">${last}</span><span class="l">dernière collecte</span></div>
    <div class="stat"><span class="v" style="font-size:14px;line-height:2">${esc([s.configured_provider, s.configured_model].filter(Boolean).join(' / '))}</span><span class="l">moteur configuré</span></div>
    <div class="stat"><span class="v" style="font-size:14px;line-height:2">${esc([s.last_trends_provider, s.last_trends_model].filter(Boolean).join(' / ') || '—')}</span><span class="l">dernières tendances</span></div>`;
}

async function loadLlmSettings() {
  const settings = await api('/api/llm-settings');
  const select = $('llmModel');
  select.innerHTML = settings.models.map((model) =>
    `<option value="${esc(model.id)}">${esc(model.provider)} · ${esc(model.name)} — ${esc(model.description)}</option>`
  ).join('');
  select.value = settings.model;
  select.disabled = settings.models.length === 0;
  $('saveLlmModel').disabled = settings.models.length === 0;
  $('llmNotice').textContent = settings.models.length
    ? 'Le prochain recalcul utilisera le modèle sélectionné.'
    : 'Ajoute ANTHROPIC_API_KEY ou OPENAI_API_KEY pour sélectionner un modèle.';
}

$('saveLlmModel').addEventListener('click', async () => {
  $('saveLlmModel').disabled = true;
  try {
    const result = await api('/api/llm-settings', {
      method: 'PUT',
      body: JSON.stringify({ model: $('llmModel').value }),
    });
    $('llmNotice').textContent = `${result.model} enregistré. Recalcule les tendances pour appliquer ce choix.`;
    loadStatus();
  } catch (e) { $('llmNotice').textContent = `Erreur : ${e.message}`; }
  finally { $('saveLlmModel').disabled = false; }
});

async function loadFeeds() {
  const { feeds } = await api('/api/feeds');
  $('feeds').innerHTML = feeds.map((f) => `
    <div class="feed-row ${f.enabled ? '' : 'disabled'}" data-id="${f.id}">
      <div class="info">
        <b>${esc(f.name)}</b>
        <span>${esc(f.url)}${f.last_status && f.last_status !== 'ok' ? ` — ⚠ ${esc(f.last_status)}` : ''}</span>
      </div>
      <span class="nb">${f.article_count} art.</span>
      <div class="actions">
        <button class="btn small toggle">${f.enabled ? 'Désactiver' : 'Activer'}</button>
        <button class="btn small danger del">Supprimer</button>
      </div>
    </div>`).join('');

  document.querySelectorAll('.feed-row .toggle').forEach((b) =>
    b.addEventListener('click', async (e) => {
      const row = e.target.closest('.feed-row');
      const enabled = !row.classList.contains('disabled');
      await api(`/api/feeds/${row.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !enabled }) });
      loadFeeds();
    }));
  document.querySelectorAll('.feed-row .del').forEach((b) =>
    b.addEventListener('click', async (e) => {
      const row = e.target.closest('.feed-row');
      if (!confirm('Supprimer ce flux et tous ses articles ?')) return;
      await api(`/api/feeds/${row.dataset.id}`, { method: 'DELETE' });
      loadFeeds();
      loadStatus();
    }));
}

$('addFeed').addEventListener('click', async () => {
  const url = $('feedUrl').value.trim();
  if (!url) return;
  try {
    await api('/api/feeds', { method: 'POST', body: JSON.stringify({ url, name: $('feedName').value.trim() }) });
    $('feedUrl').value = '';
    $('feedName').value = '';
    loadFeeds();
  } catch (e) { notice(e.message); }
});

$('collectBtn').addEventListener('click', async () => {
  $('collectBtn').disabled = true;
  notice('Collecte en cours…');
  try {
    const { stats } = await api('/api/collect', { method: 'POST' });
    notice(`Collecte terminée : ${stats.inserted} nouveaux articles, ${stats.embedded} vectorisés, ${stats.duplicates} doublons.` +
      (stats.errors.length ? ` Erreurs : ${stats.errors.join(' ; ')}` : ''));
    loadStatus();
    loadFeeds();
  } catch (e) { notice(`Erreur : ${e.message}`); }
  finally { $('collectBtn').disabled = false; }
});

for (const [btn, win] of [['recompute7', '7d'], ['recompute30', '30d']]) {
  $(btn).addEventListener('click', async () => {
    $(btn).disabled = true;
    notice(`Recalcul des tendances ${win}…`);
    try {
      const { trends } = await api('/api/recompute', { method: 'POST', body: JSON.stringify({ window: win }) });
      notice(`${trends.length} tendances recalculées.`);
    } catch (e) { notice(`Erreur : ${e.message}`); }
    finally { $(btn).disabled = false; }
  });
}

$('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
});

loadStatus();
loadLlmSettings();
loadFeeds();
