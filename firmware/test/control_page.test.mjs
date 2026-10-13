import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../water_companion/control.cpp', import.meta.url), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const initial = () => ({
  apSsid: 'Water-A1B2C3', firmwareVersion: '0.4.3', weightGrams: 500, stable: true,
  calibrated: true, emptyCupGrams: 120, lastEvent: null, pendingCount: 0,
  timePendingCount: 0, clockSynced: true, wifiConfigured: false, wifiConnected: false,
  serverConfigured: false, serverConnected: false, error: null,
  wifiSsid: '', wifiReason: 0, restartRequired: false, ip: '',
  bound: false, bindingCode: null, bindingExpiresAt: 0, cloudUrl: '', wifiTrial: false, wifiRollback: false,
});

async function page(scanned = [], status = {}) {
  const elements = new Map();
  for (const [tag, id] of source.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))
    elements.set(id, { textContent: '', value: '', type: tag.match(/\btype="([^"]+)"/)?.[1],
      disabled: /\bdisabled\b/.test(tag), open: false, hidden: /\bhidden\b/.test(tag), attributes: {},
      toggleAttribute(name, enabled) { this.attributes[name] = enabled; },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren(...children) { this.children = children; } });
  const calls = [];
  const state = Object.assign(initial(), status);
  let respond;
  const context = vm.createContext({
    document: { getElementById: (id) => {
      assert.ok(elements.has(id), `页面缺少 ${id}`);
      return elements.get(id);
    } },
    Option: function Option(text, value) { this.textContent = text; this.value = value; },
    AbortController, setTimeout, clearTimeout, setInterval() {},
    fetch: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      const value = await respond?.(path, body)
        ?? (path === '/api/status' ? structuredClone(state)
          : path === '/api/wifi-scan' ? { networks: structuredClone(scanned) } : { ok: true, message: '已保存' });
      return { ok: typeof value !== 'string' && value.ok !== false,
        text: async () => typeof value === 'string' ? value : JSON.stringify(value) };
    },
  });
  vm.runInContext(script, context);
  await vm.runInContext('polling', context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    calls, state, get: (id) => elements.get(id), respond: (fn) => { respond = fn; },
    run: (code) => vm.runInContext(code, context),
  };
}

test('密码可切换明文与隐藏，内容保持，切换网络后清空并恢复隐藏', async () => {
  const p = await page([{ ssid: '新网络', rssi: -50 }]);
  const password = p.get('password');
  password.value = 'test-密码<&';
  assert.equal(password.type, 'password');
  p.get('show-password').onclick();
  assert.equal(password.type, 'text');
  assert.equal(password.value, 'test-密码<&');
  assert.equal(p.get('show-password').textContent, '隐藏密码');
  assert.equal(p.get('show-password').attributes['aria-pressed'], 'true');
  p.get('show-password').onclick();
  assert.equal(password.type, 'password');
  assert.equal(password.value, 'test-密码<&');
  p.get('show-password').onclick();
  p.get('wifi-list').value = '0';
  p.get('wifi-list').onchange();
  assert.equal(password.value, '');
  assert.equal(password.type, 'password');
  assert.equal(p.get('show-password').attributes['aria-pressed'], 'false');
});

test('设置成功显示可关闭浮窗，提交不受明文切换影响且成功后重新隐藏密码', async () => {
  const p = await page();
  assert.equal(p.get('notice').hidden, true);
  p.get('ssid').value = '家里 Wi-Fi';
  p.get('password').value = 'test-password';
  p.get('show-password').onclick();
  p.get('wifi-form').onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(p.calls.find((call) => call.body?.cmd === 'wifi').body.password, 'test-password');
  assert.equal(p.get('notice').hidden, false);
  assert.match(p.get('notice-text').textContent, /Wi-Fi 已保存.*正在重启/);
  assert.equal(p.get('password').value, '');
  assert.equal(p.get('password').type, 'password');
  p.get('notice-close').onclick();
  assert.equal(p.get('notice').hidden, true);
  await p.run('poll()');
  assert.equal(p.get('notice').hidden, true);
});

test('再次访问直接显著显示实际连接的网络，断开后撤去成功状态', async () => {
  const p = await page([], { wifiConfigured: true, wifiConnected: true, wifiSsid: '客厅 <Wi-Fi>', ip: '192.168.1.35' });
  assert.equal(p.get('network').textContent, '已经成功连接 客厅 <Wi-Fi>');
  assert.equal(p.get('network-status').attributes['data-connected'], true);
  assert.equal(p.get('next-step').hidden, false);
  assert.match(p.get('next-step').textContent, /切回正常网络/);
  assert.equal(p.get('notice').hidden, true);
  p.state.wifiConnected = false;
  p.state.wifiReason = 202;
  await p.run('poll()');
  assert.equal(p.get('network-status').attributes['data-connected'], false);
  assert.match(p.get('network').textContent, /连接失败/);
  assert.equal(p.get('next-step').hidden, true);
  p.state.wifiConnected = true;
  await p.run('poll()');
  p.respond((path) => { if (path === '/api/status') throw new Error('连接已断开'); });
  await p.run('poll()');
  assert.equal(p.get('network-status').attributes['data-connected'], false);
  assert.equal(p.get('next-step').hidden, true);
});

