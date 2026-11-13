// The request dock's cards from `bw cards` request lines, the `bw answer` arguments a click sends, and
// question drafts. Pure and Herdr-free: the mod passes the lines, the guard and the feed's expectation.

/** How long a resolved request stays in the dock after its `resolved_ms`. */
export const RESOLVED_SHOW_MS = 10000;

/**
 * @typedef {object} Who
 * @property {string | null} child
 * @property {string} [agent_type]
 * @property {string} [description]
 * @property {number} [depth]
 */

/**
 * @typedef {object} Request One `request` line of `bw cards` (decision 9).
 * @property {string} id
 * @property {"approval" | "question" | "question_async" | "prompt"} kind
 * @property {string} state
 * @property {boolean} answerable
 * @property {string | null} reason
 * @property {Who | Who[] | null} who a list when one box binds several children
 * @property {string} [tool]
 * @property {string} [command]
 * @property {string} [detail]
 * @property {{ id: string, label: string }[]} [actions]
 * @property {any} [question]
 * @property {number} [unread]
 * @property {number | null} [at_ms]
 * @property {number | null} [resolved_ms]
 */

/**
 * @typedef {object} Button
 * @property {string} id "approve", "always", "deny", "option-<n>", "submit" or "terminal"
 * @property {string} label
 * @property {boolean} enabled
 * @property {boolean} primary
 */

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {Request["kind"]} kind
 * @property {string} title
 * @property {string} who
 * @property {string} tool
 * @property {string} command
 * @property {string} detail
 * @property {string} state the request's state, or "sending" while its `bw answer` runs
 * @property {string | null} note
 * @property {Button[]} buttons
 * @property {any} question
 */

/**
 * @typedef {object} Expect What `bw answer` is told to expect: `{ kind, ...expectation(feed, kind) }`.
 * @property {string} kind
 * @property {string} session an id or "none"
 * @property {string} path a log path or "none"
 */

/**
 * Builds an `Expect` from `bw cards` output lines (`cards` + optional `state` line), or `null` when
 * the session cannot be verified safely.
 * @param {Record<string, any> | null | undefined} cardsLine
 * @param {Record<string, any> | null | undefined} stateLine
 * @param {string} kind
 * @returns {Expect | null}
 */
export function cardsExpect(cardsLine, stateLine, kind) {
  if (kind !== "claude" && kind !== "codex") return null;
  if (
    cardsLine &&
    typeof cardsLine.session === "string" &&
    cardsLine.session !== "" &&
    typeof cardsLine.path === "string" &&
    cardsLine.path !== ""
  ) {
    return { kind, session: cardsLine.session, path: cardsLine.path };
  }
  if (stateLine?.state === "no_log") {
    const session = typeof cardsLine?.session === "string" && cardsLine.session !== "" ? cardsLine.session : "none";
    return { kind, session, path: "none" };
  }
  return null;
}

/** @param {Request} req @returns {Who[]} */
const whoList = (req) => (Array.isArray(req.who) ? req.who : req.who ? [req.who] : []).filter((w) => w?.child);

