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
    shutdownSystem: false
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
    shutdownSystem: false
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
    shutdownSystem: true
  });
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
    updateResponsePolicyCalls: [],
    responsePolicy: {
      lockDirectoryPermissions: true,
      killSuspectProcesses: false,
      shutdownSystem: false
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
        responsePolicy: this.getResponsePolicy()
      };
    },
    getResponsePolicy() {
      return { ...this.responsePolicy };
    },
    updateResponsePolicy(policy) {
      this.updateResponsePolicyCalls.push(policy);
      if (policy.shutdownSystem) {
        this.responsePolicy = {
          lockDirectoryPermissions: true,
          killSuspectProcesses: true,
          shutdownSystem: true
        };
      } else if (policy.killSuspectProcesses) {
        this.responsePolicy = {
          lockDirectoryPermissions: true,
          killSuspectProcesses: true,
          shutdownSystem: false
        };
      } else {
        this.responsePolicy = {
          lockDirectoryPermissions: true,
          killSuspectProcesses: false,
          shutdownSystem: false
        };
      }
      return this.getResponsePolicy();
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