test('首次打开自动扫描，中文及特殊网络名作为文本展示，同名保留最强信号', async () => {
  const p = await page([
    { ssid: '家里的网络', rssi: -85 }, { ssid: '<测试 & Wi-Fi>', rssi: -65 },
    { ssid: '家里的网络', rssi: -45 }, { ssid: '', rssi: -40 },
  ]);
  assert.equal(p.calls.filter((call) => call.path === '/api/wifi-scan').length, 1);
  assert.deepEqual(p.get('wifi-list').children.map((item) => item.textContent),
    ['请选择 Wi-Fi', '家里的网络 · 信号强', '<测试 & Wi-Fi> · 信号中', '手动输入（隐藏网络）']);
  assert.equal(p.get('manual-network').hidden, true);
  await p.run('poll()');
  assert.equal(p.calls.filter((call) => call.path === '/api/wifi-scan').length, 1);
});

test('选择网络后直接填写密码，保存使用所选完整名称并清除其他网络的旧密码', async () => {
  const p = await page([{ ssid: '客厅 Wi-Fi', rssi: -50 }]);
  p.get('password').value = 'previous-password';
  p.get('wifi-list').value = '0';
  p.get('wifi-list').onchange();
  assert.equal(p.get('ssid').value, '客厅 Wi-Fi');
  assert.equal(p.get('password').value, '');
  assert.equal(p.get('manual-network').hidden, true);
  p.get('password').value = 'new-password';
  p.get('wifi-form').onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.calls.filter((call) => call.body).map((call) => call.body),
    [{ cmd: 'wifi', ssid: '客厅 Wi-Fi', password: 'new-password' }, { cmd: 'reboot' }]);
});

test('重新扫描保持已选网络与密码，网络消失时保留名称转为手动输入', async () => {
  const p = await page([{ ssid: '原网络', rssi: -50 }]);
  p.get('wifi-list').value = '0';
  p.get('wifi-list').onchange();
  p.get('password').value = 'test-password';
  p.respond((path) => path === '/api/wifi-scan'
    ? { networks: [{ ssid: '新网络', rssi: -40 }, { ssid: '原网络', rssi: -70 }] } : undefined);
  await p.get('scan').onclick();
  assert.equal(p.get('wifi-list').value, '1');
  assert.equal(p.get('ssid').value, '原网络');
  assert.equal(p.get('password').value, 'test-password');
  p.respond((path) => path === '/api/wifi-scan' ? { networks: [] } : undefined);
  await p.get('scan').onclick();
  assert.equal(p.get('wifi-list').value, 'manual');
  assert.equal(p.get('manual-network').hidden, false);
  assert.equal(p.get('ssid').value, '原网络');
  assert.equal(p.get('password').value, 'test-password');
});

test('扫描失败或无结果时可重试，也可手动输入隐藏网络', async () => {
  const p = await page();
  assert.match(p.get('scan-state').textContent, /未发现网络/);
  p.respond((path) => path === '/api/wifi-scan' ? '杯垫正在连接 Wi-Fi，请稍后重新扫描。' : undefined);
  await p.get('scan').onclick();
  assert.match(p.get('scan-state').textContent, /正在连接 Wi-Fi/);
  assert.equal(p.get('scan').disabled, false);
  p.get('wifi-list').value = 'manual';
  p.get('wifi-list').onchange();
  assert.equal(p.get('manual-network').hidden, false);
  assert.equal(p.get('ssid').required, true);
  p.get('ssid').value = '隐藏网络';
  p.get('password').value = 'test-password';
  p.get('wifi-form').onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.calls.find((call) => call.body?.cmd === 'wifi').body,
    { cmd: 'wifi', ssid: '隐藏网络', password: 'test-password' });
});

test('扫描期间不重复请求，不同时保存或轮询状态，完成后恢复操作', async () => {
  const p = await page();
  let release;
  p.respond((path) => path === '/api/wifi-scan' ? new Promise((resolve) => { release = resolve; }) : undefined);
  const scanning = p.get('scan').onclick();
  await new Promise((resolve) => setImmediate(resolve));
  const count = p.calls.length;
  assert.equal(p.get('wifi').disabled, true);
  assert.equal(p.get('wifi-list').disabled, true);
  await p.get('scan').onclick();
  await p.get('cup').onclick();
  await p.run('poll()');
  assert.equal(p.calls.length, count);
  release({ networks: [] });
  await scanning;
  assert.equal(p.get('wifi').disabled, false);
  assert.equal(p.get('scan').disabled, false);
});

