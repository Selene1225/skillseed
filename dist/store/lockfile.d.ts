/**
 * Lightweight file-based lock for preventing concurrent writes.
 *
 * - Writes PID + timestamp to .skillseed/.lock
 * - Stale lock detection: auto-clears if holder PID is dead or lock > STALE_MS old
 * - No external dependencies (proper-lockfile alternative)
 */
/**
 * Acquire the skillseed write lock. Retries with backoff.
 * Returns a release function.
 * @throws if lock cannot be acquired after retries
 */
export declare function acquireLock(): Promise<() => void>;
/**
 * Run a function while holding the write lock.
 */
export declare function withLock<T>(fn: () => T | Promise<T>): Promise<T>;
//# sourceMappingURL=lockfile.d.ts.map