// Seconds. Tests replace these functions.

import { setTimeout as delay } from 'node:timers/promises'

export const clock = {
  now(): number {
    return performance.now() / 1000
  },
  wallNow(): number {
    return Date.now() / 1000
  },
  async sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    await delay(Math.max(0, seconds) * 1000, undefined, signal ? { signal } : undefined)
  },
}
