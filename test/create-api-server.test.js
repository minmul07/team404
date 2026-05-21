import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { API_ROUTES, EVENT_NAMES } from '../src/shared/contracts/event-names.js';
import { createApiServer, handleApiRequest } from '../src/server/create-api-server.js';

const DEMO_TARGET_ROOT = `${process.cwd()}/tmp/demo-target`;

test('handleApiRequest starts demo through POST /api/demo/start', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: {
      method: 'POST',
      url: API_ROUTES.DEMO_START,
      headers: { host: 'localhost' }
    },
    response
  });

  assert.equal(runtime.startDemoCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.activeMode, 'demo');
  assert.equal(response.payload.activeTarget.rootPath, DEMO_TARGET_ROOT);
});

test('handleApiRequest reports runtime health through GET /api/health', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: {
      method: 'GET',
      url: API_ROUTES.HEALTH,
      headers: { host: 'localhost' }
    },
    response
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.status, 'running');
});

test('handleApiRequest stops demo through POST /api/demo/stop', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: {
      method: 'POST',
      url: API_ROUTES.DEMO_STOP,
      headers: { host: 'localhost' }
    },
    response
  });

  assert.equal(runtime.stopDemoCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.demo.status, 'aborted');
});

test('handleApiRequest returns demo settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: {
      method: 'GET',
      url: API_ROUTES.DEMO_SETTINGS,
      headers: { host: 'localhost' }
    },
    response
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { fileCount: 15 });
});

test('handleApiRequest updates demo settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.DEMO_SETTINGS,
      body: { fileCount: 25 }
    }),
    response
  });

  assert.equal(response.statusCode, 200);
  assert.equal(runtime.updateDemoSettingsCalls.length, 1);
  assert.deepEqual(response.payload, { fileCount: 25 });
});


test('handleApiRequest updates monitor backend settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.MONITOR_SETTINGS,
      body: { backendMode: 'auditd' }
    }),
    response
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { backendMode: 'auditd' });
  assert.deepEqual(runtime.updateMonitorSettingsCalls, [{ backendMode: 'auditd' }]);
});

test('handleApiRequest rejects invalid monitor backend settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await assert.rejects(
    handleApiRequest({
      runtime,
      request: createJsonRequest({
        method: 'PUT',
        url: API_ROUTES.MONITOR_SETTINGS,
        body: { backendMode: 'fanotify' }
      }),
      response
    }),
    /monitor\.backendMode must be auto, auditd, or inotify/
  );
});

test('handleApiRequest switches watch target through POST /api/watch/target', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();
  const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-api-target-'));

  try {
    await handleApiRequest({
      runtime,
      request: createJsonRequest({
        method: 'POST',
        url: API_ROUTES.WATCH_TARGET,
        body: { targetPath }
      }),
      response
    });

    assert.equal(runtime.setTargetPathCalls.length, 1);
    assert.equal(runtime.setTargetPathCalls[0], targetPath);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.activeMode, 'target');
    assert.equal(response.payload.activeTarget.rootPath, `/resolved/${targetPath}`);
  } finally {
    await fs.rm(targetPath, { recursive: true, force: true });
  }
});

test('handleApiRequest switches multiple watch targets through POST /api/watch/target', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();
  const firstPath = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-api-target-a-'));
  const secondPath = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-api-target-b-'));

  try {
    await handleApiRequest({
      runtime,
      request: createJsonRequest({
        method: 'POST',
        url: API_ROUTES.WATCH_TARGET,
        body: { mode: 'normal', targetPaths: [firstPath, secondPath] }
      }),
      response
    });

    assert.equal(runtime.setTargetPathsCalls.length, 1);
    assert.deepEqual(runtime.setTargetPathsCalls[0], [firstPath, secondPath]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.activeMode, 'target');
    assert.deepEqual(
      response.payload.targets.map((target) => target.rootPath),
      [`/resolved/${firstPath}`, `/resolved/${secondPath}`]
    );
  } finally {
    await fs.rm(firstPath, { recursive: true, force: true });
    await fs.rm(secondPath, { recursive: true, force: true });
  }
});

