import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';

import { EVENT_NAMES } from '../shared/contracts/event-names.js';
import { AuditdEventNormalizer, MonitorEventNormalizer, parseMonitorLine } from './monitor-event-parser.js';
import { DEMO_TARGET_DIR } from '../simulator/demo.js';

const execFileAsync = promisify(execFile);
const BACKEND_MODES = new Set(['auto', 'auditd', 'inotify']);
const AUDITD_BACKEND = 'auditd';
const INOTIFY_BACKEND = 'inotify';
const DEFAULT_AUDIT_KEY = 'team404_watch';
const DEFAULT_AUDIT_LOG_PATH = '/var/log/audit/audit.log';

export class MonitorService {
  constructor({ config, eventBus, watchOptions = {}, backendFactories = {} }) {
    this.config = config;
    this.eventBus = eventBus;
    this.watchContext = resolveWatchContext(
      config.monitor.targets,
      watchOptions,
      config.meta.projectRoot
    );
    this.backendFactories = {
      auditd: (options) => new AuditdMonitorBackend(options),
      inotify: (options) => new InotifyMonitorBackend(options),
      ...backendFactories
    };

    this.status = 'idle';
    this.activeBackend = null;
    this.backend = null;
    this.backendHealth = null;
    this.lastError = null;
    this.fallbackReason = null;
    this.watchRequested = false;
  }

  async start() {
    this.watchRequested = true;
    this.status = 'starting';
    this.lastError = null;
    this.fallbackReason = null;
    this.emitHealth('starting');

    for (const target of this.watchContext.targets) {
      await mkdir(target.rootPath, { recursive: true });
    }

    const requestedBackend = this.getRequestedBackend();

    if (requestedBackend === INOTIFY_BACKEND) {
      await this.startBackend(INOTIFY_BACKEND);
      return;
    }

    if (requestedBackend === AUDITD_BACKEND) {
      await this.startBackend(AUDITD_BACKEND, { allowFailure: true });
      return;
    }

    const auditdStarted = await this.startBackend(AUDITD_BACKEND, { allowFailure: false });
    if (auditdStarted) {
      return;
    }

    await this.startBackend(INOTIFY_BACKEND, { allowFailure: true });
  }

  async stop() {
    this.watchRequested = false;
    const backend = this.backend;
    this.backend = null;

    if (backend) {
      await backend.stop();
    }

    this.activeBackend = null;
    this.backendHealth = null;
    this.status = 'stopped';
    this.emitHealth('stopped');
  }

  async setWatchOptions(watchOptions = {}) {
    const shouldRestart = this.watchRequested;

    if (shouldRestart) {
      await this.stop();
    }

    this.watchContext = resolveWatchContext(
      this.config.monitor.targets,
      watchOptions,
      this.config.meta.projectRoot
    );
    this.lastError = null;
    this.fallbackReason = null;

    if (shouldRestart) {
      await this.start();
    } else {
      this.emitHealth(this.status);
    }

    return this.getHealth();
  }

  async setBackendMode(backendMode) {
    this.config.monitor.backendMode = normalizeBackendMode(backendMode);
    const shouldRestart = this.watchRequested;

    if (shouldRestart) {
      await this.stop();
      await this.start();
    } else {
      this.lastError = null;
      this.fallbackReason = null;
      this.emitHealth(this.status);
    }

    return this.getHealth();
  }

  getHealth() {
    const backendHealth = this.backend?.getHealth?.() ?? this.backendHealth ?? {};
    const requestedBackend = this.getRequestedBackend();
    const activeBackend = this.activeBackend ?? null;

    return {
      status: this.status,
      pid: backendHealth.pid ?? null,
      lastEventAt: backendHealth.lastEventAt ?? null,
      lastError: this.lastError ?? backendHealth.lastError ?? null,
      restartCount: backendHealth.restartCount ?? 0,
      scriptPath: this.config.monitor.scriptPath,
      requestedBackend,
      activeBackend,
      fallbackReason: this.fallbackReason,
      pidTrackingAvailable: activeBackend === AUDITD_BACKEND && this.status === 'running',
      activeMode: this.watchContext.activeMode,
      activeTarget: this.watchContext.activeTarget,
      targets: this.watchContext.targets,
      backend: backendHealth
    };
  }

  getRequestedBackend() {
    return normalizeBackendMode(this.config.monitor.backendMode);
  }

  async startBackend(backendName, { allowFailure = true } = {}) {
    const backend = this.createBackend(backendName);
    this.backend = backend;
    this.activeBackend = backendName;
    this.backendHealth = null;

    try {
      await backend.start();
      this.backendHealth = backend.getHealth();
      this.status = this.backendHealth.status ?? 'running';
      this.lastError = this.backendHealth.lastError ?? null;
      this.emitHealth(this.status);
      return true;
    } catch (error) {
      await backend.stop?.().catch(() => {});
      this.backend = null;
      this.backendHealth = backend.getHealth?.() ?? null;
      this.lastError = error.message;

      if (this.getRequestedBackend() === 'auto' && backendName === AUDITD_BACKEND && !allowFailure) {
        this.fallbackReason = error.message;
        this.activeBackend = null;
        this.status = 'starting';
        this.emitHealth('starting');
        return false;
      }

      this.status = 'degraded';
      this.emitHealth('degraded');
      return false;
    }
  }

