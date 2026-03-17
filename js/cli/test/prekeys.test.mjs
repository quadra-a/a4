import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPrekeysReport } from '../dist/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('buildPrekeysReport summarizes local and published pre-key state', () => {
  const now = 2_000_000_000_000;
  const report = buildPrekeysReport({
    currentDeviceId: 'device-b',
    devices: {
      'device-a': {
        deviceId: 'device-a',
        createdAt: now - (5 * DAY_MS),
        identityKey: { publicKey: 'aa', privateKey: 'bb' },
        signedPreKey: {
          signedPreKeyId: 7,
          publicKey: 'cc',
          privateKey: 'dd',
          signature: 'ee',
          createdAt: now - (20 * DAY_MS),
        },
        oneTimePreKeys: [
          { keyId: 1, publicKey: '01', privateKey: '11', createdAt: now - (5 * DAY_MS), claimedAt: now - DAY_MS },
          { keyId: 2, publicKey: '02', privateKey: '12', createdAt: now - (5 * DAY_MS), claimedAt: now - DAY_MS },
          { keyId: 3, publicKey: '03', privateKey: '13', createdAt: now - (5 * DAY_MS) },
          { keyId: 4, publicKey: '04', privateKey: '14', createdAt: now - (5 * DAY_MS) },
        ],
        lastResupplyAt: now - (5 * DAY_MS),
        sessions: { 'did:agent:zpeer:device-1': { sessionId: 's1' } },
      },
      'device-b': {
        deviceId: 'device-b',
        createdAt: now - DAY_MS,
        identityKey: { publicKey: 'ff', privateKey: 'gg' },
        signedPreKey: {
          signedPreKeyId: 8,
          publicKey: 'hh',
          privateKey: 'ii',
          signature: 'jj',
          createdAt: now - DAY_MS,
        },
        oneTimePreKeys: [
          { keyId: 1, publicKey: '21', privateKey: '31', createdAt: now - DAY_MS },
          { keyId: 2, publicKey: '22', privateKey: '32', createdAt: now - DAY_MS },
          { keyId: 3, publicKey: '23', privateKey: '33', createdAt: now - DAY_MS },
          { keyId: 4, publicKey: '24', privateKey: '34', createdAt: now - DAY_MS },
          { keyId: 5, publicKey: '25', privateKey: '35', createdAt: now - DAY_MS },
        ],
        lastResupplyAt: now - DAY_MS,
        sessions: {},
      },
    },
  }, now);

  assert.equal(report.available, true);
  assert.equal(report.currentDeviceId, 'device-b');
  assert.equal(report.localDeviceCount, 2);
  assert.equal(report.publishedDeviceCount, 2);
  assert.deepEqual(report.localDevices.map((device) => device.deviceId), ['device-b', 'device-a']);
  assert.deepEqual(
    report.warnings.map((warning) => warning.code).sort(),
    ['low-one-time-prekeys', 'stale-signed-prekey'],
  );
  assert.equal(report.localDevices[1].oneTimePreKeysRemaining, 2);
  assert.equal(report.localDevices[1].oneTimePreKeysClaimed, 2);
  assert.deepEqual(
    report.publishedDevices.map((device) => ({
      deviceId: device.deviceId,
      oneTimePreKeyCount: device.oneTimePreKeyCount,
    })),
    [
      { deviceId: 'device-a', oneTimePreKeyCount: 2 },
      { deviceId: 'device-b', oneTimePreKeyCount: 5 },
    ],
  );
});

test('buildPrekeysReport warns when current device is missing', () => {
  const report = buildPrekeysReport({
    currentDeviceId: 'device-missing',
    devices: {},
  });

  assert.equal(report.available, false);
  assert.deepEqual(
    report.warnings.map((warning) => warning.code),
    ['current-device-missing'],
  );
});
