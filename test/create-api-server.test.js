import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { API_ROUTES } from '../src/shared/contracts/event-names.js';
import { handleApiRequest } from '../src/server/create-api-server.js';

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
  assert.equal(response.payload.activeTarget.rootPath, '/tmp/demo-target');
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

function createRuntimeDouble() {
  return {
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
          rootPath: '/tmp/demo-target'
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