  createBackend(backendName) {
    const factory = this.backendFactories[backendName];
    if (!factory) {
      throw new Error(`Unsupported monitor backend: ${backendName}`);
    }

    return factory({
      config: this.config,
      watchContext: this.watchContext,
      onEvent: (event) => this.emitFsEvent(event),
      onHealth: (health) => this.handleBackendHealth(backendName, health)
    });
  }

  handleBackendHealth(backendName, health) {
    if (this.activeBackend !== backendName) {
      return;
    }

    this.backendHealth = health;
    this.status = health.status ?? this.status;
    this.lastError = health.lastError ?? this.lastError;
    this.emitHealth(this.status);
  }

  emitFsEvent(event) {
    this.eventBus.emit(EVENT_NAMES.FS_EVENT, event);
  }

  emitHealth(status) {
    this.eventBus.emit(EVENT_NAMES.SYSTEM_HEALTH, {
      source: 'monitor',
      status,
      observedAt: new Date().toISOString(),
      details: this.getHealth()
    });
  }
}

export class InotifyMonitorBackend {
  constructor({ config, watchContext, onEvent, onHealth }) {
    this.config = config;
    this.watchContext = watchContext;
    this.onEvent = onEvent;
    this.onHealth = onHealth;
    this.normalizer = this.createNormalizer();

    this.status = 'idle';
    this.child = null;
    this.readline = null;
    this.lastEventAt = null;
    this.lastError = null;
    this.restartCount = 0;
    this.isStopping = false;
    this.restartTimer = null;
  }

  async start() {
    this.isStopping = false;
    this.status = 'starting';
    this.spawnProcess();
  }

  async stop() {
    this.isStopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const trailingEvents = this.normalizer.flushAll();
    for (const event of trailingEvents) {
      this.emitFsEvent(event);
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    const child = this.child;
    this.child = null;
    if (child) {
      await terminateChild(child);
    }

    this.status = 'stopped';
    this.emitHealth();
  }

  getHealth() {
    return {
      name: INOTIFY_BACKEND,
      status: this.status,
      pid: this.child?.pid ?? null,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      restartCount: this.restartCount,
      scriptPath: this.config.monitor.scriptPath
    };
  }

  createNormalizer() {
    return new MonitorEventNormalizer({
      targets: this.watchContext.targets,
      movePairWindowMs: this.config.monitor.movePairWindowMs
    });
  }

  spawnProcess() {
    const roots = this.watchContext.targets.map((target) => target.rootPath);
    const command = 'bash';
    const args = [this.config.monitor.scriptPath, ...roots];

    this.child = spawn(command, args, {
      cwd: this.config.meta.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.status = 'running';
    this.lastError = null;
    this.emitHealth();

    this.readline = readline.createInterface({
      input: this.child.stdout
    });

    this.readline.on('line', (line) => {
      const parsed = parseMonitorLine(line);
      if (!parsed) {
        return;
      }

      const events = this.normalizer.consume(parsed);
      for (const event of events) {
        this.emitFsEvent(event);
      }
    });

    this.child.stderr.on('data', (chunk) => {
      this.lastError = String(chunk).trim();
      this.status = 'degraded';
      this.emitHealth();
    });

    this.child.on('error', (error) => {
      this.lastError = error.message;
      this.status = 'degraded';
      this.emitHealth();
    });

    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.readline) {
        this.readline.close();
        this.readline = null;
      }

      if (this.isStopping) {
        return;
      }

      const trailingEvents = this.normalizer.flushAll();
      for (const event of trailingEvents) {
        this.emitFsEvent(event);
      }

      this.status = 'degraded';
      this.lastError = `monitor exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.emitHealth();
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.restartTimer || this.isStopping) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartCount += 1;
      this.spawnProcess();
    }, this.config.monitor.restartDelayMs);
  }

  emitFsEvent(event) {
    this.lastEventAt = event.observedAt;
    this.onEvent(event);
  }

  emitHealth() {
    this.onHealth(this.getHealth());
  }
}

export class AuditdMonitorBackend {
  constructor({ config, watchContext, onEvent, onHealth, commandRunner = runAuditctl }) {
    this.config = config;
    this.watchContext = watchContext;
    this.onEvent = onEvent;
    this.onHealth = onHealth;
    this.commandRunner = commandRunner;
    this.auditKey = config.monitor.auditKey ?? DEFAULT_AUDIT_KEY;
    this.auditLogPath = config.monitor.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;
    this.normalizer = new AuditdEventNormalizer({
      targets: this.watchContext.targets,
      auditKey: this.auditKey
    });

    this.status = 'idle';
    this.child = null;
    this.readline = null;
    this.lastEventAt = null;
    this.lastError = null;
    this.restartCount = 0;
    this.isStopping = false;
    this.restartTimer = null;
  }

  async start() {
    this.isStopping = false;
    this.status = 'starting';
    await this.cleanupRules();
    await this.registerRules();
    this.spawnTail();
  }

  async stop() {
    this.isStopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const trailingEvents = this.normalizer.flushAll();
    for (const event of trailingEvents) {
      this.emitFsEvent(event);
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    const child = this.child;
    this.child = null;
    if (child) {
      await terminateChild(child);
    }

    try {
      await this.cleanupRules();
    } catch (error) {
      this.lastError = error.message;
    }

    this.status = 'stopped';
    this.emitHealth();
  }

  getHealth() {
    return {
      name: AUDITD_BACKEND,
      status: this.status,
      pid: this.child?.pid ?? null,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      restartCount: this.restartCount,
      auditKey: this.auditKey,
      auditLogPath: this.auditLogPath
    };
  }

  async registerRules() {
    for (const target of this.watchContext.targets) {
      await this.commandRunner(['-w', target.rootPath, '-p', 'wa', '-k', this.auditKey]);
    }
  }

  async cleanupRules() {
    await this.commandRunner(['-D', '-k', this.auditKey]);
  }

  spawnTail() {
    this.child = spawn('tail', ['-n', '0', '-F', this.auditLogPath], {
      cwd: this.config.meta.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.status = 'running';
    this.lastError = null;
    this.emitHealth();

    this.readline = readline.createInterface({
      input: this.child.stdout
    });

    this.readline.on('line', (line) => {
      const events = this.normalizer.consumeLine(line);
      for (const event of events) {
        this.emitFsEvent(event);
      }
    });

    this.child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (!message) {
        return;
      }
      this.lastError = message;
      this.status = 'degraded';
      this.emitHealth();
    });

    this.child.on('error', (error) => {
      this.lastError = error.message;
      this.status = 'degraded';
      this.emitHealth();
    });

    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.readline) {
        this.readline.close();
        this.readline = null;
      }

      if (this.isStopping) {
        return;
      }

      const trailingEvents = this.normalizer.flushAll();
      for (const event of trailingEvents) {
        this.emitFsEvent(event);
      }

      this.status = 'degraded';
      this.lastError = `audit log tail exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.emitHealth();
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.restartTimer || this.isStopping) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartCount += 1;
      this.spawnTail();
    }, this.config.monitor.restartDelayMs);
  }

  emitFsEvent(event) {
    this.lastEventAt = event.observedAt;
    this.onEvent(event);
  }

  emitHealth() {
    this.onHealth(this.getHealth());
  }
}

