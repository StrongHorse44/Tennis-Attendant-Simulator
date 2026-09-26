/**
 * SmallTalk — picks one line of NPC small talk from npcs.json data. Pure (no DOM / three.js).
 *
 * Pools (all optional, arrays of strings):
 *   greetings                         first chat with this member today (and now and then later)
 *   dialoguePool.satisfied / neutral / unsatisfied   after a mission reaction set their mood
 *   dialoguePool.idle                 personality, club life, other members
 *   dialoguePool.morning / afternoon / evening        by in-game hour (see timeBucket)
 *   dialoguePool.sunny / cloudy / rainy / windy       by current weather
 */

/** 'morning' (< 11:30), 'afternoon' (< 16:30) or 'evening'. */
export function timeBucket(hour) {
  if (!Number.isFinite(hour)) return 'afternoon';
  if (hour < 11.5) return 'morning';
  if (hour < 16.5) return 'afternoon';
  return 'evening';
}

const MOODS = ['satisfied', 'neutral', 'unsatisfied'];
const nonEmpty = (a) => Array.isArray(a) && a.length > 0;

/**
 * @param {object} data     npcs.json entry
 * @param {object} ctx      { mood, moodSet (a reaction set the mood), firstChat, hour, weather, last (text to avoid) }
 * @param {() => number} [rand]
 * @returns {string}
 */
export function pickSmallTalk(data, ctx = {}, rand = Math.random) {
  const d = data || {};
  const pool = d.dialoguePool || {};
  const greetings = nonEmpty(d.greetings) ? d.greetings : null;
  let lines = null;

  if (ctx.firstChat && greetings) lines = greetings;
  if (!lines && ctx.moodSet && MOODS.includes(ctx.mood) && nonEmpty(pool[ctx.mood]) && rand() < 0.45) lines = pool[ctx.mood];

  if (!lines) {
    // Weighted buckets: personality first, then the moment (weather matters more when it's notable)
    const w = ctx.weather;
    const weatherW = w === 'rainy' || w === 'windy' ? 2.2 : w === 'cloudy' ? 0.9 : 0.6;
    const buckets = [
      [pool.idle, 3],
      [pool[w], weatherW],
      [pool[timeBucket(ctx.hour)], 1.4],
      [greetings, 0.6],
    ];
    let total = 0;
    for (const [arr, wt] of buckets) if (nonEmpty(arr)) total += wt;
    let x = rand() * total;
    for (const [arr, wt] of buckets) {
      if (!nonEmpty(arr)) continue;
      x -= wt;
      if (x <= 0) { lines = arr; break; }
    }
    if (!lines) for (const [arr] of buckets) if (nonEmpty(arr)) { lines = arr; break; }
  }
  if (!lines) return 'Hello there!';

  // Don't repeat the last line (small pools can't always help it)
  let i = Math.floor(rand() * lines.length);
  if (lines.length > 1 && lines[i] === ctx.last) i = (i + 1 + Math.floor(rand() * (lines.length - 1))) % lines.length;
  return String(lines[i]);
}
