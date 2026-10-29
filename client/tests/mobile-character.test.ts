import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreCharacter } from '../src/mobile/character';
import type { Character } from '../src/types';

function storage(value: string | null) {
  const values = new Map(value === null ? [] : [['water-mobile:character', value]]);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('native character wins over stale web storage, including an explicit capybara selection', async () => {
  for (const current of ['robot', 'cat', 'dog', 'girl', 'boy', 'capybara']) {
    const legacy = storage('girl');
    const selected = await restoreCharacter(current, legacy, async () => { throw new Error('must not save'); });
    assert.equal(selected, current);
    assert.equal(legacy.values.size, 0);
  }
});

test('migrating a local choice waits for native persistence before deleting it', async () => {
  for (const previous of ['robot', 'cat', 'dog', 'girl', 'boy', 'capybara'] as Character[]) {
    const legacy = storage(previous);
    let native: Character | null = null;
    const selected = await restoreCharacter(null, legacy, async value => {
      assert.equal(legacy.getItem('water-mobile:character'), previous);
      native = value;
      return value;
    });
    assert.equal(native, previous);
    assert.equal(selected, previous);
    assert.equal(legacy.values.size, 0);
  }
});

test('a failed native save keeps the old choice available for retry', async () => {
  const legacy = storage('dog');
  await assert.rejects(restoreCharacter(null, legacy, async () => { throw new Error('save failed'); }), /save failed/);
  assert.equal(legacy.getItem('water-mobile:character'), 'dog');
  assert.equal(await restoreCharacter(null, legacy, async value => value), 'dog');
  assert.equal(legacy.values.size, 0);
});

test('missing, unknown or unavailable old storage falls back without overwriting native preferences', async () => {
  const save = async (): Promise<Character> => { throw new Error('must not save'); };
  assert.equal(await restoreCharacter(null, storage(null), save), 'robot');
  assert.equal(await restoreCharacter(null, storage('unknown'), save), 'robot');
  assert.equal(await restoreCharacter('unknown', storage('cat'), save), 'robot');
  const unavailable = { getItem(): string { throw new Error('unavailable'); }, removeItem() { throw new Error('unavailable'); } };
  assert.equal(await restoreCharacter(null, unavailable, save), 'robot');
  assert.equal(await restoreCharacter('boy', unavailable, save), 'boy');
});
