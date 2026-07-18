# RESEARCH PROTOCOL — règles anti-auto-illusion

Ce protocole encadre tout usage futur du laboratoire. Il est volontairement
plus strict que les habitudes courantes de backtesting.

## 1. Aucune optimisation sur le test

- Le segment de test final ne sert **jamais** à choisir des paramètres, une
  stratégie, un seuil ou un modèle.
- Phase 1 : les quatre baselines ont des paramètres **fixes**
  (`baseline-configs.v1.json`); aucun grid search, aucun classement de
  configurations, aucun « meilleur modèle ».

## 2. Séparation train / validation / test

- Split strictement chronologique (`chronologicalSplit`) : chaque date de
  train précède chaque date de validation, qui précède chaque date de test.
- La validation sert aux itérations; le test final est consommé une seule
  fois, à la toute fin d'un cycle de recherche.

## 3. Walk-forward

- Fenêtres expanding ou rolling (`walkForward.mjs`), le test avançant sans
  chevauchement; `validateWindows` vérifie structurellement que le train se
  termine toujours avant le test.
- **Purge** : retirer du train les observations dont l'horizon de label
  chevauche le début du test. **Embargo** : retirer les observations juste
  après la fin du test (contamination retour).

## 4. Cohortes

- Analyser les résultats par cohorte de l'univers
  (`research-universe.v1.json`) : semis IA, infrastructure IA, plateformes,
  spéculatif/quantique, ETF, contrôles non-IA.
- **Les ETF à levier (TQQQ/TECL/SOXL) forment une cohorte séparée** : leur
  décroissance de levier (volatility drag) rend toute comparaison directe
  avec les actions non pertinente. Le pilote Phase 1 l'illustre déjà.
- Les contrôles non-IA servent à distinguer « la stratégie marche » de
  « le secteur IA a monté ».

## 5. Biais de survivance

- L'univers V1 est construit en 2026 avec des titres existants en 2026 :
  il est **survivor-biased par construction**. Toute conclusion historique
  doit le mentionner. Une correction (univers point-in-time) est un travail
  de phase ultérieure.

## 6. Coûts

- Toujours inclure commissions et slippage (modèles configurables,
  valeurs par défaut documentées comme exemples, pas comme vérité).
- Toujours rapporter brut ET net. Une stratégie qui ne survit pas à des
  coûts réalistes n'existe pas.

## 7. Baselines obligatoires

- Toute stratégie candidate doit être comparée à B0 (buy & hold), B1 (MA50),
  B2 (EMA21/50) et B3 (Trend+ATR 2,5) sur les mêmes données, les mêmes
  coûts et les mêmes fenêtres. Battre le cash ne suffit pas; battre B0
  net de coûts sur plusieurs fenêtres hors échantillon est le minimum.

## 8. Critères avant promotion en « shadow mode »

Une stratégie ne peut être envisagée pour un futur shadow mode (hors
périmètre Phase 1) que si TOUTES ces conditions sont réunies :

1. règles causales intégralement respectées (suite anti-look-ahead verte);
2. résultats positifs nets de coûts sur walk-forward avec purge/embargo,
   sans avoir touché au test final pendant le développement;
3. robustesse par cohorte (pas seulement une cohorte chanceuse);
4. robustesse aux perturbations de coûts (x2 slippage) et aux fenêtres;
5. nombre de trades suffisant pour une signification minimale;
6. drawdown et exposition compatibles avec l'usage visé (support Wheel);
7. documentation complète : hypothèses, limites, dates, hash de résultats;
8. revue indépendante (audit séparé) avant toute exposition à un flux réel.

Même en shadow mode, aucun ordre réel : observation seulement.

## 9. Interdits permanents du laboratoire

- Pas d'appel réseau, pas de téléchargement, pas d'IBKR, pas de Yahoo.
- Pas d'écriture hors chemin explicite (`--output`), pas de modification
  des sources de données.
- Pas d'import de code de production, pas d'export vers la production.
- Pas de présentation d'un résultat de laboratoire comme une recommandation.