async function runAuditctl(args) {
  try {
    await execFileAsync('auditctl', args);
  } catch (error) {
    const detail = String(error.stderr ?? error.stdout ?? error.message ?? '').trim();
    throw new Error(detail ? `auditctl ${args.join(' ')} failed: ${detail}` : `auditctl ${args.join(' ')} failed`);
  }
}

function normalizeBackendMode(value) {
  return BACKEND_MODES.has(value) ? value : 'auto';
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

function resolveWatchContext(configuredTargets, watchOptions, projectRoot) {
  const defaultTarget = configuredTargets[0];

  if (watchOptions.demo) {
    const baseTarget = defaultTarget ?? createFallbackTarget();
    const activeTarget = {
      ...baseTarget,
      id: 'demo-target',
      rootPath: resolveDemoTargetPath(projectRoot),
      demoAllowed: true,
      mode: 'demo'
    };

    return {
      activeMode: 'demo',
      activeTarget,
      targets: [activeTarget]
    };
  }

  if (Array.isArray(watchOptions.targetPaths) && watchOptions.targetPaths.length > 0) {
    const baseTarget = defaultTarget ?? createFallbackTarget();
    const targets = watchOptions.targetPaths.map((targetPath, index) => ({
      ...baseTarget,
      id: `manual-${index + 1}`,
      rootPath: path.resolve(targetPath),
      mode: 'target',
      demoAllowed: false
    }));

    return {
      activeMode: 'target',
      activeTarget: targets[0],
      targets
    };
  }

  if (watchOptions.targetPath) {
    const baseTarget = defaultTarget ?? createFallbackTarget();
    const activeTarget = {
      ...baseTarget,
      rootPath: path.resolve(watchOptions.targetPath),
      mode: 'target'
    };

    return {
      activeMode: 'target',
      activeTarget,
      targets: [activeTarget]
    };
  }

  const targets =
    configuredTargets.length > 0
      ? configuredTargets.map((target) => ({
          ...target,
          mode: 'config'
        }))
      : [
          {
            ...createFallbackTarget(),
            mode: 'config'
          }
        ];

  const activeTarget = targets[0];

  return {
    activeMode: 'config',
    activeTarget,
    targets
  };
}

function createFallbackTarget() {
  return {
    id: 'default-target',
    rootPath: path.resolve('./tmp/watch'),
    enabled: true,
    autoQuarantineEnabled: false,
    demoAllowed: false
  };
}

function resolveDemoTargetPath(projectRoot) {
  return path.resolve(projectRoot, DEMO_TARGET_DIR);
}
