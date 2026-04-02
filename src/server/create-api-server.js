import http from 'node:http';

import { API_ROUTES } from '../shared/contracts/event-names.js';

export function createApiServer({ runtime }) {
  return http.createServer((request, response) => {
    handleApiRequest({ runtime, request, response }).catch((error) => {
      const statusCode = error.statusCode ?? 500;
      writeJson(response, statusCode, {
        error: statusCode === 500 ? 'Internal Server Error' : 'Bad Request',
        message: error.message
      });
    });
  });
}

export async function handleApiRequest({ runtime, request, response }) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === API_ROUTES.HEALTH) {
    return writeJson(response, 200, runtime.getHealth());
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.INCIDENTS) {
    return writeJson(response, 200, { items: runtime.incidentStore.getIncidents() });
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.ALERTS) {
    return writeJson(response, 200, { items: runtime.incidentStore.getAlerts() });
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.QUARANTINE_JOBS) {
    return writeJson(response, 200, { items: runtime.incidentStore.getQuarantineJobs() });
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.SNAPSHOT) {
    return writeJson(response, 200, runtime.getSnapshot());
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.DEMO_START) {
    return writeJson(response, 200, await runtime.enableDemoMode());
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.DEMO_STOP) {
    return writeJson(response, 200, await runtime.disableDemoMode());
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.WATCH_TARGET) {
    const payload = await readJsonBody(request);

    if (!payload?.targetPath || typeof payload.targetPath !== 'string') {
      throw createBadRequest('targetPath is required');
    }

    return writeJson(response, 200, await runtime.setTargetPath(payload.targetPath));
  }

  return writeJson(response, 404, {
    error: 'Not Found',
    routes: Object.values(API_ROUTES)
  });
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw createBadRequest('Request body must be valid JSON');
  }
}

function createBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload, null, 2));
}
