# ARCHITECTURE_CURRENT

## Vue d'ensemble

Le projet est un dashboard Wheel Strategy en architecture full JavaScript avec:
- un backend Node.js/Express pour le scan et les endpoints de données;
- un frontend React/Vite pour l'affichage et l'interaction utilisateur.

## Stack detectee

- Backend: Node.js (ESM), Express, CORS, Zod, Yahoo Finance (`yahoo-finance2`), MCP SDK.
- Frontend: React 18, Vite, framer-motion, lucide-react.

## Points d'entree

- Backend: `server.js` (script `npm start` du `package.json` racine).
- Frontend: `wheel-dashboard/src/main.jsx` (monte `dashboard.jsx`).

## Backend actuel

### Role principal

Le backend centralise:
- recuperation des donnees Yahoo (quote, options, historique);
- calculs financiers (expected move, selection strikes CSP, filtres liquidite/tradability);
- orchestration du scanner shortlist;
- exposition REST + MCP.

### Routes principales

- `GET /health`
- `GET /tools`
- `POST /tools/get_quote`
- `POST /tools/get_option_expirations`
- `POST /tools/get_option_chain`
- `POST /tools/get_expected_move`
- `POST /tools/get_best_strike`
- `POST /tools/get_technicals`
- `POST /tools/get_support_resistance`
- `POST /tools/analyze_trade_setup`
- `POST /scan_shortlist`
- `GET /mcp-info`
- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`

### Sources de donnees

- Source marche principale: Yahoo Finance via `yahoo-finance2`.
- Aucun flux de trading automatique detecte.
- Aucune logique Buy/Sell ou passage d'ordre exposee.

## Frontend actuel

### Organisation

- Le composant principal de l'UI est `wheel-dashboard/src/dashboard.jsx` (fichier monolithique).
- Le frontend consomme le backend local via `http://localhost:3001`.

### Composants/fonctions UI majeurs

- Dashboard principal (shortlist, filtres, stats, cartes opportunites).
- Modal de detail live avec appels backend.
- Bloc de combinaisons capital.
- Fallback snapshot local via `wheel-dashboard/src/data/wheelShortlist.js` si scan backend indisponible.

## Cartographie de responsabilites (etat actuel)

- `server.js`: point d'entree backend + routes + logique metier de scan/calculee.
- `wheel-dashboard/src/dashboard.jsx`: rendu UI principal + interactions + consommation API backend.
- `analyze-list.js`: script d'analyse hors runtime principal.

## Constat architectural

- Le projet fonctionne, mais reste fortement couple autour de gros fichiers (`server.js`, `dashboard.jsx`).
- Le backend et le frontend sont deja separes en deux apps, ce qui facilite un refactor progressif.
- Les interfaces API existent deja et doivent etre preservees pour une migration modulaire sans casse.
