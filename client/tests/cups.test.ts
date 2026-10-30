import assert from 'node:assert/strict';
import test from 'node:test';
import { currentCup, supportsManualCupWeight, validCupName, validCupWeight } from '../../shared/cups';

test('杯名限制按字符计数，当前杯与旧固件显示兼容', () => {
  for (const name of ['保温杯A1', 'abc12', '水', '一二三四五']) assert.equal(validCupName(name), true);
  for (const name of ['', '123456', '杯 子', '水杯!', '😀', '杯\n']) assert.equal(validCupName(name), false);
  assert.equal(currentCup({ emptyCupGrams: 120 }), '默认杯');
  assert.equal(currentCup({ emptyCupGrams: null, cups: [], activeCupId: null }), '未设置杯子');
  assert.equal(currentCup({ emptyCupGrams: 180, activeCupId: 2, cups: [
    { id: 1, name: '水杯', emptyCupGrams: 120 }, { id: 2, name: '水杯', emptyCupGrams: 180 },
  ] }), '2 · 水杯');
});

test('手动空杯重量只接受范围内的有限数字，固件版本按数字比较', () => {
  for (const grams of [5, 25, 25.06, 1994.9, 1995]) assert.equal(validCupWeight(grams), true);
  for (const grams of ['', '25', null, undefined, NaN, Infinity, -Infinity, 0, 4.99, 1995.01]) {
    assert.equal(validCupWeight(grams), false);
  }
  for (const version of ['0.8.1', '0.8.10', '0.9.0', '0.10.0', '1.0.0']) {
    assert.equal(supportsManualCupWeight(version), true, version);
  }
  for (const version of [undefined, null, '', 'unknown', '0.7.99', '0.8.0', '0.8', '0.8.1-dev', '0.8.1.0']) {
    assert.equal(supportsManualCupWeight(version), false, String(version));
  }
});