/** @param {string[]} names */
function joinNames(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** @param {Request} req @param {string} agentName */
function whoName(req, agentName) {
  const list = whoList(req);
  if (!list.length) return agentName;
  return joinNames([...new Set(list.map((w) => w.agent_type || "a sub-agent"))]);
}

const capital = (/** @type {string} */ s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {Request} req @param {string} agentName the chat's agent, for a request of the root
 * @returns {string}
 */
export function titleOf(req, agentName) {
  const who = whoName(req, agentName);
  if (req.kind === "approval") return `Approval needed from ${who}`;
  if (req.kind === "prompt") return `${capital(who)} asks where the new conversation should run`;
  return `${capital(who)} asks`;
}

/**
 * The note under a card in a state other than pending; null for pending.
 * @param {string} state @param {string} [kind] an approval says "Approved", anything else "Answered"
 * @returns {string | null}
 */
export function stateNote(state, kind = "approval") {
  switch (state) {
    case "answered":
      return kind === "approval" ? "Approved" : "Answered";
    case "declined":
      return "Denied";
    case "answered_terminal":
      return "Answered in the terminal";
    case "declined_terminal":
      return "Denied in the terminal";
    case "settling":
      return "Left the screen; checking who answered";
    case "stale":
      return "Changed on screen; nothing was pressed";
    case "uncertain":
      return "Sent, but the screen did not change. Check the terminal (⌘J).";
    case "sending":
      return "Sending…";
    default:
      return null;
  }
}

/**
 * Why a pending request offers only "Answer in terminal".
 * @param {string | null} reason @param {string} agentName
 */
export function reasonNote(reason, agentName) {
  switch (reason) {
    case "codex_child":
      return "Codex sub-agent approvals are answered in the terminal for now";
    case "clipped":
      return "Command too long to show here. Read it in the terminal";
    case "no_match":
      return "Bellwether cannot read this prompt. Answer it in the terminal";
    case "multi_question":
      return "This prompt has several questions. Answer it in the terminal";
    case "other_view":
      return "Answer it in that sub-agent's own chat";
    case "ambiguous":
      return `${agentName}'s conversation cannot be read (ambiguous)`;
    default:
      return "Answer it in the terminal";
  }
}

/**
 * The note for a `bw answer` line.
 * @param {{ result: string, state?: string | null, message?: string | null }} line
 * @param {string} kind the request's kind
 * @param {string} agentName
 * @returns {string}
 */
export function answerNote(line, kind, agentName) {
  switch (line.result) {
    case "answered":
    case "declined":
    case "uncertain":
    case "stale":
      // A settling request is one whose box just left: what `bw answer` did is the note.
      return /** @type {string} */ (
        stateNote(line.state && line.state !== "pending" && line.state !== "settling" ? line.state : line.result, kind)
      );
    case "sent":
      return /** @type {string} */ (stateNote("answered", kind));
    case "refused-conversation":
      return `${agentName} moved to another conversation; nothing was pressed`;
    case "refused-agent":
      return "This terminal runs another program now; nothing was pressed";
    case "refused-prompt":
      return `${agentName} is waiting on another prompt; answer it in the terminal`;
    case "not-answerable":
      return "Answer it in the terminal";
    case "already-answered":
      return "Already answered";
    case "busy":
      return "Another answer is being sent; try again in a moment";
    default:
      return line.message ? `Not sent (${line.message})` : "Not sent";
  }
}

const TERMINAL = { id: "terminal", label: "Answer in terminal", enabled: true, primary: false };

/** @param {Request} req @returns {Omit<Button, "enabled">[]} */
function answerButtonsOf(req) {
  const actions = Array.isArray(req.actions) ? req.actions : [];
  const has = (/** @type {string} */ id) => actions.find((a) => a?.id === id);
  if (req.kind === "question" || req.kind === "question_async")
    return [{ id: "submit", label: "Submit", primary: true }];
  if (req.kind === "prompt") {
    return actions
      .filter((a) => /^option-\d+$/.test(a?.id ?? ""))
      .map((a, i) => ({ id: a.id, label: a.label || a.id, primary: i === 0 }));
  }
  /** @type {Omit<Button, "enabled">[]} */
  const out = [];
  if (has("approve")) out.push({ id: "approve", label: "Approve", primary: true });
  const always = has("always");
  if (always) out.push({ id: "always", label: always.label || "Always allow", primary: false });
  if (has("deny")) out.push({ id: "deny", label: "Deny", primary: false });
  return out;
}

/**
 * The dock's cards, newest last: every pending request, and each resolved one for 10 s after it resolved.
 * @param {Request[]} requests the last `request` lines
 * @param {{ now: number, guarded: boolean, sending?: Set<string>, agentName: string, expect?: Expect | null }} o
 *   `expect` null or absent disables every answer button, as the composer's send is disabled
 * @returns {Card[]}
 */
export function dockCards(requests, o) {
  const sending = o.sending ?? new Set();
  /** @type {Map<string, Request>} */
  const byId = new Map();
  for (const r of requests ?? []) if (r && typeof r.id === "string") byId.set(r.id, r);
  const live = [...byId.values()].filter(
    (r) => r.state === "pending" || typeof r.resolved_ms !== "number" || o.now - r.resolved_ms < RESOLVED_SHOW_MS,
  );
  live.sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));
  // One screen shows one prompt: while any answer is on its way, no other button may press keys.
  const free = !o.guarded && sending.size === 0 && o.expect != null;
  return live.map((r) => {
    const pending = r.state === "pending";
    const state = pending && sending.has(r.id) ? "sending" : r.state;
    let note = stateNote(state, r.kind);
    /** @type {Button[]} */
    let buttons;
    if (pending && !r.answerable) {
      note = reasonNote(r.reason, o.agentName);
      buttons = [TERMINAL];
    } else if (pending) {
      buttons = [...answerButtonsOf(r).map((b) => ({ ...b, enabled: free })), TERMINAL];
    } else {
      buttons = state === "stale" || state === "uncertain" ? [TERMINAL] : [];
    }
    return {
      id: r.id,
      kind: r.kind,
      title: titleOf(r, o.agentName),
      who: whoName(r, o.agentName),
      tool: r.tool ?? "",
      command: r.command ?? "",
      detail: r.detail ?? "",
      state,
      note,
      buttons: buttons.map((b) => ({ ...b })),
      question: r.question ?? null,
    };
  });
}

/**
 * The `bw answer` arguments for a click; run with `helper.call(target.machine, …)` on the space's machine.
 * Throws for a choice the request does not offer, so a stray click can never press another key.
 * @param {Request} req
 * @param {{ action: string } | { answers: { picks: number[], other?: string }[] }} choice
 * @param {{ local: string }} target
 * @param {Expect | null} expect
 * @returns {string[]}
 */
