// Stack-mode context strip above the composer: multi-agent switcher pill, remote machine badge,
// 1-line GitHub PR status chip, and per-terminal prompt queue drawer.
import { div, svg } from "gpui-kit";
import { h_flex, Input, v_flex } from "gpui-base";
import { READ_W } from "./estimate.js";
import { isMergeReady, isOpenPr } from "./pr-model.js";
import { agentName, queueHoldText } from "./target.js";
import { oneLine } from "./timeline.js";
import { ICONS, button as uiButton, machineTag, mutedOnSelected, pill, statusMark } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./target.js").StackFound} StackFound */
/** @typedef {import("./sessions.js").QueueView} QueueView */
/** @typedef {import("./sessions.js").QueueItem} QueueItem */
/** @typedef {import("./pr-model.js").PrSummary} PrSummary */

/**
 * @typedef {object} ContextStripView
 * @property {Theme} t
 * @property {string | null} machine
 * @property {StackFound[]} agents
 * @property {string} activeTerminal
 * @property {PrSummary | null} pr
 * @property {string | null} prHeadOid
 * @property {boolean} prBusy
 * @property {QueueView} queue
 * @property {boolean} queueBusy
 * @property {boolean} sending
 * @property {boolean} canSendNow
 * @property {string | null} editingId
 * @property {any} editInput retained InputState owned by the view
 */

/**
 * @typedef {object} ContextStripHandlers
 * @property {(terminal: string, cx: any) => void} onSelectAgent
 * @property {(pr: PrSummary, cx: any) => void} onOpenPr
 * @property {(pr: PrSummary, cx: any) => void} onBabysitPr
 * @property {(pr: PrSummary, cx: any) => void} onMergePr
 * @property {(cx: any) => void} onQueueResume
 * @property {(cx: any) => void} onQueueClear
 * @property {(item: QueueItem, cx: any) => void} onQueueEditStart
 * @property {(id: string, cx: any) => void} onQueueEditSave
 * @property {(cx: any) => void} onQueueEditCancel
 * @property {(id: string, to: number, cx: any) => void} onQueueMove
 * @property {(item: QueueItem, cx: any) => void} onQueueSendNow
 * @property {(id: string, cx: any) => void} onQueueRemove
 */

/**
 * Labels each agent pane in a multi-agent tab (`Claude 1`, `Claude 2`, or `Claude` / `Codex`).
 * @param {StackFound[]} agents
 * @returns {Map<string, string>}
 */
function agentLabels(agents) {
  /** @type {Record<string, number>} */
  const totals = { claude: 0, codex: 0 };
  for (const a of agents) totals[a.kind] = (totals[a.kind] ?? 0) + 1;
  /** @type {Record<string, number>} */
  const seen = { claude: 0, codex: 0 };
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const a of agents) {
    seen[a.kind] = (seen[a.kind] ?? 0) + 1;
    const base = agentName(a.kind);
    out.set(a.terminal, totals[a.kind] > 1 ? `${base} ${seen[a.kind]}` : base);
  }
  return out;
}

/** @param {ContextStripView} v @param {ContextStripHandlers} h */
function renderAgentStrip(v, h) {
  const { t } = v;
  const multi = v.agents.length > 1;
  if (!multi && !v.machine) return null;
  const labels = multi ? agentLabels(v.agents) : null;
  return h_flex()
    .id("agent-strip")
    .w_full()
    .gap(8)
    .items_center()
    .flex_wrap()
    .when(Boolean(v.machine), (el) => el.child(machineTag(String(v.machine), t)))
    .when(multi, (el) =>
      el.child(
        h_flex()
          .id("agent-switcher")
          .p(2)
          .gap(2)
          .items_center()
          .rounded(12)
          .bg(t.chrome)
          .border(1)
          .border_color(t.border)
          .children(
            v.agents.map((a) => {
              const active = a.terminal === v.activeTerminal;
              return h_flex()
                .id(`agent-switch-${a.terminal}`)
                .h(24)
                .px(9)
                .gap(6)
                .items_center()
                .rounded(10)
                .text_size(12)
                .when(active, (s) => s.bg(t.selected).text_color(t.foreground).font_medium())
                .when(!active, (s) =>
                  s
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((x) => x.bg(t.hover).text_color(t.foreground))
                    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onSelectAgent(a.terminal, cx)),
                )
                .child(statusMark(t, /** @type {any} */ (a.status), 11))
                .child(labels?.get(a.terminal) ?? agentName(a.kind));
            }),
          ),
      ),
    );
}

