/**
 * Lightweight file-based lock for preventing concurrent writes.
 *
 * - Writes PID + timestamp to .skillseed/.lock
 * - Stale lock detection: auto-clears if holder PID is dead or lock > STALE_MS old
 * - No external dependencies (proper-lockfile alternative)
 */

import fs from "node:fs";
import path from "node:path";
import { getSkillseedDir } from "./file-store.js";

const LOCK_FILE = ".lock";
const STALE_MS = 3 * 60 * 1000; // 3 minutes
const RETRY_MS = 200;
const MAX_RETRIES = 50; // 10 seconds total

interface LockInfo {
  pid: number;
  timestamp: number;
}

function lockPath(): string {
  return path.join(getSkillseedDir(), LOCK_FILE);
}

function readLock(): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath(), "utf-8");
    const obj = JSON.parse(raw);
    if (typeof obj.pid === "number" && typeof obj.timestamp === "number") {
      return obj as LockInfo;
    }
  } catch { /* corrupt or missing */ }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

function isStale(info: LockInfo): boolean {
  if (Date.now() - info.timestamp > STALE_MS) return true;
  if (!isProcessAlive(info.pid)) return true;
  return false;
}

function tryRemoveStale(): boolean {
  const info = readLock();
  if (!info) return true; // no lock
  if (isStale(info)) {
    try { fs.unlinkSync(lockPath()); } catch { /* race: someone else removed it */ }
    return true;
  }
  return false;
}

/**
 * Acquire the skillseed write lock. Retries with backoff.
 * Returns a release function.
 * @throws if lock cannot be acquired after retries
 */
export async function acquireLock(): Promise<() => void> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    tryRemoveStale();

    try {
      // O_EXCL ensures atomic create-if-not-exists
      const fd = fs.openSync(lockPath(), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      const data = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
      fs.writeSync(fd, data);
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath()); } catch { /* already gone */ }
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    await new Promise(r => setTimeout(r, RETRY_MS));
  }

  // Final attempt: force-clear if stale
  const info = readLock();
  if (info && isStale(info)) {
    try { fs.unlinkSync(lockPath()); } catch { /* race */ }
    return acquireLock(); // one more try
  }

  throw new Error(`Cannot acquire skillseed lock (held by PID ${info?.pid}). Delete ${lockPath()} if stale.`);
}

/**
 * Run a function while holding the write lock.
 */
export async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const release = await acquireLock();
  try {
    return await fn();
  } finally {
    release();
  }
}