test('无路由器连接也能显示实时重量，更新空杯只发送 cup', async () => {
  const p = await page();
  assert.equal(p.get('weight').textContent, '500.0');
  assert.equal(p.get('cup').disabled, false);
  await p.get('cup').onclick();
  assert.deepEqual(p.calls.filter((call) => call.body), [{ path: '/api/command', body: { cmd: 'cup' } }]);
});

test('出厂标定异常提示售后，用户仍能配网但不能设置空杯', async () => {
  const p = await page();
  p.state.calibrated = false;
  p.state.weightGrams = null;
  await p.run('poll()');
  assert.equal(p.get('cup').disabled, true);
  assert.equal(p.get('weight').textContent, '—');
  assert.equal(p.get('wifi').disabled, false);
  assert.match(p.get('reading').textContent, /出厂标定异常.*售后/);
  assert.equal(p.get('calibrate'), undefined);
  assert.equal(p.get('tare'), undefined);
});

test('配置保存和重启中不报配网成功，实际连接目标 Wi-Fi 后才确认', async () => {
  const p = await page();
  Object.assign(p.state, { wifiConfigured: true, wifiConnected: true, wifiSsid: '旧网络', ip: '192.168.1.20' });
  p.respond((path, body) => { if (body?.cmd === 'wifi') p.state.restartRequired = true; });
  p.get('ssid').value = '新网络';
  p.get('password').value = 'test-password';
  p.get('wifi-form').onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.calls.filter((call) => call.body).map((call) => call.body.cmd), ['wifi', 'reboot']);
  assert.match(p.get('network').textContent, /等待杯垫重启/);
  assert.equal(p.get('next-step').hidden, true);
  assert.equal(p.get('reboot').hidden, false);
  Object.assign(p.state, { restartRequired: false, wifiConnected: false, wifiSsid: '新网络' });
  await p.run('poll()');
  assert.match(p.get('network').textContent, /正在连接 新网络/);
  assert.equal(p.get('next-step').hidden, true);
  Object.assign(p.state, { wifiConnected: true, ip: '192.168.1.35' });
  await p.run('poll()');
  assert.equal(p.get('network').textContent, '已经成功连接 新网络');
  assert.equal(p.get('network-status').attributes['data-connected'], true);
  assert.equal(p.get('next-step').hidden, false);
  assert.match(p.get('next-step').textContent, /切回正常网络/);
  assert.match(p.get('notice-text').textContent, /已经成功连接 新网络/);
  p.get('notice-close').onclick();
  await p.run('poll()');
  assert.equal(p.get('notice').hidden, true);
});

test('密码或信号错误时显示连接失败并允许重新配网', async () => {
  const p = await page();
  Object.assign(p.state, { wifiConfigured: true, wifiSsid: '测试网络', wifiReason: 202 });
  await p.run('poll()');
  assert.match(p.get('network').textContent, /连接失败.*检查 Wi-Fi 密码/);
  assert.equal(p.get('wifi').disabled, false);
  assert.equal(p.get('next-step').hidden, true);
});

test('中文 HTTP 错误直接展示，不变成 JSON 解析异常', async () => {
  const p = await page();
  p.respond((path) => path === '/api/command' ? '请先连接 Water- 热点，再在浏览器地址栏输入 http://192.168.4.1' : undefined);
  await p.get('cup').onclick();
  assert.match(p.get('notice-text').textContent, /^请先连接 Water-/);
  assert.equal(p.get('notice').attributes['data-error'], true);
});

test('Wi-Fi 保存被拒绝时不重启，也不清空输入的密码', async () => {
  const p = await page();
  p.respond((path, body) => body?.cmd === 'wifi' ? { ok: false, error: '密码长度无效' } : undefined);
  p.get('ssid').value = '测试网络';
  p.get('password').value = 'short';
  p.get('wifi-form').onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.calls.filter((call) => call.body).map((call) => call.body.cmd), ['wifi']);
  assert.equal(p.get('password').value, 'short');
  assert.equal(p.get('notice-text').textContent, '密码长度无效');
});

test('手机仅在设备未校时时提交日期，不改动已有时钟', async () => {
  const p = await page();
  assert.equal(p.calls.some((call) => call.path === '/api/time'), false);
  p.state.clockSynced = false;
  await p.run('poll()');
  const time = p.calls.find((call) => call.path === '/api/time');
  assert.ok(Math.abs(time.body.epochMs - Date.now()) < 1000);
});