/** @param {PrSummary} pr @param {ContextStripView} v @param {ContextStripHandlers} h */
function renderPrStrip(pr, v, h) {
  const { t } = v;
  const mergeReady = isMergeReady(pr, v.prHeadOid);
  const actEnabled = !v.prBusy && !v.sending && !v.queueBusy;
  return h_flex()
    .id("pr-strip")
    .w_full()
    .min_h(34)
    .px(10)
    .py(4)
    .gap(8)
    .items_center()
    .rounded(10)
    .bg(t.chrome)
    .border(1)
    .border_color(t.border)
    .child(
      svg(ICONS.branch)
        .size(13)
        .flex_none()
        .text_color(pr.isDraft ? t.muted : t.accent),
    )
    .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(`#${pr.number}`))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_size(12.5)
        .text_color(t.muted)
        .child(pr.title || "Pull request"),
    )
    .when(pr.isDraft, (el) => el.child(pill(t, "Draft", "machine", "pr-draft")))
    .when(pr.failing > 0, (el) => el.child(pill(t, `${pr.failing} failing`, "failed", "pr-checks")))
    .when(pr.failing === 0 && pr.pending > 0, (el) =>
      el.child(pill(t, `${pr.pending} pending`, "working", "pr-checks")),
    )
    .when(pr.failing === 0 && pr.pending === 0 && pr.passing > 0, (el) =>
      el.child(pill(t, `${pr.passing} passing`, "done", "pr-checks")),
    )
    .when(pr.unresolvedThreads > 0, (el) =>
      el.child(
        pill(
          t,
          `${pr.unresolvedThreads} ${pr.unresolvedThreads === 1 ? "thread" : "threads"}`,
          "blocked",
          "pr-threads",
        ),
      ),
    )
    .when(pr.reviewDecision === "CHANGES_REQUESTED", (el) =>
      el.child(pill(t, "Changes requested", "blocked", "pr-review")),
    )
    .child(
      uiButton(t, {
        id: "pr-open",
        label: "Open PR",
        kind: "secondary",
        h: 24,
        shrink: true,
        enabled: !v.prBusy,
        onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onOpenPr(pr, cx),
      }),
    )
    .child(
      uiButton(t, {
        id: "pr-babysit",
        label: "Babysit PR",
        kind: "secondary",
        h: 24,
        shrink: true,
        enabled: actEnabled,
        onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onBabysitPr(pr, cx),
      }),
    )
    .when(mergeReady, (el) =>
      el.child(
        uiButton(t, {
          id: "pr-merge",
          label: "Merge PR",
          kind: "primary",
          h: 24,
          shrink: true,
          enabled: actEnabled,
          onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onMergePr(pr, cx),
        }),
      ),
    );
}

