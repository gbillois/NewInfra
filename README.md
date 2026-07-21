# NewsRadar

Agrégateur de news avec **détection de tendances multi-périodes** et
dédoublonnage, pensé pour préparer une revue d'actualité mensuelle/annuelle.
Déployé sur **Cloudflare Workers + D1 + Workers AI**, avec **Claude** en
option pour la qualité du nommage des tendances.

## Ce que fait l'app

1. **Collecte** (manuelle pour le moment) : chaque flux RSS/Atom actif est récupéré,
   les nouveaux articles insérés dans D1.
2. **Embeddings + dédoublonnage** : chaque article est vectorisé
   (`@cf/baai/bge-m3`, multilingue FR/EN). Les quasi-doublons inter-sources
   (cosinus ≥ 0,92 dans une fenêtre de ±4 jours) sont rattachés à un article
   canonique.
3. **Tendances** : un LLM regroupe les actualités dédupliquées d'une période
   en tendances nommées en français, avec résumé, thème, score d'importance
   et liste d'articles. **Un article peut appartenir à plusieurs tendances.**
   - Fenêtres courtes (7 j, 30 j, mois calendaire) : analyse directe des titres.
   - Fenêtres longues (6 mois, 12 mois) : agrégation hiérarchique — les
     tendances mensuelles sont fusionnées en **macro-tendances de fond**
     (ex. « La bataille des frontier models et des benchmarks »).
   - Période personnalisée : calculée à la demande depuis le dashboard.
4. **Dashboard** : sélecteur de période, cartes de tendances classées par
   score, clic → panneau listant les articles sources (avec liens).

## Architecture

```
Cloudflare Worker "newsradar"
  ├─ public/            assets statiques (dashboard, réglages, login)
  ├─ src/index.ts       routeur API + auth cookie
  ├─ src/collect.ts     fetch RSS → insert → embeddings → dédoublonnage
  ├─ src/rss.ts         parseur RSS 2.0 / Atom 1.0 sans dépendance
  ├─ src/embed.ts       Workers AI bge-m3 + blobs float32 + cosinus
  ├─ src/llm.ts         Claude (claude-opus-4-8) ou Workers AI (Llama 3.3)
  └─ src/trends.ts      moteur de tendances (court + macro hiérarchique)

D1 "newsradar-db" : feeds, articles (embedding BLOB, duplicate_of),
                    trend_sets, trends, trend_articles, settings
Automatisation : Cron Triggers désactivés temporairement · collecte et
                 recalculs lancés depuis Réglages
```

## Configuration

Secrets **GitHub Actions** (Settings → Secrets and variables → Actions) :

| Secret | Requis | Rôle |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | oui | Déploiement (Workers + D1 + Workers AI). |
| `CLOUDFLARE_ACCOUNT_ID` | oui | Compte Cloudflare cible. |
| `APP_PASSWORD` | recommandé | Mot de passe partagé de l'UI. Si absent, l'app est publique. |
| `ANTHROPIC_API_KEY` | optionnel | Rend les modèles Claude disponibles dans le sélecteur. |
| `OPENAI_API_KEY` | optionnel | Rend les modèles GPT disponibles dans le sélecteur. |
| `OPENROUTER_API_KEY` | optionnel | Rend les modèles OpenRouter disponibles dans le sélecteur. |

Le workflow `deploy.yml` crée la base D1 au premier run, applique les
migrations, déploie le Worker et pousse les secrets applicatifs. Sans clé LLM,
les tendances utilisent Workers AI (Llama 3.3), inclus dans le compte.

## API

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/login` · `/api/logout` | Auth cookie SHA-256(APP_PASSWORD). |
| GET | `/api/status` | Compteurs, dernière collecte, moteur IA actif. |
| GET | `/api/trends?window=7d\|30d\|180d\|365d[&refresh=1]` | Tendances (cache 26 h, recalcul forçable). |
| GET | `/api/trends?from=YYYY-MM-DD&to=YYYY-MM-DD` | Période personnalisée (calcul à la demande). |
| GET | `/api/trends/:id/articles` | Articles d'une tendance. |
| GET/POST | `/api/feeds` · PATCH/DELETE `/api/feeds/:id` | Gestion des flux. |
| POST | `/api/collect` | Collecte immédiate. |
| POST | `/api/recompute` `{window}` | Recalcul forcé d'une fenêtre. |

## Premier démarrage

1. Pousser sur `main` → le workflow déploie tout.
2. Ajouter `APP_PASSWORD` (et idéalement `ANTHROPIC_API_KEY`) dans les
   secrets GitHub, relancer le workflow.
3. Ouvrir l'app → Réglages → **Collecter maintenant**, puis
   **Recalculer 7 jours**. La collecte et les recalculs restent manuels tant
   que les Cron Triggers Cloudflare sont désactivés.

> ⚠️ Le plan **Workers gratuit** limite le CPU à 10 ms par requête ; le
> dédoublonnage vectoriel peut frôler cette limite quand le volume monte.
> Le plan Workers Paid (5 $/mois) lève la contrainte. Les fenêtres longues
> nécessitent quelques mois d'historique avant d'être pertinentes.
