import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { EVENT_NAMES } from '../shared/contracts/event-names.js';
import { MonitorEventNormalizer, parseMonitorLine } from './monitor-event-parser.js';

export class MonitorService {
  constructor({ config, eventBus, watchOptions = {} }) {
    this.config = config;
    this.eventBus = eventBus;
    this.watchContext = resolveWatchContext(
      config.monitor.targets,
      watchOptions,
      config.meta.projectRoot
    );
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

    for (const target of this.watchContext.targets) {
      await mkdir(target.rootPath, { recursive: true });
    }

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

    if (!this.child) {
      this.status = 'stopped';
      this.emitHealth('stopped');
      return;
    }

    const child = this.child;
    this.child = null;

    await new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });

    this.status = 'stopped';
    this.emitHealth('stopped');
  }

  async setWatchOptions(watchOptions = {}) {
    const shouldRestart =
      this.child !== null ||
      this.restartTimer !== null ||
      ['running', 'starting', 'degraded'].includes(this.status);

    if (shouldRestart) {
      await this.stop();
    }

    this.watchContext = resolveWatchContext(
      this.config.monitor.targets,
      watchOptions,
      this.config.meta.projectRoot
    );
    this.normalizer = this.createNormalizer();
    this.lastError = null;

    if (shouldRestart) {
      await this.start();
    } else {
      this.emitHealth(this.status);
    }

    return this.getHealth();
  }

  getHealth() {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      restartCount: this.restartCount,
      scriptPath: this.config.monitor.scriptPath,
      activeMode: this.watchContext.activeMode,
      activeTarget: this.watchContext.activeTarget,
      targets: this.watchContext.targets
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
    this.emitHealth('running');

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
      this.emitHealth('degraded');
    });

    this.child.on('error', (error) => {
      this.lastError = error.message;
      this.status = 'degraded';
      this.emitHealth('degraded');
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
      this.emitHealth('degraded');
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
  return path.resolve(projectRoot ?? '.', 'tmp/demo-target');
}
