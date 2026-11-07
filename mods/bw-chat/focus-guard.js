// The 3 s focus guard: answer buttons stay off while the chat's terminal has focus and until 3 s after
// it lost it, so a key typed into the terminal can never land on a prompt a click answers. Pure.

export const FOCUS_QUIET_MS = 3000;

/**
 * @typedef {object} Guard
 * @property {boolean} focused the chat's terminal had focus at the last observation
 * @property {number} since when it last had focus, or when focus was last seen leaving it
 */

/**
 * A freshly mounted chat counts as focused at mount: the terminal may have had focus a moment ago.
 * @param {number} now @returns {Guard}
 */
export const createGuard = (now) => ({ focused: false, since: now });

/**
 * Records what `render` sees. Focus seen leaving starts the quiet time at this observation, since
 * nothing tells when it really left.
 * @param {Guard} guard
 * @param {string | null} focusedTerminal `focused()?.terminal`
 * @param {string | null} ours the chat's terminal in this window's namespace, null while not found
 * @param {number} now
 * @returns {Guard} the same object when nothing changed
 */
export function observe(guard, focusedTerminal, ours, now) {
  const has = ours !== null && focusedTerminal === ours;
  if (has) return guard.focused ? guard : { focused: true, since: now };
  return guard.focused ? { focused: false, since: now } : guard;
}

/** @param {Guard} guard @returns {number} `Infinity` while the terminal has focus */
export const guardedUntil = (guard) => (guard.focused ? Infinity : guard.since + FOCUS_QUIET_MS);

/** @param {Guard} guard @param {number} now */
export const isGuarded = (guard, now) => now < guardedUntil(guard);