test('handleApiRequest rejects POST /api/watch/target without a targetPath', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'POST',
      url: API_ROUTES.WATCH_TARGET,
      body: {}
    }),
    response
  }).catch((error) => {
    response.writeHead(error.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: error.message }));
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.message, 'targetPath is required');
});

test('handleApiRequest returns response policy settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: {
      method: 'GET',
      url: API_ROUTES.RESPONSE_POLICY,
      headers: { host: 'localhost' }
    },
    response
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope: 'incident-target'
  });
});

test('handleApiRequest updates response policy settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.RESPONSE_POLICY,
      body: {
        lockDirectoryPermissions: true,
        killSuspectProcesses: true,
        shutdownSystem: false
      }
    }),
    response
  });

  assert.equal(response.statusCode, 200);
  assert.equal(runtime.updateResponsePolicyCalls.length, 1);
  assert.deepEqual(response.payload, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: true,
    shutdownSystem: false,
    quarantineScope: 'incident-target'
  });
});

test('handleApiRequest normalizes shutdown response policy to cumulative stages', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.RESPONSE_POLICY,
      body: {
        lockDirectoryPermissions: false,
        killSuspectProcesses: false,
        shutdownSystem: true
      }
    }),
    response
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: true,
    shutdownSystem: true,
    quarantineScope: 'incident-target'
  });
});

test('handleApiRequest updates response policy quarantine scope', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.RESPONSE_POLICY,
      body: {
        lockDirectoryPermissions: true,
        killSuspectProcesses: false,
        shutdownSystem: false,
        quarantineScope: 'all-watch-targets'
      }
    }),
    response
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false,
    quarantineScope: 'all-watch-targets'
  });
});

test('handleApiRequest rejects duplicate watch target paths', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();
  const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'team404-api-target-dup-'));

  try {
    await handleApiRequest({
      runtime,
      request: createJsonRequest({
        method: 'POST',
        url: API_ROUTES.WATCH_TARGET,
        body: { mode: 'normal', targetPaths: [targetPath, targetPath] }
      }),
      response
    }).catch((error) => {
      response.writeHead(error.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ message: error.message }));
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.message, 'targetPaths must not include duplicate directories');
  } finally {
    await fs.rm(targetPath, { recursive: true, force: true });
  }
});

test('handleApiRequest rejects invalid response policy settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.RESPONSE_POLICY,
      body: {
        lockDirectoryPermissions: true,
        killSuspectProcesses: false,
        shutdownSystem: 'yes'
      }
    }),
    response
  }).catch((error) => {
    response.writeHead(error.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: error.message }));
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.message, 'shutdownSystem must be boolean');
});

test('handleApiRequest returns detection policy settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: {
      method: 'GET',
      url: API_ROUTES.DETECTION_POLICY,
      headers: { host: 'localhost' }
    },
    response
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.weights.knownExtension, 0.1);
  assert.equal(response.payload.thresholdWeight, 10);
  assert.equal(response.payload.eventMultipliers.rename, 1.5);
  assert.equal(response.payload.weightDecay.intervalMs, 1000);
  assert.equal(response.payload.weightDecay.amount, 1);
});

test('handleApiRequest updates detection policy settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.DETECTION_POLICY,
      body: {
        thresholdWeight: 12,
        weights: {
          knownExtension: 0.2,
          unknownExtension: 1.2,
          noExtension: 1.4,
          suspiciousExtension: 2.4
        },
        eventMultipliers: {
          create: 0.8,
          modify: 1.1,
          rename: 1.7
        },
        weightDecay: {
          intervalMs: 500,
          amount: 0.5
        },
        userAllowedExtensions: ['.backup', 'BACKUP'],
        suspiciousExtensions: ['locked']
      }
    }),
    response
  });

  assert.equal(response.statusCode, 200);
  assert.equal(runtime.updateDetectionPolicyCalls.length, 1);
  assert.deepEqual(response.payload.userAllowedExtensions, ['backup']);
  assert.equal(response.payload.thresholdWeight, 12);
  assert.equal(response.payload.weights.suspiciousExtension, 2.4);
  assert.equal(response.payload.weightDecay.intervalMs, 500);
  assert.equal(response.payload.weightDecay.amount, 0.5);
});

