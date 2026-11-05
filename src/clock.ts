/** Time used by the SDK, in seconds. Tests replace these functions. */

import { setTimeout as delay } from 'node:timers/promises'

export const clock = {
  /** Monotonic time, for durations. */
  now(): number {
    return performance.now() / 1000
  },
  /** Wall-clock time, for dates sent by the server. */
  wallNow(): number {
    return Date.now() / 1000
  },
  /** Waits; rejects with the signal's reason when it aborts. */
  async sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    await delay(Math.max(0, seconds) * 1000, undefined, signal ? { signal } : undefined)
  },
}