/** @param {ContextStripView} v @param {ContextStripHandlers} h */
function renderQueueDrawer(v, h) {
  const { t, queue } = v;
  if (!queue.items.length && !queue.held) return null;
  return v_flex()
    .id("queue-drawer")
    .w_full()
    .p(8)
    .gap(6)
    .rounded(12)
    .bg(t.chrome)
    .border(1)
    .border_color(queue.held ? t.blocked : t.border)
    .child(
      h_flex()
        .id("queue-header")
        .w_full()
        .px(4)
        .gap(8)
        .items_center()
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12)
            .font_medium()
            .text_color(queue.held ? t.blocked : t.muted)
            .child(queue.held ? queueHoldText(queue.holdReason) : `Queued (${queue.items.length})`),
        )
        .when(queue.held, (el) =>
          el.child(
            uiButton(t, {
              id: "queue-resume",
              label: "Resume",
              kind: "primary",
              h: 24,
              shrink: true,
              enabled: !v.queueBusy,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueResume(cx),
            }),
          ),
        )
        .child(
          uiButton(t, {
            id: "queue-clear",
            label: "Clear",
            kind: "ghost",
            h: 24,
            shrink: true,
            enabled: !v.queueBusy,
            onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueClear(cx),
          }),
        ),
    )
    .children(
      queue.items.map((item, idx) => {
        if (v.editingId === item.id) {
          const canSave = !v.queueBusy && Boolean(v.editInput.value().trim());
          return h_flex()
            .id(`queue-item-${item.id}`)
            .w_full()
            .px(6)
            .py(4)
            .gap(6)
            .items_center()
            .rounded(8)
            .bg(t.raised)
            .on_key_down((/** @type {any} */ e, /** @type {any} */ cx) => {
              if (String(e?.key ?? "").toLowerCase() === "escape") {
                cx?.stop_propagation?.();
                h.onQueueEditCancel(cx);
              }
            })
            .child(
              Input.new(v.editInput)
                .id("queue-edit-input")
                .flex_1()
                .h(26)
                .px(8)
                .items_center()
                .rounded(6)
                .border(1)
                .border_color(t.input)
                .bg(t.background)
                .text_size(12.5)
                .text_color(t.foreground),
            )
            .child(
              uiButton(t, {
                id: `queue-save-${item.id}`,
                label: "Save",
                kind: "primary",
                h: 24,
                shrink: true,
                enabled: canSave,
                onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueEditSave(item.id, cx),
              }),
            )
            .child(
              uiButton(t, {
                id: `queue-cancel-${item.id}`,
                label: "Cancel",
                kind: "ghost",
                h: 24,
                shrink: true,
                onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueEditCancel(cx),
              }),
            );
        }

        return h_flex()
          .id(`queue-item-${item.id}`)
          .w_full()
          .min_h(28)
          .px(8)
          .py(3)
          .gap(6)
          .items_center()
          .rounded(8)
          .bg(t.raised)
          .child(
            div()
              .w(16)
              .flex_none()
              .text_size(11)
              .text_color(mutedOnSelected)
              .child(String(idx + 1)),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12.5)
              .text_color(t.foreground)
              .child(oneLine(item.text) || item.text),
          )
          .child(
            uiButton(t, {
              id: `queue-edit-${item.id}`,
              label: "Edit",
              kind: "ghost",
              h: 22,
              shrink: true,
              enabled: !v.queueBusy,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueEditStart(item, cx),
            }),
          )
          .child(
            uiButton(t, {
              id: `queue-up-${item.id}`,
              label: "↑",
              kind: "ghost",
              h: 22,
              shrink: true,
              enabled: !v.queueBusy && idx > 0,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueMove(item.id, idx - 1, cx),
            }),
          )
          .child(
            uiButton(t, {
              id: `queue-down-${item.id}`,
              label: "↓",
              kind: "ghost",
              h: 22,
              shrink: true,
              enabled: !v.queueBusy && idx < queue.items.length - 1,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueMove(item.id, idx + 1, cx),
            }),
          )
          .child(
            uiButton(t, {
              id: `queue-send-${item.id}`,
              label: "Send now",
              kind: "secondary",
              h: 22,
              shrink: true,
              enabled: !v.queueBusy && !v.sending && v.canSendNow,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueSendNow(item, cx),
            }),
          )
          .child(
            uiButton(t, {
              id: `queue-remove-${item.id}`,
              label: "×",
              kind: "ghost",
              h: 22,
              shrink: true,
              enabled: !v.queueBusy,
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => h.onQueueRemove(item.id, cx),
            }),
          );
      }),
    );
}

/**
 * Renders the stack-mode context strip inside the 760 px reading column above the composer,
 * or `null` when nothing is active.
 * @param {ContextStripView} v
 * @param {ContextStripHandlers} h
 */
export function contextStrip(v, h) {
  const agent = renderAgentStrip(v, h);
  const pr = isOpenPr(v.pr) ? renderPrStrip(v.pr, v, h) : null;
  const queue = renderQueueDrawer(v, h);
  if (!agent && !pr && !queue) return null;
  return v_flex()
    .id("context-strip")
    .w_full()
    .flex_none()
    .px(16)
    .pt(6)
    .gap(6)
    .items_center()
    .child(
      v_flex()
        .w_full()
        .max_w(READ_W)
        .gap(6)
        .when(Boolean(agent), (el) => el.child(agent))
        .when(Boolean(pr), (el) => el.child(pr))
        .when(Boolean(queue), (el) => el.child(queue)),
    );
}
