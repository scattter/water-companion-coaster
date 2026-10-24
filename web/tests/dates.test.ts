import assert from 'node:assert/strict';
import test from 'node:test';
import { dateInZone, dateWeekEnd, selectableDate, shiftDate, weekDates } from '../../shared/dates';

test('日期导航跨月跨年和闰年，按日历日计算', () => {
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(weekDates('2026-01-03'), ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03']);
});

test('日期条定位包含所选日的七天，不越过今天', () => {
  for (const date of ['2026-10-24', '2026-10-18', '2026-10-17', '2025-12-31']) {
    const end = dateWeekEnd(date, '2026-10-24');
    assert.ok(end <= '2026-10-24');
    assert.ok(weekDates(end).includes(date));
  }
  assert.equal(dateWeekEnd('2026-10-17', '2026-10-24'), '2026-10-17');
});

test('无效日期与未来日期不能成为选中日期', () => {
  for (const date of ['', '2026-02-30', '2026-13-01', '2026-1-01', '2026-10-25']) {
    assert.equal(selectableDate(date, '2026-10-24'), false);
  }
  assert.equal(selectableDate('2024-02-29', '2026-10-24'), true);
  assert.equal(selectableDate('2026-10-24', '2026-10-24'), true);
});

test('今天使用服务端时区，兼容跨日和夏令时', () => {
  assert.equal(dateInZone('Asia/Shanghai', new Date('2026-10-24T16:00:00Z')), '2026-10-25');
  assert.equal(dateInZone('America/New_York', new Date('2026-11-01T05:30:00Z')), '2026-11-01');
  assert.equal(dateInZone('America/New_York', new Date('2026-11-01T06:30:00Z')), '2026-11-01');
});
