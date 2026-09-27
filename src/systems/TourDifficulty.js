/**
 * TourDifficulty — a Junior Tour opponent's AI table for the tennis session.
 *
 *   import { tourOpponentDifficulty } from '../systems/TourDifficulty.js';
 *   const diff = tourOpponentDifficulty(matchSpec.opponent, matchSpec.surface);
 *   session.ai.setCustomDifficulty(diff, matchSpec.surface);
 *
 * The result is shaped exactly like a TennisAI DIFFICULTY entry after difficultyFor(key, surface):
 * Rafa's easy / medium / hard tables for that surface are interpolated by the opponent's
 * effective rating (TourField.RATING_ANCHORS: ~1100 ≈ Easy, ~1450 ≈ Medium, ~1750 ≈ Hard,
 * extrapolated a little beyond Hard for the best juniors and the Pro Circuit), then the play
 * style's modifiers (tour.json → styles[style].ai, carried on the opponent as `styleMods`) and the
 * player's own (`aiMods`, e.g. Theo's flat backhand) are applied. The SURFACE_STYLE is already in
 * (surfaceApplied: true, surface set) — setCustomDifficulty must not apply it again. Extra keys:
 * label (the opponent's short name), tour: true, rating, level, styleKey, opponentId.
 *
 * This module imports TennisAI (three.js) and is meant for the browser session; TourSystem itself
 * stays Node-importable and never imports it.
 */

import { DIFFICULTY, difficultyFor } from '../tennis/TennisAI.js';
import { blendDifficulty, levelLabel, RATING_ANCHORS } from './TourField.js';

const SURFACES = ['hard', 'clay', 'grass'];

function anchor(key, surface) {
  try {
    if (typeof difficultyFor === 'function') return difficultyFor(key, surface);
  } catch (e) { /* fall back to the plain table */ }
  const d = DIFFICULTY[key] || DIFFICULTY.medium;
  return JSON.parse(JSON.stringify(d));
}

/**
 * @param {object} opponent  matchSpec.opponent ({ rating, effRating, style, styleMods, aiMods, short, id })
 * @param {string} surface   'hard' | 'clay' | 'grass'
 * @returns {object} a fresh DIFFICULTY-like object (the DIFFICULTY table is never mutated)
 */
export function tourOpponentDifficulty(opponent, surface = 'hard') {
  const o = opponent && typeof opponent === 'object' ? opponent : {};
  const s = SURFACES.includes(surface) ? surface : 'hard';
  const anchors = { easy: anchor('easy', s), medium: anchor('medium', s), hard: anchor('hard', s) };
  const rating = Number.isFinite(o.effRating) ? o.effRating : Number.isFinite(o.rating) ? o.rating : RATING_ANCHORS.medium;
  const mods = [];
  if (o.styleMods && typeof o.styleMods === 'object') mods.push(o.styleMods);
  if (o.aiMods && typeof o.aiMods === 'object') mods.push(o.aiMods);
  return blendDifficulty(anchors, rating, mods, {
    label: o.short || o.name || 'Tour player',
    tour: true,
    surface: s,
    surfaceApplied: true,
    rating: Math.round(rating),
    level: levelLabel(rating),
    styleKey: o.style || null,
    opponentId: o.id || null,
  });
}
