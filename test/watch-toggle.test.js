import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { API_ROUTES } from '../src/shared/contracts/event-names.js';
import { createRuntime } from '../src/app/runtime.js';
import { handleApiRequest } from '../src/server/create-api-server.js';

const PROJECT_ROOT = process.cwd();

function createConfig() {
  return {
    monitor: {
      scriptPath: '/tmp/fake-monitor.sh',
      restartDelayMs: 1000,
      movePairWindowMs: 500,
      targets: [
        {
          id: 'sandbox',
          rootPath: '/tmp/configured-watch',
          enabled: true,
          autoQuarantineEnabled: false,
          demoAllowed: true
        }
      ]
    },
    rules: {
      definitions: []
    },
    meta: {
      projectRoot: PROJECT_ROOT
    }
  };
}

test('runtime.startWatch starts monitorService', async () => {
  const runtime = createRuntime(createConfig());
  const calls = { start: 0, stop: 0 };

  runtime.monitorService.start = async () => {
    calls.start += 1;
  };
  runtime.monitorService.stop = async () => {
    calls.stop += 1;
  };
  runtime.monitorService.getHealth = () => ({
    status: 'running',
    activeMode: 'config',
    activeTarget: { id: 'sandbox', rootPath: '/tmp/configured-watch' }
  });

  await runtime.stopWatch();
  const snapshot = await runtime.startWatch();

  assert.equal(calls.stop, 1);
  assert.equal(calls.start, 1);
  assert.equal(snapshot.watchEnabled, true);
  assert.equal(runtime.isWatchEnabled(), true);
});

test('runtime.stopWatch stops monitorService', async () => {
  const runtime = createRuntime(createConfig());
  const calls = { start: 0, stop: 0 };

  runtime.monitorService.start = async () => {
    calls.start += 1;
  };
  runtime.monitorService.stop = async () => {
    calls.stop += 1;
  };
  runtime.monitorService.getHealth = () => ({
    status: 'running',
    activeMode: 'config',
    activeTarget: { id: 'sandbox', rootPath: '/tmp/configured-watch' }
  });

  const snapshot = await runtime.stopWatch();

  assert.equal(calls.start, 0);
  assert.equal(calls.stop, 1);
  assert.equal(snapshot.watchEnabled, false);
  assert.equal(runtime.isWatchEnabled(), false);
});

test('POST /api/watch/toggle returns watchEnabled false when disabled', async () => {
  const runtime = createWatchToggleRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'POST',
      url: '/api/watch/toggle',
      body: { enabled: false }
    }),
    response
  });

  assert.equal(runtime.stopWatchCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.watchEnabled, false);
});

test('POST /api/watch/toggle returns watchEnabled true when enabled', async () => {
  const runtime = createWatchToggleRuntimeDouble();
  const response = createResponseDouble();

  await handleApiRequest({
    runtime,
    request: createJsonRequest({
      method: 'POST',
      url: '/api/watch/toggle',
      body: { enabled: true }
    }),
    response
  });

  assert.equal(runtime.startWatchCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.watchEnabled, true);
});

test('rapid watch toggles do not crash', async () => {
  const runtime = createRuntime(createConfig());
  const calls = { start: 0, stop: 0 };

  runtime.monitorService.start = async () => {
    calls.start += 1;
  };
  runtime.monitorService.stop = async () => {
    calls.stop += 1;
  };
  runtime.monitorService.getHealth = () => ({
    status: 'running',
    activeMode: 'config',
    activeTarget: { id: 'sandbox', rootPath: '/tmp/configured-watch' }
  });

  await runtime.stopWatch();
  await runtime.stopWatch();
  await runtime.startWatch();
  await runtime.startWatch();
  await runtime.stopWatch();
  await runtime.startWatch();

  assert.equal(calls.stop, 2);
  assert.equal(calls.start, 2);
  assert.equal(runtime.isWatchEnabled(), true);
});

test('API remains accessible when watch is off', async () => {
  const runtime = createWatchToggleRuntimeDouble();
  const response = createResponseDouble();

  runtime.watchEnabled = false;

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
  assert.equal(response.payload.watchEnabled, false);
});

function createWatchToggleRuntimeDouble() {
  return {
    watchEnabled: true,
    startWatchCalls: 0,
    stopWatchCalls: 0,
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
    async startWatch() {
      this.startWatchCalls += 1;
      this.watchEnabled = true;
      return {
        status: 'running',
        watchEnabled: true
      };
    },
    async stopWatch() {
      this.stopWatchCalls += 1;
      this.watchEnabled = false;
      return {
        status: 'running',
        watchEnabled: false
      };
    },
    getHealth() {
      return {
        status: 'running',
        watchEnabled: this.watchEnabled
      };
    },
    getSnapshot() {
      return {
        status: 'running',
        watchEnabled: this.watchEnabled
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
