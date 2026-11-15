import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stats } from '../src/stats.js';
import { growth, levelFor, xpForLevel, xpFrom } from '../src/growth.js';

const at = (d) => new Date(2026, 10, d, 12).getTime();

test('level curve', () => {
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(24), 1);
  assert.equal(levelFor(25), 2);
  assert.equal(levelFor(2025), 10);
  for (let n = 1; n < 40; n++) assert.equal(levelFor(xpForLevel(n)), n);
  assert.equal(xpFrom({ prompts: 10, commits: 2, pushes: 1, testsPass: 3, activeDays: 1 }), 10 + 6 + 5 + 6 + 10);
});

test('growth from real counters, with hats', () => {
  let t = at(1);
  const st = new Stats(null, { now: () => t });
  assert.deepEqual(growth(st).hats, []);
  assert.equal(growth(st).level, 1);
  for (const d of [1, 2, 3]) {
    t = at(d);
    for (let i = 0; i < 40; i++) st.record({ session_id: 's', hook_event_name: 'UserPromptSubmit' });
  }
  const g = growth(st);
  assert.equal(g.streak, 3);
  assert.equal(g.bestStreak, 3);
  assert.equal(g.level, 3); // 120 prompts + 3 active days = 150 XP
  assert.ok(g.levelXp <= g.xp && g.xp < g.nextXp);
  assert.deepEqual(g.hats, ['party', 'beanie']);
  t = at(10); // the streak breaks, the best streak (and the beanie) stays
  const later = growth(st);
  assert.equal(later.streak, 0);
  assert.equal(later.bestStreak, 3);
  assert.ok(later.hats.includes('beanie'));
});

test('best streak survives pruning of old days', () => {
  let t = at(1);
  const st = new Stats(null, { now: () => t });
  for (const d of [1, 2, 3, 4]) { t = at(d); st.record({ session_id: 's', hook_event_name: 'UserPromptSubmit' }); }
  assert.equal(st.bestStreak(), 4);
  st.data.days = {};
  assert.equal(st.bestStreak(), 4);
});
