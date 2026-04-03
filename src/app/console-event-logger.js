import { EVENT_NAMES } from '../shared/contracts/event-names.js';

export function attachConsoleEventLogger({ eventBus, log = console.log }) {
  const handleFsEvent = (event) => {
    log('[fs_event]', {
      observedAt: event.observedAt,
      type: event.type,
      path: event.path,
      previousPath: event.previousPath ?? null,
      monitorTargetId: event.monitorTargetId ?? null,
      monitorRootPath: event.monitorRootPath ?? null
    });
  };

  eventBus.on(EVENT_NAMES.FS_EVENT, handleFsEvent);

  return () => {
    eventBus.off(EVENT_NAMES.FS_EVENT, handleFsEvent);
  };
}