test('handleApiRequest resets detection policy settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  runtime.detectionPolicy = {
    thresholdWeight: 20,
    weights: {
      knownExtension: 0.9,
      unknownExtension: 1.9,
      noExtension: 1.9,
      suspiciousExtension: 3.9
    },
    eventMultipliers: {
      create: 2,
      modify: 2,
      rename: 2
    },
    weightDecay: {
      intervalMs: 2500,
      amount: 3
    },
    userAllowedExtensions: ['custom'],
    suspiciousExtensions: ['customlocked']
  };

  await handleApiRequest({
    runtime,
    request: {
      method: 'POST',
      url: API_ROUTES.DETECTION_POLICY_RESET,
      headers: { host: 'localhost' }
    },
    response
  });

  assert.equal(response.statusCode, 200);
  assert.equal(runtime.resetDetectionPolicyCalls, 1);
  assert.equal(response.payload.thresholdWeight, 10);
  assert.equal(response.payload.weights.knownExtension, 0.1);
  assert.deepEqual(response.payload.userAllowedExtensions, []);
});

test('handleApiRequest rejects invalid detection policy settings', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'PUT',
      url: API_ROUTES.DETECTION_POLICY,
      body: {
        weights: {
          knownExtension: -1
        }
      }
    }),
    response
  }).catch((error) => {
    response.writeHead(error.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: error.message }));
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.message, 'detectionPolicy.weights.knownExtension must be a non-negative number');
});

test('createApiServer upgrades dashboard WebSocket and broadcasts runtime events', async () => {
  const runtime = createRuntimeDouble();
  const server = createApiServer({ runtime });
  const socket = createSocketDouble();

  try {
    server.emit('upgrade', {
      method: 'GET',
      url: '/',
      headers: {
        host: '127.0.0.1:3000',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13'
      }
    }, socket);

    assert.match(socket.chunks[0].toString('utf8'), /101 Switching Protocols/);

    const connectedMessage = decodeWebSocketFrame(socket.chunks[1]);
    assert.equal(connectedMessage.type, 'CONNECTED');

    runtime.eventBus.emit(EVENT_NAMES.FS_EVENT, {
      type: 'create',
      path: '/tmp/demo-target/example.txt',
      pid: 1234
    });

    const fileEventMessage = decodeWebSocketFrame(socket.chunks[2]);
    assert.equal(fileEventMessage.type, 'FILE_EVENT');
    assert.equal(fileEventMessage.payload.path, '/tmp/demo-target/example.txt');

    runtime.eventBus.emit(EVENT_NAMES.QUARANTINE_STARTED, {
      incidentId: 'test-incident-1',
      rootPath: '/tmp/demo-target',
      status: 'quarantining'
    });

    const quarantineStartedMessage = decodeWebSocketFrame(socket.chunks[3]);
    assert.equal(quarantineStartedMessage.type, 'QUARANTINE_STARTED');
    assert.equal(quarantineStartedMessage.payload.incidentId, 'test-incident-1');
    assert.equal(quarantineStartedMessage.payload.status, 'quarantining');

    runtime.eventBus.emit(EVENT_NAMES.QUARANTINE_FAILED, {
      incidentId: 'test-incident-2',
      rootPath: '/tmp/demo-target',
      status: 'failed',
      reason: 'test failure'
    });

    const quarantineFailedMessage = decodeWebSocketFrame(socket.chunks[4]);
    assert.equal(quarantineFailedMessage.type, 'QUARANTINE_FAILED');
    assert.equal(quarantineFailedMessage.payload.incidentId, 'test-incident-2');
    assert.equal(quarantineFailedMessage.payload.status, 'failed');

    runtime.eventBus.emit(EVENT_NAMES.RULE_WEIGHT_UPDATED, {
      currentWeight: 4,
      thresholdWeight: 10,
      path: '/tmp/demo-target/example.txt'
    });

    const ruleWeightMessage = decodeWebSocketFrame(socket.chunks[5]);
    assert.equal(ruleWeightMessage.type, 'RULE_WEIGHT_UPDATED');
    assert.equal(ruleWeightMessage.payload.currentWeight, 4);
  } finally {
    server.emit('close');
  }
});

