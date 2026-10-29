import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import type { Dashboard, DrinkEvent } from '../../shared/dashboard';
import type { CompanionState, Snapshot } from '../src/types';
import { amount, characters, dayLabel, deviceStatus, framePath, frameStyle, recentDrink } from '../src/display';

const event = (id: string, time: string, changes: Partial<DrinkEvent> = {}): DrinkEvent => ({
  id, kind: 'drink', amountMl: 30, beforeGrams: 200, afterGrams: 170,
  occurredAt: time, revokedAt: null, bindingId: 'binding', ...changes,
});

function dashboard(events: DrinkEvent[] = []): Dashboard {
  return {
    date: '2026-10-22', timeZone: 'Asia/Shanghai',
    totals: { drinkMl: 0, refillMl: 0, drinkCount: 0 }, week: [], events, device: null,
  };
}

test('latest drink excludes revoked and refill records even when the response is unordered', () => {
  const latest = event('latest', '2026-10-22T03:00:00Z');
  const result = recentDrink(dashboard([
    event('older', '2026-10-22T01:00:00Z'),
    event('refill', '2026-10-22T05:00:00Z', { kind: 'refill' }),
    latest,
    event('revoked', '2026-10-22T06:00:00Z', { revokedAt: '2026-10-22T06:01:00Z' }),
    event('invalid', 'invalid'),
  ]));
  assert.equal(result?.id, 'latest');
  assert.equal(recentDrink(dashboard([])), null);
});

test('cached data keeps its actual date after the server timezone crosses midnight', () => {
  assert.equal(dayLabel(dashboard(), new Date('2026-10-22T15:59:59Z')), '今日饮水');
  assert.equal(dayLabel(dashboard(), new Date('2026-10-22T16:00:00Z')), '2026/10/22 饮水');
});

test('missing data is different from a measured zero and preserves decimals', () => {
  assert.equal(amount(undefined), '—');
  assert.equal(amount(Number.NaN), '—');
  assert.equal(amount(0), '0');
  assert.equal(amount(30.5), '30.5');
});

test('cached online device cannot look connected after losing cloud access', () => {
  const value = {
    session: { user: { id: 'user', username: 'user', role: 'user' } },
    connection: 'offline', dashboard: { device: { online: true } },
  } as Snapshot;
  assert.equal(deviceStatus(value), '云端连接中断');
});

test('character switches resolve bundled assets in every state and preserve capybara animation', () => {
  const states: CompanionState[] = ['idle', 'working', 'sleeping', 'drinking', 'reminding'];
  for (const character of characters) {
    for (const state of states) {
      const paths = [0, 1, 2, 3].map(frame => framePath(state, frame, character.id));
      for (const path of paths) assert.ok(existsSync(new URL(`../public${path}`, import.meta.url)), path);
      assert.equal(new Set(paths).size, character.id === 'capybara' && state !== 'idle' ? 4 : 1);
    }
  }
  assert.equal(framePath('idle', 3), '/companion/characters/robot.png');
  assert.equal(framePath('idle', 3, 'capybara'), '/companion/working-0.png');
  assert.equal(framePath('sleeping', -1, 'capybara'), '/companion/sleeping-0.png');
  assert.equal(framePath('drinking', 5, 'capybara'), '/companion/drinking-3.png');
  assert.equal(frameStyle(), undefined);
  assert.equal(frameStyle('robot'), undefined);
  assert.equal(frameStyle('cat')?.objectFit, 'cover');
  assert.equal(new Set(characters.map(character => framePath('idle', 0, character.id))).size, 6);
});
