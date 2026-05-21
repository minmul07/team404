import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROUTES, EVENT_NAMES } from '../shared/contracts/event-names.js';
import { normalizeDetectionPolicy } from '../shared/config/detection-policy.js';

const PORT = 3000;
const HOST = '0.0.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

export function createApiServer({ runtime }) {
  const server = http.createServer((request, response) => {
    handleApiRequest({ runtime, request, response }).catch((error) => {
      const statusCode = error.statusCode ?? 500;
      writeJson(response, statusCode, {
        error: statusCode === 500 ? 'Internal Server Error' : 'Bad Request',
        message: error.message
      });
    });
  });

  attachDashboardWebSocket({ server, runtime });
  return server;
}

export function createServer(runtime) {
  return createApiServer({ runtime });
}

export async function handleApiRequest({ runtime, request, response }) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const content = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end(content);
  }

  if (request.method === 'GET' && (url.pathname === '/style.css' || url.pathname === '/app.js')) {
    const ext = path.extname(url.pathname);
    const content = await fs.readFile(path.join(PUBLIC_DIR, url.pathname));
    response.writeHead(200, { 'Content-Type': `${MIME_TYPES[ext]}; charset=utf-8` });
    return response.end(content);
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.HEALTH) {
    return writeJson(response, 200, normalizeHealth(runtime.getHealth()));
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
    return writeJson(response, 200, normalizeSnapshot(runtime.getSnapshot()));
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.RESPONSE_POLICY) {
    return writeJson(response, 200, normalizeResponsePolicy(runtime.getResponsePolicy?.()));
  }

  if (request.method === 'PUT' && url.pathname === API_ROUTES.RESPONSE_POLICY) {
    const payload = await readJsonBody(request);
    validateResponsePolicyPayload(payload);
    return writeJson(response, 200, normalizeResponsePolicy(runtime.updateResponsePolicy(payload)));
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.DETECTION_POLICY) {
    return writeJson(response, 200, normalizeDetectionPolicy(runtime.getDetectionPolicy?.()));
  }

  if (request.method === 'PUT' && url.pathname === API_ROUTES.DETECTION_POLICY) {
    const payload = await readJsonBody(request);
    const policy = validateDetectionPolicyPayload(payload);
    return writeJson(response, 200, normalizeDetectionPolicy(await runtime.updateDetectionPolicy(policy)));
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.DETECTION_POLICY_RESET) {
    return writeJson(response, 200, normalizeDetectionPolicy(await runtime.resetDetectionPolicy()));
  }

  if (request.method === 'GET' && url.pathname === API_ROUTES.DEMO_SETTINGS) {
    return writeJson(response, 200, normalizeDemoSettings(runtime.getDemoSettings?.()));
  }

  if (request.method === 'PUT' && url.pathname === API_ROUTES.DEMO_SETTINGS) {
    const payload = await readJsonBody(request);
    validateDemoSettingsPayload(payload);
    return writeJson(response, 200, normalizeDemoSettings(await runtime.updateDemoSettings(payload)));
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.DEMO_START) {
    return writeJson(response, 200, await runtime.startDemo());
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.DEMO_STOP) {
    return writeJson(response, 200, await runtime.stopDemo());
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.DEMO_RESET) {
    return writeJson(response, 200, await runtime.resetDemo());
  }

  if (request.method === 'POST' && url.pathname === API_ROUTES.WATCH_TARGET) {
    const payload = await readJsonBody(request);
    const mode = payload?.mode ?? 'normal';

    if (mode === 'demo') {
      return writeJson(response, 200, await runtime.enableDemoMode());
    }

    if (mode !== 'normal') {
      throw createBadRequest('mode must be normal or demo');
    }

    if (!payload?.targetPath || typeof payload.targetPath !== 'string') {
      throw createBadRequest('targetPath is required');
    }

    if (!await isExistingDirectory(payload.targetPath)) {
      throw createBadRequest('targetPath must be an existing directory');
    }

    return writeJson(response, 200, await runtime.setTargetPath(payload.targetPath));
  }

  if (request.method === 'POST' && url.pathname === '/api/watch/toggle') {
    const payload = await readJsonBody(request);

    if (!payload || typeof payload.enabled !== 'boolean') {
      throw createBadRequest('enabled is required');
    }

    return writeJson(
      response,
      200,
      payload.enabled ? await runtime.startWatch() : await runtime.stopWatch()
    );
  }

  const restoreMatch = request.method === 'POST' &&
    url.pathname.match(/^\/api\/incidents\/([^/]+)\/restore$/);

  if (restoreMatch) {
    const incidentId = restoreMatch[1];
    return writeJson(response, 200, await runtime.restoreIncident(incidentId));
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

async function isExistingDirectory(targetPath) {
  try {
    const stat = await fs.stat(path.resolve(targetPath));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

function normalizeHealth(health) {
  return {
    ...health,
    watchEnabled: Boolean(health?.watchEnabled)
  };
}

function normalizeSnapshot(snapshot) {
  const rest = snapshot ?? {};
  return {
    ...rest,
    watchEnabled: Boolean(rest.watchEnabled),
    responsePolicy: normalizeResponsePolicy(rest.responsePolicy),
    detectionPolicy: normalizeDetectionPolicy(rest.detectionPolicy),
    quarantineJobs: Array.isArray(rest.quarantineJobs)
      ? rest.quarantineJobs.map((job) => ({ ...job }))
      : []
  };
}

function validateDetectionPolicyPayload(payload) {
  try {
    return normalizeDetectionPolicy(payload);
  } catch (error) {
    throw createBadRequest(error.message);
  }
}

function normalizeResponsePolicy(policy = {}) {
  if (policy?.shutdownSystem) {
    return {
      lockDirectoryPermissions: true,
      killSuspectProcesses: true,
      shutdownSystem: true
    };
  }

  if (policy?.killSuspectProcesses) {
    return {
      lockDirectoryPermissions: true,
      killSuspectProcesses: true,
      shutdownSystem: false
    };
  }

  return {
    lockDirectoryPermissions: true,
    killSuspectProcesses: false,
    shutdownSystem: false
  };
}

function validateResponsePolicyPayload(payload) {
  const fields = [
    'lockDirectoryPermissions',
    'killSuspectProcesses',
    'shutdownSystem'
  ];

  for (const field of fields) {
    if (typeof payload?.[field] !== 'boolean') {
      throw createBadRequest(`${field} must be boolean`);
    }
  }
}

function normalizeDemoSettings(settings = {}) {
  return {
    fileCount: Number.isInteger(settings?.fileCount) ? settings.fileCount : 15
  };
}

function validateDemoSettingsPayload(payload) {
  const fileCount = Number(payload?.fileCount);
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 200) {
    throw createBadRequest('demo.fileCount must be an integer between 1 and 200');
  }
}

function attachDashboardWebSocket({ server, runtime }) {
  const clients = new Set();
  const listeners = [
    [EVENT_NAMES.FS_EVENT, (payload) => broadcast({ type: 'FILE_EVENT', payload })],
    [EVENT_NAMES.QUARANTINE_STARTED, (payload) => broadcast({ type: 'QUARANTINE_STARTED', payload })],
    [EVENT_NAMES.QUARANTINE_COMPLETED, (payload) => broadcast({ type: 'QUARANTINE_COMPLETED', payload })],
    [EVENT_NAMES.QUARANTINE_FAILED, (payload) => broadcast({ type: 'QUARANTINE_FAILED', payload })],
    [EVENT_NAMES.RESTORE_COMPLETED, (payload) => broadcast({ type: 'RESTORE_COMPLETED', payload })],
    [EVENT_NAMES.RULE_WEIGHT_UPDATED, (payload) => broadcast({ type: 'RULE_WEIGHT_UPDATED', payload })],
    [EVENT_NAMES.RULE_MATCH, (payload) => broadcast({ type: 'RULE_MATCH', payload })],
    [EVENT_NAMES.DEMO_STARTED, (payload) => broadcast({ type: 'DEMO_STARTED', payload })],
    [EVENT_NAMES.DEMO_ABORTED, (payload) => broadcast({ type: 'DEMO_ABORTED', payload })],
    [EVENT_NAMES.DEMO_COMPLETED, (payload) => broadcast({ type: 'DEMO_COMPLETED', payload })],
    [EVENT_NAMES.SYSTEM_HEALTH, (payload) => broadcast({ type: 'SYSTEM_HEALTH', payload })]
  ];

  for (const [eventName, listener] of listeners) {
    runtime.eventBus?.on(eventName, listener);
  }

  server.on('upgrade', (request, socket) => {
    if (!isDashboardWebSocketRequest(request)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = createWebSocketAcceptKey(request.headers['sec-websocket-key']);
    if (!acceptKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n'
    ].join('\r\n'));

    clients.add(socket);

    const cleanup = () => {
      clients.delete(socket);
    };

    socket.on('close', cleanup);
    socket.on('end', cleanup);
    socket.on('error', cleanup);
    socket.on('data', (chunk) => {
      if ((chunk[0] & 0x0f) === 0x08) {
        socket.end();
      }
    });
    send(socket, {
      type: 'CONNECTED',
      payload: runtime.getHealth?.() ?? { status: 'running' }
    });
  });

  server.on('close', () => {
    for (const [eventName, listener] of listeners) {
      runtime.eventBus?.off(eventName, listener);
    }
    for (const client of clients) {
      client.end();
    }
    clients.clear();
  });

  function broadcast(message) {
    for (const client of clients) {
      send(client, message);
    }
  }
}

function isDashboardWebSocketRequest(request) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const upgrade = request.headers.upgrade?.toLowerCase();

  return request.method === 'GET' &&
    upgrade === 'websocket' &&
    (url.pathname === '/' || url.pathname === '/ws');
}

function createWebSocketAcceptKey(clientKey) {
  if (typeof clientKey !== 'string' || clientKey.trim() === '') {
    return null;
  }

  return crypto
    .createHash('sha1')
    .update(`${clientKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function send(socket, message) {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }

  socket.write(encodeWebSocketTextFrame(JSON.stringify(message)));
}

function encodeWebSocketTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');

  if (payload.length < 126) {
    return Buffer.concat([
      Buffer.from([0x81, payload.length]),
      payload
    ]);
  }

  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

export { PORT, HOST };
