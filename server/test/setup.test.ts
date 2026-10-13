import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { SerialPortMock } from 'serialport';
import { DeviceSetup, type SerialConnection } from '../src/setup.js';

const portPath = '/dev/cu.test-coaster';
const deviceToken = 'test-setup-device-token';
const wifi = { ssid: '测试网络', password: 'wifi-test-password', serverUrl: 'http://192.168.1.10:3001' };
const status = () => ({
  firmwareVersion: '0.3.1', raw: 100000, weightGrams: null as number | null,
  stable: false, calibrated: false, emptyCupGrams: 0,
  wifiConnected: false, serverConnected: false, ip: '', restartRequired: false,
  error: '请先完成零点和砝码校准' as string | null,
});

class FakePort extends EventEmitter implements SerialConnection {
  isOpen = false;
  state = status();
  commands: Record<string, unknown>[] = [];
  handle?: (command: Record<string, unknown>) => boolean;
  openError = false;
  open(callback: (error: Error | null) => void) {
    this.isOpen = !this.openError;
    callback(this.openError ? new Error('Port is busy') : null);
  }
  write(data: string, callback: (error?: Error | null) => void) {
    const command = JSON.parse(data);
    this.commands.push(command);
    callback(null);
    queueMicrotask(() => {
      if (this.handle?.(command)) return;
      if (command.cmd === 'status') return this.respond(this.state);
      if (command.cmd === 'tare') Object.assign(this.state, { calibrated: false, weightGrams: null, emptyCupGrams: 0 });
      if (command.cmd === 'calibrate') Object.assign(this.state, { calibrated: true, weightGrams: command.grams, emptyCupGrams: 0 });
      if (command.cmd === 'cup') Object.assign(this.state, { emptyCupGrams: 120, error: null });
      this.respond({ ok: true, message: '已保存' });
    });
  }
  respond(value: unknown) {
    const data = Buffer.from(`boot: test\ninvalid json\n${JSON.stringify(value)}\r\n`);
    for (let i = 0; i < data.length; i += 7) this.emit('data', data.subarray(i, i + 7));
  }
  close(callback: (error: Error | null) => void) {
    this.isOpen = false;
    this.emit('close');
    callback(null);
  }
}

function fixture(t: TestContext, prepare?: (port: FakePort) => void) {
  const ports: FakePort[] = [];
  const setup = new DeviceSetup({
    deviceId: 'coaster-01', deviceToken, timeoutMs: 100, bootDelayMs: 0,
    listPorts: async () => [{ path: portPath, manufacturer: 'test' }],
    createPort: () => {
      const port = new FakePort();
      prepare?.(port);
      ports.push(port);
      return port;
    },
    serverUrls: () => [wifi.serverUrl],
  });
  t.after(() => setup.close());
  return { setup, ports };
}

test('USB 握手与校准使用真实命令契约，处理分段中文和启动日志', async (t) => {
  const { setup, ports } = fixture(t, (port) => Object.assign(port.state, { token: deviceToken }));
  const connected = await setup.connect(portPath);
  assert.equal(connected.connected, true);
  assert.equal(connected.device.error, '请先完成零点和砝码校准');
  assert.equal(JSON.stringify(connected).includes(deviceToken), false);
  assert.deepEqual(ports[0].commands.map((item) => item.cmd), ['status', 'watch', 'status']);
  assert.equal((await setup.calibrate({ cmd: 'tare' })).device.calibrated, false);
  assert.equal((await setup.calibrate({ cmd: 'calibrate', grams: 500 })).device.weightGrams, 500);
  assert.equal((await setup.calibrate({ cmd: 'cup' })).device.emptyCupGrams, 120);
  assert.equal((await setup.calibrate({ cmd: 'tare' })).device.emptyCupGrams, 0);
  await setup.disconnect();
  assert.deepEqual(await setup.status(), { connected: false, path: null, device: null });
});

test('未知端口和非杯垫固件不能收到写配置命令', async (t) => {
  const { setup, ports } = fixture(t, (port) => { port.handle = () => { port.respond({ hello: true }); return true; }; });
  await assert.rejects(setup.connect('/dev/other'), /刷新端口列表/);
  assert.equal(ports.length, 0);
  await assert.rejects(setup.connect(portPath), /设备未回复/);
  assert.equal(ports[0].isOpen, false);
  assert.deepEqual(ports[0].commands, [{ cmd: 'status' }]);
  await assert.rejects(setup.configure(wifi), /先连接/);
});

test('配网按确认顺序写入服务器凭证后重启，接口响应不含密码和凭证', async (t) => {
  const { setup, ports } = fixture(t);
  await setup.connect(portPath);
  const result = await setup.configure(wifi);
  assert.deepEqual(ports[0].commands.slice(3), [
    { cmd: 'wifi', ssid: wifi.ssid, password: wifi.password },
    { cmd: 'server', url: wifi.serverUrl, id: 'coaster-01', token: deviceToken },
    { cmd: 'reboot' },
  ]);
  assert.match(result.message, /正在重启/);
  const response = JSON.stringify([result, await setup.choices(), await setup.status()]);
  assert.equal(response.includes(deviceToken), false);
  assert.equal(response.includes(wifi.password), false);
  assert.equal(ports[0].isOpen, false);
});

