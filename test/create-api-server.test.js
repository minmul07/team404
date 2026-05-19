import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Readable } from 'node:stream';

import { API_ROUTES, EVENT_NAMES } from '../src/shared/contracts/event-names.js';
import { createApiServer, handleApiRequest } from '../src/server/create-api-server.js';

const DEMO_TARGET_ROOT = path.resolve(process.cwd(), 'tmp/demo-target');

test('handleApiRequest enables demo mode through POST /api/demo/start', async () => {
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

  assert.equal(runtime.enableDemoModeCalls, 1);
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

test('handleApiRequest disables demo mode through POST /api/demo/stop', async () => {
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

  assert.equal(runtime.disableDemoModeCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.activeMode, 'config');
  assert.equal(response.payload.activeTarget.rootPath, '/tmp/configured-watch');
});

test('handleApiRequest switches watch target through POST /api/watch/target', async () => {
  const runtime = createRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'POST',
      url: API_ROUTES.WATCH_TARGET,
      body: { targetPath: './tmp/api-target' }
    }),
    response
  });

  assert.equal(runtime.setTargetPathCalls.length, 1);
  assert.equal(runtime.setTargetPathCalls[0], './tmp/api-target');
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.activeMode, 'target');
  assert.ok(response.payload.activeTarget.rootPath.endsWith('/tmp/api-target'));
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
  } finally {
    server.emit('close');
  }
});

function createRuntimeDouble() {
  return {
    eventBus: new EventEmitter(),
    enableDemoModeCalls: 0,
    disableDemoModeCalls: 0,
    setTargetPathCalls: [],
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
        }
      };
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
