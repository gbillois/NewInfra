# Cyber News Aggregator

Petit aggregateur de news cybersécurité déployé sur **Cloudflare Pages +
D1 + Pages Functions**. Inspiration : des sites comme `kordon.app` qui
publient une synthèse quotidienne croisant plusieurs articles.

## Ce que fait l'app

1. **Collecte** : toutes les heures, chaque flux RSS/Atom activé est
   récupéré et les nouveaux articles insérés dans D1 (table `articles`).
2. **Synthèse LLM multi-articles** : à la demande (bouton *Rafraîchir*)
   ou via cron (quotidien / hebdo / bi-mensuel / mensuel), un LLM
   regroupe les articles de la fenêtre par thème et produit une
   synthèse Markdown avec citations vers les sources.
3. **UI** : page d'accueil avec sélecteur de période (24h / 7j / 15j /
   30j), rendu Markdown de la synthèse, liste des articles sources.
4. **Settings** : choix du provider LLM (Workers AI / Anthropic /
   OpenAI), CRUD des flux, import/export OPML et JSON.

## Architecture

```
Cloudflare Pages (static HTML/JS/CSS)
  ├─ index.html + app.js          → home (synthèse + refresh)
  ├─ settings.html + settings.js  → flux + provider LLM
  └─ style.css

functions/
  ├─ _lib/              → modules partagés (pas d'onRequest, non routés)
  │    ├─ rss.js        → parseur RSS 2.0 / Atom 1.0
  │    ├─ llm.js        → abstraction Workers AI / Anthropic / OpenAI
  │    ├─ period.js     → calcul des fenêtres day/week/fortnight/month
  │    ├─ db.js         → helpers D1
  │    ├─ collect.js    → fetch + upsert des flux
  │    └─ synthesize.js → prompt + appel LLM + persistance
  └─ api/
       ├─ feeds/[id].js · feeds/index.js · feeds/export.js · feeds/import.js
       ├─ articles.js
       ├─ syntheses.js
       ├─ settings.js
       ├─ refresh.js              → bouton UI (collect + synth, protégé par cooldown)
       └─ cron/collect.js · cron/synthesize.js  → protégés par CRON_SECRET

migrations/
  ├─ 0001_init.sql            → table "content" (legacy, ne fait rien)
  └─ 0002_news_schema.sql     → feeds, articles, syntheses, settings + seed

.github/workflows/
  ├─ deploy.yml               → build + deploy Pages (smoke test inclus)
  └─ cron.yml                 → collecte horaire + synthèses programmées
```

## Configuration à faire dans Cloudflare

Secrets (**Pages project → Settings → Environment variables**, chiffrés) :

| Secret                | Requis si…                 | Rôle |
|-----------------------|----------------------------|------|
| `APP_PASSWORD`        | production                 | Mot de passe partagé pour l'accès web. Si absent, l'app est publique (utile pour le premier déploiement). |
| `CRON_SECRET`         | production                 | Protège `/api/cron/*`. Doit correspondre au secret GitHub Actions. |
| `ANTHROPIC_API_KEY`   | provider = `anthropic`     | Clé API Anthropic. |
| `OPENAI_API_KEY`      | provider = `openai`        | Clé API OpenAI. |

Bindings (déjà dans `wrangler.toml` et injectés par `deploy.yml`) :

- `DB` : base D1 `newinfragg-db` (créée automatiquement au premier run).
- `AI` : binding Workers AI (fonctionne out-of-the-box si Workers AI
  est activé sur le compte Cloudflare).

## Configuration à faire dans GitHub

Dans **Settings → Secrets and variables → Actions** :

- Secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (déjà nécessaires
  pour le déploiement).
- Secret `CRON_SECRET` avec la même valeur que côté Cloudflare Pages.
- Variable (optionnelle) `APP_BASE_URL` pointant vers l'URL de prod
  (par défaut `https://newinfragg.pages.dev`).

## Endpoints API

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/feeds` | Liste des flux. |
| POST | `/api/feeds` | Ajoute un flux `{url, name}`. |
| PATCH | `/api/feeds/:id` | Active/désactive, renomme, change l'URL. |
| DELETE | `/api/feeds/:id` | Supprime un flux (et ses articles, ON DELETE CASCADE). |
| GET | `/api/feeds/export?format=opml\|json` | Export. |
| POST | `/api/feeds/import` | Import OPML (XML) ou JSON. |
| GET | `/api/articles?period=…` ou `?ids=…` | Liste d'articles. |
| GET | `/api/syntheses?period=…` | Récupère la synthèse stockée pour la période en cours. |
| GET | `/api/settings` | Paramètres + capacités du déploiement (backends disponibles). |
| PUT | `/api/settings` | Met à jour `{llm_provider, llm_model, language}`. |
| POST | `/api/refresh` | Bouton UI : `{period, collect?}`, cooldown 30s. |
| POST | `/api/cron/collect` | Collecte tous les flux (cron). |
| POST | `/api/cron/synthesize?period=…` | Re-génère la synthèse (cron). |

## Schéma D1

```sql
feeds      (id, url, name, enabled, last_fetched_at, last_status, created_at)
articles   (id, feed_id, guid, url, title, author, summary, content,
            published_at, fetched_at)   -- UNIQUE(feed_id, guid)
syntheses  (id, period, period_start, period_end, content, article_ids,
            model, provider, article_count, created_at)
            -- UNIQUE(period, period_start)
settings   (key, value, updated_at)
```

## Déploiement initial

1. Pousser la branche — `deploy.yml` crée la DB, applique les deux
   migrations, déploie et vérifie la home + `/api/feeds` +
   `/api/syntheses?period=day`.
2. Ajouter les secrets ci-dessus côté Cloudflare et GitHub.
3. Ouvrir `/` et cliquer **Rafraîchir la synthèse** pour déclencher la
   première collecte + synthèse (30–60 s).
4. À partir de là, `cron.yml` prend le relais.
