import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderer, nextTick, ref } from 'vue';
import { NoticeQueue } from '../src/mobile/notices';
import { platform, type Notice } from '../../web/src/platform';
import { useNotice } from '../../web/src/notices';

test('提示逐条关闭，相同故障不会被轮询重新弹出，主动重试可以再次提示', () => {
  let shown: Notice | null = null;
  const queue = new NoticeQueue(value => { shown = value; });
  const failure = { source: 'web:sync', message: '云端同步失败' };
  const feedback = { source: 'widget', message: '请在系统提示中确认添加' };
  queue.show(failure);
  queue.show(feedback);
  queue.show(failure);
  assert.equal(shown, failure);
  queue.dismiss();
  assert.equal(shown, feedback);
  queue.dismiss();
  for (let i = 0; i < 5; ++i) queue.show(failure);
  assert.equal(shown, null);
  queue.reset(failure.source);
  queue.show(failure);
  assert.equal(shown, failure);
});

test('恢复后丢弃排队的过期错误，当前提示保持到用户关闭', () => {
  const queue = new NoticeQueue(() => {});
  const first = { source: 'web:sync', message: '首次连接失败' };
  queue.show(first);
  queue.show({ source: 'web:sync', message: '稍后查询仍失败' });
  queue.show({ source: 'widget', message: '添加组件说明' });
  queue.reset('web:sync');
  assert.equal(queue.current, first);
  queue.dismiss();
  assert.equal(queue.current?.source, 'widget');
  queue.dismiss();
  assert.equal(queue.current, null);
});

test('切换账号清理账号提示和重试动作，切换服务器清理全部提示', () => {
  const queue = new NoticeQueue(() => {});
  let called = false;
  queue.show({ source: 'web:cup', message: '查询设置结果', action: { label: '查询', run: () => { called = true; } } });
  queue.show({ source: 'web:binding', message: '绑定失败' });
  queue.show({ source: 'widget', message: '添加组件说明' });
  queue.clear('web:');
  assert.equal(queue.current?.source, 'widget');
  assert.equal(called, false);
  queue.clear();
  assert.equal(queue.current, null);
});

const renderer = createRenderer<object, object>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, patchProp() {}, setText() {}, setElementText() {},
  parentNode: () => null, nextSibling: () => null,
});

test('关闭提示保留业务错误，轮询与前后台切换不重弹，恢复后的新失败仍提示', async () => {
  const previous = { mobile: platform.mobile, notices: platform.notices };
  const queue = new NoticeQueue(() => {});
  platform.mobile = true;
  platform.notices = queue;
  const error = ref('设置结果尚未确认');
  const active = ref(true);
  let notice!: ReturnType<typeof useNotice>;
  const app = renderer.createApp({ setup() {
    notice = useNotice('web:cup:error', () => error.value, { enabled: () => active.value });
    return () => null;
  } });
  app.mount({});
  try {
    assert.equal(queue.current?.message, error.value);
    queue.dismiss();
    assert.equal(error.value, '设置结果尚未确认');
    active.value = false;
    await nextTick();
    active.value = true;
    await nextTick();
    notice.show();
    assert.equal(queue.current, null);
    notice.reset();
    notice.show();
    assert.equal(queue.current?.message, error.value);
    queue.dismiss();
    error.value = '';
    await nextTick();
    error.value = '设置结果尚未确认';
    await nextTick();
    assert.equal(queue.current?.message, error.value);
  } finally { app.unmount(); Object.assign(platform, previous); }
  assert.equal(queue.current, null);
  notice.show();
  assert.equal(queue.current, null);
});

test('网页继续保留业务提示，不向安卓通知队列发送结果', async () => {
  const previous = { mobile: platform.mobile, notices: platform.notices };
  const queue = new NoticeQueue(() => {});
  platform.mobile = false;
  platform.notices = queue;
  const error = ref('登录失败');
  const app = renderer.createApp({ setup() {
    useNotice('web:auth', () => error.value);
    return () => null;
  } });
  app.mount({});
  try {
    error.value = '密码错误';
    await nextTick();
    assert.equal(error.value, '密码错误');
    assert.equal(queue.current, null);
  } finally { app.unmount(); Object.assign(platform, previous); }
});
