/**
 * Per-session lifecycle queue (PRD F2.3).
 *
 * Serializes spawn/pause/resume/kill so we never race pty-spawn
 * against pty-free (cmux #5458). Each call queues behind the
 * previous one for the same session id.
 */

export class LifecycleQueue {
  private queues = new Map<string, Promise<unknown>>();

  run<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.queues.set(
      sessionId,
      next.finally(() => {
        if (this.queues.get(sessionId) === next) {
          this.queues.delete(sessionId);
        }
      })
    );
    return next;
  }
}
