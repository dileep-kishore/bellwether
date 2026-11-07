// The chat's rows for one terminal, kept in step with `bw feed` answers. Adapted from Flockbook's
// herdr-app/mods/flockbook/feedstate.js (MIT, see THIRD_PARTY_NOTICES.md).

/**
 * @typedef {{ type: string, [key: string]: any }} Line
 * One parsed `bw feed` line: `log`, `unchanged`, `splice`, `row`, `state` or `older`.
 */

/**
 * @typedef {{ type: "row", k: string, id: string, [key: string]: any }} Row
 */

/**
 * @typedef {{ ok: true, lines: Line[] } | { ok: false, state: string, message: string }} Answer
 * What `helper.call` resolves.
 */

/**
 * @typedef {object} FeedState
 * @property {string} terminal
 * @property {Row[]} rows what the chat draws: `older`, then `tail`
 * @property {Row[]} tail the rows the feed keeps current
 * @property {Row[]} older rows read on scroll-up
 * @property {number | null} start the byte the tail's rows start at
 * @property {number | null} olderStart where `older` starts
 * @property {boolean} first the log's first row is shown
 * @property {string | null} cursor
 * @property {string | null} path
 * @property {string | null} session
 * @property {string | null} agent
 * @property {string | null} model
 * @property {{ state: string, message: string } | null} error the helper's failure
 * @property {{ state: string, agent: string | null, message: string } | null} waiting the feed's `state` line
 * @property {boolean} loaded
 */

/** @param {string} terminal @returns {FeedState} */
export function emptyFeed(terminal) {
  return { terminal, rows: [], tail: [], older: [], start: null, olderStart: null, first: false,
    cursor: null, path: null, session: null, agent: null, model: null, error: null, waiting: null, loaded: false };
}

/** @param {FeedState} state */
function join(state) { state.rows = state.older.concat(state.tail); }
/** @param {FeedState} state */
function dropOlder(state) { state.older = []; state.olderStart = null; state.first = false; }

/**
 * Where the next `feed --before` reads up to; null when the log's first row is already shown.
 * @param {FeedState} state @returns {number | null}
 */
export function olderFrom(state) {
  if (state.first || !state.path || state.start === null || state.start === 0) return null;
  return state.olderStart ?? state.start;
}

/**
 * Applies a `feed --before` answer. Returns how many rows went on top (0 for none).
 * @param {FeedState} state @param {Answer} answer @param {number} before the `--before` it was asked with
 * @returns {number}
 */
export function applyOlder(state, answer, before) {
  if (!answer.ok) return 0;
  const head = answer.lines.find((l) => l.type === "older");
  // An answer that arrives after the log moved on belongs to rows no longer shown.
  if (!head || head.path !== state.path || before !== olderFrom(state)) return 0;
  const have = new Set(state.rows.map((r) => r.id));
  const add = /** @type {Row[]} */ (answer.lines.filter((l) => l.type === "row" && !have.has(l.id)));
  state.older = add.concat(state.older);
  state.olderStart = head.start; state.first = head.start === 0;
  join(state);
  return add.length;
}

/**
 * Applies one `feed` answer. Returns the index of the first row that changed, or -1 when nothing
 * changed; 0 when only the named failure or wait changed, so the view redraws.
 * @param {FeedState} state @param {Answer} answer @returns {number}
 */
export function applyFeed(state, answer) {
  if (!answer.ok) {
    // Rows stay: an offline machine or a helper being reinstalled says nothing about the log.
    const changed = !state.error || state.error.state !== answer.state || state.error.message !== answer.message;
    state.error = { state: answer.state, message: answer.message }; state.loaded = true;
    return changed ? 0 : -1;
  }
  const hadError = Boolean(state.error);
  state.error = null; state.loaded = true;
  let changedAt = -1, splice = null, waited = false;
  /** @type {Row[]} */
  const rows = [];
  for (const l of answer.lines) {
    if (l.type === "state") {
      const w = { state: String(l.state), agent: l.agent ?? null, message: String(l.message ?? "") };
      const same = state.waiting && state.waiting.state === w.state && state.waiting.agent === w.agent && state.waiting.message === w.message;
      if (!same) changedAt = 0;
      state.waiting = w; waited = true;
    } else if (l.type === "log") {
      const path = l.path ?? null, session = l.session ?? null;
      if (path !== state.path || session !== state.session) {
        state.tail = []; dropOlder(state); changedAt = 0;
      } else if ((l.start ?? null) !== state.start) {
        if (state.older.length) changedAt = 0;
        dropOlder(state);
      }
      state.start = l.start ?? null;
      state.path = path; state.session = session;
      state.agent = l.agent ?? state.agent; state.cursor = l.cursor ?? null;
      if (l.model) state.model = l.model;
    } else if (l.type === "splice") splice = l;
    else if (l.type === "row") rows.push(/** @type {Row} */ (l));
  }
  if (!waited && state.waiting) { state.waiting = null; changedAt = 0; }
  if (splice) {
    const at = Math.max(0, Math.min(splice.at, state.tail.length));
    state.tail = state.tail.slice(0, at).concat(rows);
    const shown = state.older.length + at;
    changedAt = changedAt === -1 ? shown : Math.min(changedAt, shown);
  }
  join(state);
  return hadError && changedAt === -1 ? 0 : changedAt;
}