test('设备拒绝空杯更新时显示真实错误，不报成功', async () => {
  const p = await page();
  p.respond((path) => path === '/api/command' ? { ok: false, error: '空杯尚未稳定' } : undefined);
  await p.get('cup').onclick();
  assert.equal(p.get('notice-text').textContent, '空杯尚未稳定');
  assert.equal(p.get('notice').attributes['data-error'], true);
});

test('轮询与写入串行执行，写入期间禁止第二次点击', async () => {
  const p = await page();
  let release;
  p.respond((path) => path === '/api/status' ? new Promise((resolve) => { release = resolve; }) : undefined);
  const polling = p.run('poll()');
  const action = p.get('cup').onclick();
  await p.get('cup').onclick();
  assert.equal(p.get('cup').disabled, true);
  assert.equal(p.calls.some((call) => call.body), false);
  p.respond(undefined);
  release(structuredClone(p.state));
  await Promise.all([polling, action]);
  assert.equal(p.calls.filter((call) => call.body).length, 1);
});

test('Wi-Fi 已保存但重启未确认时明确报告部分成功', async () => {
  const p = await page();
  p.respond((path, body) => body?.cmd === 'reboot' ? { ok: false, error: '设备忙' } : undefined);
  p.get('ssid').value = '测试网络';
  p.get('password').value = 'test-password';
  p.get('wifi-form').onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.calls.filter((call) => call.body).map((call) => call.body.cmd), ['wifi', 'reboot']);
  assert.match(p.get('notice-text').textContent, /Wi-Fi 已保存，重启尚未确认/);
  assert.equal(p.get('password').value, '');
});

test('断线后清空实时重量并禁用操作，保留已确认的成功回执', async () => {
  const p = await page();
  p.respond((path) => { if (path === '/api/status') throw new Error('连接已断开'); });
  await p.get('cup').onclick();
  assert.equal(p.get('weight').textContent, '—');
  assert.equal(p.get('cup').disabled, true);
  assert.equal(p.get('notice-text').textContent, '已保存');
  assert.match(p.get('reading').textContent, /断开前状态/);
});

test('最近取放区分饮水、补水与尚未保存的记录', async () => {
  const p = await page();
  p.state.lastEvent = { kind: 'drink', amountMl: 50, beforeGrams: 500, afterGrams: 450, saved: true };
  await p.run('poll()');
  assert.match(p.get('last-event').textContent, /估算饮水 50.0 ml · 500.0 → 450.0 g · 已保存/);
  p.state.lastEvent = { kind: 'refill', amountMl: 100, beforeGrams: 450, afterGrams: 550, saved: false };
  await p.run('poll()');
  assert.match(p.get('last-event').textContent, /补水 100.0 ml.*保存失败，请勿断电/);
});

test('云端绑定码可申请，过期及绑定后隐藏，网站入口不含设备凭证', async () => {
  const p = await page([], { serverConfigured: true, serverConnected: true,
    cloudUrl: 'https://water.example', bindingCode: '12345678', bindingExpiresAt: Date.now() + 300000 });
  assert.equal(p.get('binding-code').textContent, '12345678');
  assert.equal(p.get('cloud-link').href, 'https://water.example');
  await p.get('binding').onclick();
  assert.equal(p.calls.filter((call) => call.path === '/api/binding').length, 1);
  p.state.bindingExpiresAt = Date.now() - 1;
  await p.run('poll()');
  assert.equal(p.get('binding-code').textContent, '');
  assert.equal(p.get('binding').disabled, false);
  p.state.bindingExpiresAt = Date.now() + 300000;
  p.state.bound = true;
  await p.run('poll()');
  assert.equal(p.get('binding-code').textContent, '');
  assert.equal(p.get('binding').disabled, true);
  assert.match(p.get('binding-state').textContent, /已绑定账号/);
});

test('未完成出厂身份配置明确提示售后，新Wi-Fi验证期间不能提前报成功', async () => {
  const p = await page([], { wifiConnected: true, wifiConfigured: true, wifiSsid: '新网络', wifiTrial: true });
  assert.match(p.get('binding-state').textContent, /出厂设置.*售后/);
  assert.equal(p.get('binding').disabled, true);
  assert.equal(p.get('network-status').attributes['data-connected'], false);
  p.state.wifiTrial = false;
  p.state.wifiRollback = true;
  p.state.wifiConnected = false;
  p.state.wifiSsid = '旧网络';
  await p.run('poll()');
  assert.match(p.get('network').textContent, /保留原网络/);
  assert.equal(p.get('wifi').disabled, false);
});
