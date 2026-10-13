const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const Module = require('node:module');

const clients = [];
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'mqtt') {
    return { connect: () => {
      const client = new EventEmitter();
      client.subscribe = (topic, callback) => callback(null);
      client.end = () => client.emit('end');
      clients.push(client);
      return client;
    } };
  }
  if (request === 'homey') {
    return { App: class {}, Driver: class {}, Device: class {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const TuyaOpenMQ = require('../lib/tuyamqttapi');
const TuyaCloudApp = require('../app');
const legacyApi = require('../lib/cloudtuya');
Module._load = originalLoad;

const log = { log() {}, error() {} };
const config = {
  success: true,
  result: {
    url: 'mqtt://example.test', client_id: 'client', username: 'user',
    password: '01234567abcdefghijkl', expire_time: 7200,
    source_topic: { device: 'devices' },
  },
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('MQTT reconnects with fresh config after a sustained outage and resubscribes', async () => {
  clients.length = 0;
  const mq = new TuyaOpenMQ({ post: async () => config, tokenInfo: { uid: 'uid' } }, '1.0', log);
  let connected = 0;
  mq.addConnectionListener(() => { connected += 1; });
  mq.start();
  try {
    await tick();
    assert.equal(clients.length, 1);
    clients[0].emit('connect');
    await tick();
    assert.equal(connected, 1);
    clients[0].emit('offline');
    assert.ok(mq.outageTimer);
    const outageTimer = mq.outageTimer;
    const onTimeout = outageTimer._onTimeout;
    clearTimeout(outageTimer);
    onTimeout();
    await tick();
    assert.equal(clients.length, 2);
    clients[1].emit('connect');
    await tick();
    assert.equal(connected, 2);
  } finally {
    mq.stop();
  }
  assert.equal(mq.client, null);
});

test('MQTT AES-GCM rejects a tampered authentication tag', () => {
  const mq = new TuyaOpenMQ({}, '2.0', log);
  const key = 'abcdefghijkl';
  const password = `01234567${key}mnop`;
  const iv = crypto.randomBytes(12);
  const timestamp = 123456;
  const aad = Buffer.alloc(6);
  aad.writeUIntBE(timestamp, 0, 6);
  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(`${key}mnop`), iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update('status'), cipher.final()]);
  const packet = Buffer.concat([Buffer.from([0, 0, 0, iv.length]), iv, encrypted, cipher.getAuthTag()]);
  assert.equal(mq._decodeMQMessage(packet.toString('base64'), password, timestamp), 'status');
  packet[packet.length - 1] ^= 1;
  assert.throws(() => mq._decodeMQMessage(packet.toString('base64'), password, timestamp));
});

function makeApp(getDeviceStatus) {
  const app = new TuyaCloudApp();
  const updates = [];
  app.log = () => {};
  app.error = () => {};
  app.initialized = true;
  app.devices = [{ id: 'device1', category: 'cz', status: [{ code: 'switch_1', value: false }] }];
  app.tuyaOpenMQ = { running: true };
  app.tuyaOpenApi = { getDeviceStatus };
  app.getTypeDriver = () => ({ getDevice: () => ({ updateCapabilities: status => updates.push(status) }) });
  app.updateCapabilities = (driver, id, status) => driver.getDevice({ id }).updateCapabilities(status);
  app.triggerTuyaMessageFlow = async () => {};
  return { app, updates };
}

test('reconciliation refreshes paired device state after reconnect', async () => {
  const { app, updates } = makeApp(async () => [{ code: 'switch_1', value: true }]);
  await app.reconcileDeviceStates();
  assert.deepEqual(updates, [[{ code: 'switch_1', value: true }]]);
  assert.equal(app.devices[0].status[0].value, true);
});

test('late REST response cannot overwrite a newer MQTT update', async () => {
  let resolveStatus;
  const { app, updates } = makeApp(() => new Promise(resolve => { resolveStatus = resolve; }));
  const reconciliation = app.reconcileDeviceStates();
  await tick();
  await app.onMQTTMessage({ devId: 'device1', status: [{ code: 'switch_1', value: true }] });
  resolveStatus([{ code: 'switch_1', value: false }]);
  await reconciliation;
  assert.deepEqual(updates, [[{ code: 'switch_1', value: true }]]);
  assert.equal(app.devices[0].status[0].value, true);
});

test('a reconnect during reconciliation queues one more refresh', async () => {
  let resolveFirst;
  let calls = 0;
  const { app, updates } = makeApp(() => {
    calls += 1;
    return calls === 1
      ? new Promise(resolve => { resolveFirst = resolve; })
      : Promise.resolve([{ code: 'switch_1', value: true }]);
  });
  const first = app.reconcileDeviceStates();
  await tick();
  await app.reconcileDeviceStates();
  resolveFirst([{ code: 'switch_1', value: false }]);
  await first;
  await tick();
  assert.equal(calls, 2);
  assert.equal(updates[1][0].value, true);
});

test('legacy discovery parses the JSON response before emitting device updates', async () => {
  const originalCheck = legacyApi._check_access_token;
  const originalPost = legacyApi._post;
  const received = [];
  legacyApi._check_access_token = async () => {};
  legacyApi._post = async () => JSON.stringify({ payload: { devices: [{ id: 'device1' }] } });
  legacyApi.on('device_updated', onUpdate);
  function onUpdate(device) { received.push(device.id); }
  try {
    const devices = await legacyApi.discover_devices();
    assert.deepEqual(devices, [{ id: 'device1' }]);
    assert.deepEqual(received, ['device1']);
  } finally {
    legacyApi.off('device_updated', onUpdate);
    legacyApi._check_access_token = originalCheck;
    legacyApi._post = originalPost;
  }
});
