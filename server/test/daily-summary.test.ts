import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { event, fixture, heartbeat } from './cloud-fixture.js';

test('心跳摘要与 App 当日统计一致，撤销、补水及重传不重复计入', async t => {
  const f = await fixture(t);
  const user = await f.register(); await f.bind(user);
  const records = [
    event({ occurredAt: '2026-10-08T15:59:59.999Z' }),
    event({ occurredAt: '2026-10-08T16:00:00.000Z' }),
    event({ amountMl: 75.5, afterGrams: 424.5, occurredAt: '2026-10-09T01:10:00.000Z' }),
    event({ kind: 'refill', beforeGrams: 450, afterGrams: 500, occurredAt: '2026-10-09T01:20:00.000Z' }),
  ];
  await f.upload(records); await f.upload(records);
  const summary = (await f.report()).json().dailySummary;
  const dashboard = (await f.web(user, '/api/dashboard')).json();
  assert.deepEqual(summary, {
    date: '2026-10-09', expiresAtMs: Date.parse('2026-10-09T16:00:00.000Z'),
    drinkMl: dashboard.totals.drinkMl, drinkCount: dashboard.totals.drinkCount,
    lastDrink: { amountMl: 75.5, occurredAtMs: Date.parse(records[2].occurredAt) },
  });
  assert.equal(summary.drinkMl, 125.5);
  await f.web(user, `/api/events/${records[2].id}/revoke`, {});
  await f.upload([records[2]]);
  const after = (await f.report()).json().dailySummary;
  assert.equal(after.drinkMl, 50);
  assert.equal(after.drinkCount, 1);
  assert.equal(after.lastDrink.occurredAtMs, Date.parse(records[1].occurredAt));
  assert.equal(after.drinkMl, (await f.web(user, '/api/dashboard')).json().totals.drinkMl);
});

test('未绑定、旧绑定心跳不下发账号摘要，转绑后不泄露上一位用户记录', async t => {
  const f = await fixture(t);
  assert.equal((await f.report()).json().dailySummary, null);
  const one = await f.register(); await f.bind(one);
  const firstBinding = (await f.web(one, '/api/auth/session')).json().bindingId;
  await f.upload([event()]);
  assert.equal((await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId: firstBinding })).json().dailySummary.drinkMl, 50);
  assert.equal((await f.report('coaster-01', { ...heartbeat, bindingId: randomUUID() })).json().dailySummary, null);
  await f.web(one, '/api/devices/unbind', {});
  assert.equal((await f.report('coaster-01', { ...heartbeat, bindingId: firstBinding })).json().dailySummary, null);
  const two = await f.register('user_two');
  const code = await f.code();
  await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId: null });
  assert.equal((await f.web(two, '/api/devices/bind', { code: code.code })).statusCode, 200);
  const nextBinding = (await f.web(two, '/api/auth/session')).json().bindingId;
  assert.notEqual(nextBinding, firstBinding);
  assert.equal((await f.report('coaster-01', { ...heartbeat, bindingId: firstBinding })).json().dailySummary, null);
  const summary = (await f.report('coaster-01', { ...heartbeat, bindingId: nextBinding })).json().dailySummary;
  assert.equal(summary.drinkMl, 0); assert.equal(summary.drinkCount, 0); assert.equal(summary.lastDrink, null);
  assert.equal((await f.web(one, '/api/dashboard')).json().totals.drinkMl, 50);
});

for (const example of [
  { zone: 'Asia/Shanghai', now: '2026-10-08T16:00:00Z', end: '2026-10-09T16:00:00Z', date: '2026-10-09' },
  { zone: 'America/New_York', now: '2026-11-01T04:00:00Z', end: '2026-11-02T05:00:00Z', date: '2026-11-01' },
  { zone: 'America/New_York', now: '2026-03-08T05:00:00Z', end: '2026-03-09T04:00:00Z', date: '2026-03-08' },
]) {
  test(`${example.zone} ${example.date} 摘要在实际本地午夜失效，补传按发生日期归属`, async t => {
    let timestamp = Date.parse(example.now);
    const f = await fixture(t, { timeZone: example.zone, now: () => new Date(timestamp) });
    const user = await f.register(); await f.bind(user);
    const record = event({ occurredAt: new Date(timestamp).toISOString() });
    await f.upload([record]);
    const summary = (await f.report()).json().dailySummary;
    assert.equal(summary.date, example.date);
    assert.equal(summary.expiresAtMs, Date.parse(example.end));
    assert.equal(summary.drinkMl, 50);
    timestamp = Date.parse(example.end) - 1;
    assert.equal((await f.report()).json().dailySummary.expiresAtMs, Date.parse(example.end));
    timestamp += 1;
    await f.upload([event({ occurredAt: record.occurredAt })]);
    const next = (await f.report()).json().dailySummary;
    assert.notEqual(next.date, example.date);
    assert.equal(next.drinkMl, 0); assert.equal(next.drinkCount, 0); assert.equal(next.lastDrink, null);
    assert.equal((await f.web(user, `/api/dashboard?date=${example.date}`)).json().totals.drinkMl, 100);
  });
}
