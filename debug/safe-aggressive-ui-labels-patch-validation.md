# Validation patch UI SAFE vs AGRESSIF

- Date: 2026-06-07T10:47:53.691Z
- Statut global: OK
- Fichier UI modifié: wheel-dashboard/src/components/JournalPopPanel.jsx

## Portée

- UI seulement: OK
- Calculs SAFE/AGRESSIF non modifiés: OK
- Backend/scanner/scoring E2b/DB/Pine non modifiés: OK
- Aucun git add: OK
- Aucun commit: OK

## Libellés

- `AGRESSIF confirmés` remplacé par `AGRESSIF admissibles n≥5`: OK
- `SAFE confirmés` remplacé par `SAFE admissibles n≥5`: OK
- Mentions `Modes confirmés` supprimées du bloc ciblé: OK
- Note `n = observations normalisées` ajoutée: OK
- Légende `<5 / 5–9 / ≥10` présente: OK
- Fallback expirations communes: `Voir audit pairé pour expirations communes.`

## Validations

- `npx.cmd vite build` dans `wheel-dashboard`: OK
- `git diff --check`: OK

## Risques restants

- Les libellés KPI plus longs peuvent se répartir sur deux lignes selon la largeur disponible.
- Aucun champ payload explicite d'expirations communes n'a été utilisé; l'UI affiche donc la note générique d'audit pairé.

