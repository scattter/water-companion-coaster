import assert from 'node:assert/strict';
import test from 'node:test';
import { newerSnapshot } from '../src/native';
import type { Snapshot } from '../src/types';

function snapshot(revision: number, server: string | null, userId: string | null): Snapshot {
  return {
    revision,
    server,
    session: {
      user: userId ? { id: userId, username: userId, role: 'user' } : null,
      deviceId: null,
      bindingId: null,
    },
    dashboard: null,
    connection: server ? userId ? 'online' : 'signedOut' : 'unconfigured',
    error: null,
    lastSyncedAt: null,
    state: 'idle',
    drinkMl: null,
    frame: 0,
    settings: { autoRest: true, reminders: true, character: 'capybara' },
  };
}

test('late initial snapshot cannot replace the newer server event', () => {
  let shown = snapshot(0, null, null);
  const initialResponse = snapshot(1, 'https://old.example.com', 'old-user');
  const changedServerEvent = snapshot(2, 'https://new.example.com', null);
  shown = newerSnapshot(shown, changedServerEvent);
  shown = newerSnapshot(shown, initialResponse);
  assert.equal(shown.server, 'https://new.example.com');
  assert.equal(shown.session.user, null);
  assert.equal(shown.connection, 'signedOut');
});

test('late command response cannot restore an account after logout or replacement', () => {
  const oldLoginResponse = snapshot(5, 'https://water.example.com', 'first-user');
  let shown = snapshot(6, 'https://water.example.com', null);
  shown = newerSnapshot(shown, oldLoginResponse);
  assert.equal(shown.session.user, null);
  shown = newerSnapshot(shown, snapshot(8, 'https://water.example.com', 'second-user'));
  shown = newerSnapshot(shown, snapshot(7, 'https://water.example.com', 'first-user'));
  assert.equal(shown.session.user?.id, 'second-user');
  assert.equal(shown.revision, 8);
});