function createRuntimeDouble() {
  return {
    eventBus: new EventEmitter(),
    enableDemoModeCalls: 0,
    disableDemoModeCalls: 0,
    startDemoCalls: 0,
    stopDemoCalls: 0,
    resetDemoCalls: 0,
    setTargetPathCalls: [],
    setTargetPathsCalls: [],
    updateResponsePolicyCalls: [],
    updateDetectionPolicyCalls: [],
    resetDetectionPolicyCalls: 0,
    updateDemoSettingsCalls: [],
    updateMonitorSettingsCalls: [],
    demoSettings: {
      fileCount: 15
    },
    monitorSettings: {
      backendMode: 'auto'
    },
    responsePolicy: {
      lockDirectoryPermissions: true,
      killSuspectProcesses: false,
      shutdownSystem: false,
      quarantineScope: 'incident-target'
    },
    detectionPolicy: {
      thresholdWeight: 10,
      weights: {
        knownExtension: 0.1,
        unknownExtension: 1,
        noExtension: 1,
        suspiciousExtension: 2
      },
      eventMultipliers: {
        create: 1,
        modify: 1,
        rename: 1.5
      },
      weightDecay: {
        intervalMs: 1000,
        amount: 1
      },
      userAllowedExtensions: [],
      suspiciousExtensions: ['locked']
    },
    incidentStore: {
      getIncidents() {
        return [];
      },
      getAlerts() {
        return [];
      },
      getQuarantineJobs() {
        return [];
      }
    },
    getHealth() {
      return {
        status: 'running'
      };
    },
    getSnapshot() {
      return {
        activeMode: 'config',
        activeTarget: {
          rootPath: '/tmp/configured-watch'
        },
        responsePolicy: this.getResponsePolicy(),
        detectionPolicy: this.getDetectionPolicy()
      };
    },
    getResponsePolicy() {
      return { ...this.responsePolicy };
    },
    getDetectionPolicy() {
      return {
        thresholdWeight: this.detectionPolicy.thresholdWeight,
        weights: { ...this.detectionPolicy.weights },
        eventMultipliers: { ...this.detectionPolicy.eventMultipliers },
        weightDecay: { ...this.detectionPolicy.weightDecay },
        userAllowedExtensions: [...this.detectionPolicy.userAllowedExtensions],
        suspiciousExtensions: [...this.detectionPolicy.suspiciousExtensions]
      };
    },
    getDemoSettings() {
      return { ...this.demoSettings };
    },
    getMonitorSettings() {
      return { ...this.monitorSettings };
    },
    async updateMonitorSettings(settings) {
      this.updateMonitorSettingsCalls.push(settings);
      this.monitorSettings = { backendMode: settings.backendMode };
      return this.getMonitorSettings();
    },
    async updateDemoSettings(settings) {
      this.updateDemoSettingsCalls.push(settings);
      this.demoSettings = {
        fileCount: Number(settings.fileCount)
      };
      return this.getDemoSettings();
    },
    updateResponsePolicy(policy) {
      this.updateResponsePolicyCalls.push(policy);
      if (policy.shutdownSystem) {
        this.responsePolicy = {
          lockDirectoryPermissions: true,
          killSuspectProcesses: true,
          shutdownSystem: true,
          quarantineScope: policy.quarantineScope ?? 'incident-target'
        };
      } else if (policy.killSuspectProcesses) {
        this.responsePolicy = {
          lockDirectoryPermissions: true,
          killSuspectProcesses: true,
          shutdownSystem: false,
          quarantineScope: policy.quarantineScope ?? 'incident-target'
        };
      } else {
        this.responsePolicy = {
          lockDirectoryPermissions: true,
          killSuspectProcesses: false,
          shutdownSystem: false,
          quarantineScope: policy.quarantineScope ?? 'incident-target'
        };
      }
      return this.getResponsePolicy();
    },
    async updateDetectionPolicy(policy) {
      this.updateDetectionPolicyCalls.push(policy);
      this.detectionPolicy = {
        thresholdWeight: policy.thresholdWeight,
        weights: { ...policy.weights },
        eventMultipliers: { ...policy.eventMultipliers },
        weightDecay: { ...policy.weightDecay },
        userAllowedExtensions: [...policy.userAllowedExtensions],
        suspiciousExtensions: [...policy.suspiciousExtensions]
      };
      return this.getDetectionPolicy();
    },
    async resetDetectionPolicy() {
      this.resetDetectionPolicyCalls += 1;
      this.detectionPolicy = {
        thresholdWeight: 10,
        weights: {
          knownExtension: 0.1,
          unknownExtension: 1,
          noExtension: 1,
          suspiciousExtension: 2
        },
        eventMultipliers: {
          create: 1,
          modify: 1,
          rename: 1.5
        },
        weightDecay: {
          intervalMs: 1000,
          amount: 1
        },
        userAllowedExtensions: [],
        suspiciousExtensions: ['locked', 'encrypted', 'warning', 'decrypt', 'ransom', 'recover', 'pay']
      };
      return this.getDetectionPolicy();
    },
    async enableDemoMode() {
      this.enableDemoModeCalls += 1;
      return {
        activeMode: 'demo',
        activeTarget: {
          rootPath: DEMO_TARGET_ROOT
        }
      };
    },
    async disableDemoMode() {
      this.disableDemoModeCalls += 1;
      return {
        activeMode: 'config',
        activeTarget: {
          rootPath: '/tmp/configured-watch'
        }
      };
    },
    async startDemo() {
      this.startDemoCalls += 1;
      return {
        activeMode: 'demo',
        activeTarget: {
          rootPath: DEMO_TARGET_ROOT
        },
        demo: {
          status: 'running'
        }
      };
    },
    async stopDemo() {
      this.stopDemoCalls += 1;
      return {
        demo: {
          status: 'aborted'
        }
      };
    },
    async resetDemo() {
      this.resetDemoCalls += 1;
      return {
        demo: {
          status: 'ready'
        }
      };
    },
    async setTargetPath(targetPath) {
      this.setTargetPathCalls.push(targetPath);
      return {
        activeMode: 'target',
        activeTarget: {
          rootPath: `/resolved/${targetPath}`
        }
      };
    },
    async setTargetPaths(targetPaths) {
      this.setTargetPathsCalls.push(targetPaths);
      return {
        activeMode: 'target',
        activeTarget: {
          rootPath: `/resolved/${targetPaths[0]}`
        },
        targets: targetPaths.map((targetPath, index) => ({
          id: `manual-${index + 1}`,
          rootPath: `/resolved/${targetPath}`
        }))
      };
    }
  };
}

function createResponseDouble() {
  return {
    statusCode: null,
    headers: null,
    payload: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.payload = JSON.parse(body);
    }
  };
}

function createJsonRequest({ method, url, body }) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = method;
  request.url = url;
  request.headers = {
    host: 'localhost',
    'content-type': 'application/json'
  };
  return request;
}

function createSocketDouble() {
  const socket = new EventEmitter();
  socket.chunks = [];
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.write = (chunk) => {
    socket.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  socket.end = () => {
    socket.writableEnded = true;
    socket.emit('close');
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

function decodeWebSocketFrame(frame) {
  let payloadLength = frame[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    payloadLength = frame.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    payloadLength = Number(frame.readBigUInt64BE(2));
    offset = 10;
  }

  return JSON.parse(frame.subarray(offset, offset + payloadLength).toString('utf8'));
}
