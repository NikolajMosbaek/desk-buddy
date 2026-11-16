// The buddy grows with you: experience from the lifetime counters, a level from that,
// and hats unlocked by milestones. Pure functions over Stats, so they are easy to test.

// Experience per thing done. Prompts are the steady drip; shipping is worth more.
const XP = { prompts: 1, testsPass: 2, commits: 3, pushes: 5, activeDays: 10 };

export function xpFrom(life) {
  let xp = 0;
  for (const [k, w] of Object.entries(XP)) xp += (Number(life[k]) || 0) * w;
  return xp;
}

// Level n needs 25·(n-1)² XP: level 2 at 25, 5 at 400, 10 at 2025, 20 at 9025.
// Early levels come in the first days; later ones take weeks of regular use.
export const xpForLevel = (n) => 25 * (n - 1) ** 2;
export const levelFor = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1;

// In unlock order. `test` gets the lifetime counters plus level and streaks.
export const HATS = [
  { id: 'party', test: (g) => g.level >= 3 },
  { id: 'beanie', test: (g) => g.bestStreak >= 3 },
  { id: 'headphones', test: (g) => g.commits >= 50 },
  { id: 'crown', test: (g) => g.level >= 10 },
];

export function growth(stats) {
  const life = stats.lifetime();
  const xp = xpFrom(life);
  const level = levelFor(xp);
  const g = { ...life, level, streak: stats.streak(), bestStreak: stats.bestStreak() };
  const awarded = stats.awardedHats();
  return {
    level,
    xp,
    levelXp: xpForLevel(level),
    nextXp: xpForLevel(level + 1),
    streak: g.streak,
    bestStreak: g.bestStreak,
    // Earned hats stay earned, listed in the order they were earned (newest last).
    hats: [...new Set([...awarded, ...HATS.filter((h) => h.test(g)).map((h) => h.id)])],
  };
}
