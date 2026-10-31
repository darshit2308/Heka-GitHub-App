/** How often a live process looks for webhook jobs whose lease has expired. */
export const WEBHOOK_RECOVERY_INTERVAL_MS = 30_000;

export interface WebhookRecovery {
  tick: () => Promise<void>;
  stop: () => void;
}

/**
 * Runs recovery immediately and then on a timer. A tick still in progress
 * is not started again. The timer does not keep the process alive.
 */
export function startAbandonedJobRecovery(
  recover: (now: number) => Promise<void>,
  options?: { intervalMs?: number; now?: () => number },
): WebhookRecovery {
  const intervalMs = options?.intervalMs ?? WEBHOOK_RECOVERY_INTERVAL_MS;
  const now = options?.now ?? Date.now;
  let running = false;
  let current = Promise.resolve();

  const tick = (): Promise<void> => {
    if (running) return current;
    running = true;
    current = (async () => {
      try {
        await recover(now());
      } finally {
        running = false;
      }
    })();
    return current;
  };

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  void tick().catch(() => undefined);

  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
