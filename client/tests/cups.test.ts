import assert from 'node:assert/strict';
import test from 'node:test';
import { currentCup, validCupName } from '../../shared/cups';

test('杯名限制按字符计数，当前杯与旧固件显示兼容', () => {
  for (const name of ['保温杯A1', 'abc12', '水', '一二三四五']) assert.equal(validCupName(name), true);
  for (const name of ['', '123456', '杯 子', '水杯!', '😀', '杯\n']) assert.equal(validCupName(name), false);
  assert.equal(currentCup({ emptyCupGrams: 120 }), '默认杯');
  assert.equal(currentCup({ emptyCupGrams: null, cups: [], activeCupId: null }), '未设置杯子');
  assert.equal(currentCup({ emptyCupGrams: 180, activeCupId: 2, cups: [
    { id: 1, name: '水杯', emptyCupGrams: 120 }, { id: 2, name: '水杯', emptyCupGrams: 180 },
  ] }), '2 · 水杯');
});
