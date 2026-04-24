/**
 * Preference service — thin wrapper around file-store preference functions.
 */
import { getPreference, getAllPreferences, setPreference } from "../store/file-store.js";
export function preferenceGet(key) {
    if (key) {
        return getPreference(key);
    }
    return getAllPreferences();
}
export function preferenceSet(key, value) {
    setPreference(key, value);
    return { success: true, key, value };
}
//# sourceMappingURL=preference.js.map