export function answerArgs(req, choice, target, expect) {
  if (!expect?.kind || !expect.session || !expect.path) throw new Error("answer needs the feed's expectation");
  if (!target?.local) throw new Error("answer needs the terminal's local address");
  const head = [
    "answer",
    "--terminal",
    target.local,
    "--request",
    req.id,
    "--expect-kind",
    expect.kind,
    "--expect-session",
    expect.session,
    "--expect-path",
    expect.path,
  ];
  const question = req.kind === "question" || req.kind === "question_async";
  if ("answers" in choice) {
    if (!question || !Array.isArray(choice.answers)) throw new Error(`a ${req.kind} takes no answers`);
    return [...head, "--answers", JSON.stringify(choice.answers)];
  }
  const offered = !question && answerButtonsOf(req).some((b) => b.id === choice.action);
  if (!offered) throw new Error(`${req.kind} ${req.id} offers no ${choice.action}`);
  return [...head, "--action", choice.action];
}

/**
 * @typedef {object} Draft A question card's picks before Submit; `step` is the question shown.
 * @property {number[]} counts options per question
 * @property {boolean[]} multi
 * @property {number[][]} picks
 * @property {string[]} other
 * @property {number} step
 */

/** @param {any} q */
const isMulti = (q) => Boolean(q?.multi ?? q?.multi_select ?? q?.multiSelect);

/**
 * @param {any} question a request's `question`: `{ questions: [{ options, multi }] }`
 * @returns {Draft}
 */
export function emptyDraft(question) {
  /** @type {{ options?: unknown }[]} */
  const qs = Array.isArray(question?.questions) ? question.questions : [];
  return {
    counts: qs.map((q) => (Array.isArray(q?.options) ? q.options.length : 0)),
    multi: qs.map(isMulti),
    picks: qs.map(() => /** @type {number[]} */ ([])),
    other: qs.map(() => ""),
    step: 0,
  };
}

/** @param {Draft} d @param {number} step @param {number} index */
const fits = (d, step, index) =>
  Number.isInteger(step) &&
  step >= 0 &&
  step < d.counts.length &&
  Number.isInteger(index) &&
  index >= 0 &&
  index < d.counts[step];

/** @param {Draft} d @param {number} step @param {number[]} picks @param {string} other @param {number} next */
function withStep(d, step, picks, other, next) {
  return {
    ...d,
    picks: d.picks.map((p, i) => (i === step ? picks : p)),
    other: d.other.map((o, i) => (i === step ? other : o)),
    step: next,
  };
}

/**
 * Picks one option; a single-choice question drops its Other text and moves on to the next question.
 * @param {Draft} d @param {number} step @param {number} index 0-based @returns {Draft}
 */
export function pick(d, step, index) {
  if (!fits(d, step, index)) return d;
  if (d.multi[step])
    return d.picks[step].includes(index)
      ? d
      : withStep(
          d,
          step,
          [...d.picks[step], index].sort((a, b) => a - b),
          d.other[step],
          d.step,
        );
  return withStep(d, step, [index], "", Math.min(step + 1, d.counts.length - 1));
}

/**
 * Turns an option on or off; on a single-choice question, a pick of another option replaces it.
 * @param {Draft} d @param {number} step @param {number} index @returns {Draft}
 */
export function toggle(d, step, index) {
  if (!fits(d, step, index)) return d;
  const on = d.picks[step].includes(index);
  if (!d.multi[step]) return on ? withStep(d, step, [], d.other[step], d.step) : pick(d, step, index);
  const picks = on ? d.picks[step].filter((p) => p !== index) : [...d.picks[step], index].sort((a, b) => a - b);
  return withStep(d, step, picks, d.other[step], d.step);
}

/**
 * The "Other" field's text; on a single-choice question, text replaces the pick.
 * @param {Draft} d @param {number} step @param {string} text @returns {Draft}
 */
export function setOther(d, step, text) {
  if (!Number.isInteger(step) || step < 0 || step >= d.counts.length) return d;
  const picks = !d.multi[step] && text.trim() ? [] : d.picks[step];
  return withStep(d, step, picks, text, d.step);
}

/**
 * A digit key 1 to 9 on a question card: picks (a multi-choice question: toggles) that option. Never submits.
 * @param {Draft} d @param {number} step @param {number} n @returns {Draft}
 */
export function digit(d, step, n) {
  if (!Number.isInteger(n) || n < 1 || n > 9) return d;
  return d.multi[step] ? toggle(d, step, n - 1) : pick(d, step, n - 1);
}

/**
 * What `bw answer --answers` takes: one `{ picks, other? }` per question, picks from 0.
 * @param {Draft} d @returns {{ picks: number[], other?: string }[]}
 */
export function answersOf(d) {
  return d.picks.map((p, i) => {
    const other = d.other[i].trim();
    return other ? { picks: [...p], other } : { picks: [...p] };
  });
}

/** @param {Draft} d @returns {boolean} every question has a pick or Other text */
export const complete = (d) => d.counts.length > 0 && d.picks.every((p, i) => p.length > 0 || d.other[i].trim() !== "");
