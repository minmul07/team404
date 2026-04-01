import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { EVENT_NAMES } from '../shared/contracts/event-names.js';
import { MonitorEventNormalizer, parseMonitorLine } from './monitor-event-parser.js';

export class MonitorService {
  constructor({ config, eventBus }) {
    this.config = config;
    this.eventBus = eventBus;
    this.normalizer = new MonitorEventNormalizer({
      targets: config.monitor.targets,
      movePairWindowMs: config.monitor.movePairWindowMs
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

    for (const target of this.config.monitor.targets) {
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

  getHealth() {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      restartCount: this.restartCount,
      scriptPath: this.config.monitor.scriptPath,
      targets: this.config.monitor.targets
    };
  }

  spawnProcess() {
    const roots = this.config.monitor.targets.map((target) => target.rootPath);
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