test('Wi-Fi 字节长度、空字符和非本机服务器地址在写入前拒绝', async (t) => {
  const { setup, ports } = fixture(t);
  await setup.connect(portPath);
  for (const input of [
    { ...wifi, ssid: '中'.repeat(11) }, { ...wifi, password: '短' },
    { ...wifi, password: '中'.repeat(22) }, { ...wifi, ssid: 'name\0bad' },
    { ...wifi, serverUrl: 'http://192.168.1.99:3001' },
    { ...wifi, serverUrl: 'https://attacker.example' },
  ]) await assert.rejects(setup.configure(input));
  await assert.rejects(setup.calibrate({ cmd: 'calibrate' }), /50–2000/);
  assert.equal(ports[0].commands.length, 3);
  await setup.configure({ ...wifi, password: '' });
  assert.equal(ports[0].commands[3].password, '');
});

test('固件拒绝配置时停止流程，校准不稳定不显示成功', async (t) => {
  const { setup, ports } = fixture(t);
  await setup.connect(portPath);
  ports[0].handle = (command) => {
    if (command.cmd === 'server' || command.cmd === 'tare') {
      ports[0].respond({ ok: false, error: command.cmd === 'tare' ? '零点采样不稳定' : '仍有待处理记录，不能修改设备编号' });
      return true;
    }
    return false;
  };
  await assert.rejects(setup.configure(wifi), /Wi-Fi 已保存.*不能修改设备编号/);
  assert.equal(ports[0].commands.some((command) => command.cmd === 'reboot'), false);
  await assert.rejects(setup.calibrate({ cmd: 'tare' }), /采样不稳定/);
  assert.equal((await setup.status()).connected, true);
});

test('配网占用串口期间拒绝轮询和其他修改，防止确认错配', async (t) => {
  const { setup, ports } = fixture(t);
  await setup.connect(portPath);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ports[0].handle = (command) => {
      if (command.cmd !== 'server') return false;
      release = () => ports[0].respond({ ok: true });
      resolve();
      return true;
    };
  });
  const configured = setup.configure(wifi);
  await waiting;
  await assert.rejects(setup.status(), /上一项 USB 操作/);
  await assert.rejects(setup.calibrate({ cmd: 'tare' }), /上一项 USB 操作/);
  release();
  await configured;
  assert.deepEqual(ports[0].commands.slice(3).map((item) => item.cmd), ['wifi', 'server', 'reboot']);
});

test('命令超时关闭串口，旧连接的迟到回复不确认新操作', async (t) => {
  const { setup, ports } = fixture(t);
  await setup.connect(portPath);
  const old = ports[0];
  old.handle = (command) => command.cmd === 'tare';
  await assert.rejects(setup.calibrate({ cmd: 'tare' }), /结果尚未确认/);
  assert.equal(old.isOpen, false);
  assert.equal((await setup.status()).connected, false);
  await setup.connect(portPath);
  ports[1].handle = (command) => {
    if (command.cmd !== 'tare') return false;
    old.respond({ ok: true });
    ports[1].respond({ ok: false, error: '新连接采样不稳定' });
    return true;
  };
  await assert.rejects(setup.calibrate({ cmd: 'tare' }), /新连接采样不稳定/);
});

test('拔线或打开失败有可操作提示，后续状态不会保留已连接', async (t) => {
  const { setup, ports } = fixture(t);
  await setup.connect(portPath);
  ports[0].handle = () => { ports[0].emit('error', new Error('Device unplugged')); return true; };
  await assert.rejects(setup.calibrate({ cmd: 'tare' }), /USB 连接已断开/);
  assert.equal((await setup.status()).connected, false);
  const denied = fixture(t, (port) => { port.openError = true; });
  await assert.rejects(denied.setup.connect(portPath), /关闭 Arduino 串口监视器/);
  assert.equal((await denied.setup.status()).connected, false);
});

test('校准成功后状态读取失败，仍明确区分已保存和未确认', async (t) => {
  const { setup, ports } = fixture(t);
  await setup.connect(portPath);
  ports[0].handle = (command) => command.cmd === 'status';
  await assert.rejects(setup.calibrate({ cmd: 'tare' }), /空载归零成功.*最新状态读取失败/);
});

test('打开端口超时释放操作锁，迟到的打开回调关闭旧端口', async (t) => {
  let finishOpen!: () => void;
  let attempts = 0;
  const { setup, ports } = fixture(t, (port) => {
    if (attempts++ !== 0) return;
    port.open = (callback) => { finishOpen = () => { port.isOpen = true; callback(null); }; };
  });
  await assert.rejects(setup.connect(portPath), /打开串口超时/);
  assert.equal((await setup.connect(portPath)).connected, true);
  finishOpen();
  assert.equal(ports[0].isOpen, false);
  assert.equal(ports[1].isOpen, true);
  assert.equal((await setup.status()).connected, true);
});

test('SerialPort 官方模拟驱动能完整握手，验证实际流接口兼容性', async (t) => {
  const mockPath = '/dev/test-official-mock';
  SerialPortMock.binding.createPort(mockPath);
  const setup = new DeviceSetup({
    deviceId: 'coaster-01', deviceToken, timeoutMs: 1000, bootDelayMs: 0,
    listPorts: () => SerialPortMock.list(), serverUrls: () => [wifi.serverUrl],
    createPort: (path) => {
      const port = new SerialPortMock({ path, baudRate: 115200, autoOpen: false });
      const write = port.write.bind(port);
      port.write = ((data: string, callback: (error?: Error | null) => void) => {
        const result = write(data, callback);
        setImmediate(() => port.port!.emitData(`${JSON.stringify(JSON.parse(data).cmd === 'status' ? status() : { ok: true })}\n`));
        return result;
      }) as typeof port.write;
      return port;
    },
  });
  t.after(() => setup.close());
  assert.equal((await setup.connect(mockPath)).device.firmwareVersion, '0.3.1');
});
