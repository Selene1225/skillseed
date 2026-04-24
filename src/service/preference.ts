/**
 * Preference service — thin wrapper around file-store preference functions.
 */

import { getPreference, getAllPreferences, setPreference } from "../store/file-store.js";

export function preferenceGet(key?: string): Record<string, string> | string | null {
  if (key) {
    return getPreference(key);
  }
  return getAllPreferences();
}

export function preferenceSet(key: string, value: string): { success: boolean; key: string; value: string } {
  setPreference(key, value);
  return { success: true, key, value };
}
