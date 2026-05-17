/**
 * Symboles exclus de l’univers fusionné (watchlist, scan Yahoo) — liste centrale.
 * À utiliser pour tout ticker qu’on ne veut plus jamais traiter dans le pipeline Wheel,
 * sans dupliquer la logique entre master et fichiers legacy.
 *
 * BRK.B excluded because price above strategy maxPrice and Yahoo quote validation edge-case.
 */

export const WHEEL_UNIVERSE_EXCLUDED_SYMBOLS = new Set(["BRK.B"]);
