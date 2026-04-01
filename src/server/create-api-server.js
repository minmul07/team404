import http from 'node:http';

import { API_ROUTES } from '../shared/contracts/event-names.js';

export function createApiServer({ runtime }) {
  return http.createServer((request, response) => {
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

    return writeJson(response, 404, {
      error: 'Not Found',
      routes: Object.values(API_ROUTES)
    });
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload, null, 2));
}
