// Drawing a patch: a header with the file and its actions, then one 20 px row per line with old and new
// line numbers, added and removed lines tinted Green and Red over Base, hunk headers on raised fill,
// virtual rows keyed by `{patchDigest}:{kind}:{oldLine}:{newLine}` with `.on_item_click` on the list,
// and an optional retained composer bar mounted below the virtual list.
import { div, svg } from "gpui-kit";
import { h_flex, Scrollbar, v_flex, v_virtual_list } from "gpui-base";
import { settings } from "herdr";
import { joinPages, patchRowKeys, patchRows, size } from "./model.js";
import { alpha, MOCHA, TERMINAL } from "./palette.js";
import { button, ICONS, pill, spinner } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("./comments.js").DraftComment} DraftComment */

const ROW = 20;
/** The tints a patch row takes over Base; scripts/verify/contrast.js checks text on both. */
export const ADDED_TINT = /** @type {Color} */ (alpha(MOCHA.green, 0.12));
export const REMOVED_TINT = /** @type {Color} */ (alpha(MOCHA.red, 0.12));

/**
 * A status letter's colour: added and untracked Green, deleted and unmerged Red (bright on a selected
 * row), modified Peach, renamed and copied Blue (bright on a selected row).
 * @param {Theme} t @param {string} letter @param {boolean} selected
 */
export function letterColor(t, letter, selected) {
  if (letter === "A" || letter === "U") return t.done;
  if (letter === "D" || letter === "!") return /** @type {Color} */ (selected ? TERMINAL.ansi[9] : MOCHA.red);
  if (letter === "R" || letter === "C") return selected ? /** @type {Color} */ (TERMINAL.ansi[12]) : t.working;
  if (letter === "M") return t.blocked;
  return selected ? t.foreground : t.muted;
}

/**
 * `+N` in Green and `−M` in Red, each left out when zero or unknown.
 * @param {Theme} t @param {number | null} added @param {number | null} removed @param {boolean} selected @param {string} id
 */
export function counts(t, added, removed, selected, id) {
  const out = [];
  if (added) out.push(div().id(`${id}-added`).flex_none().text_size(11).text_color(t.done).child(`+${added}`));
  if (removed)
    out.push(
      div()
        .id(`${id}-removed`)
        .flex_none()
        .text_size(11)
        .text_color(/** @type {Color} */ (selected ? TERMINAL.ansi[9] : MOCHA.red))
        .child(`−${removed}`),
    );
  return out;
}

/**
 * @param {import("./model.js").PatchRow} r
 * @returns {{ side: "new" | "old", line: number } | null}
 */
function rowAnchorPos(r) {
  if (r.kind === "del") return typeof r.old === "number" ? { side: "old", line: r.old } : null;
  if (r.kind === "add" || r.kind === "ctx") return typeof r.new === "number" ? { side: "new", line: r.new } : null;
  return null;
}

/**
 * @param {Theme} t
 * @param {{ id: string, title: string, detail: string, actions: any[], onMore: (cx: any) => void,
 *   patch: import("./main.js").PatchState | null,
 *   comments?: DraftComment[],
 *   activeLine?: { side: "new" | "old", line: number } | null,
 *   onLineClick?: ((key: string, rows: import("./model.js").PatchRow[], cx: any) => void) | null,
 *   composer?: any }} o
 */
export function patchView(t, o) {
  const p = o.patch;
  const head = h_flex()
    .id(`${o.id}-head`)
    .h(36)
    .flex_none()
    .px(12)
    .gap(8)
    .items_center()
    .border_t(1)
    .border_b(1)
    .border_color(t.border)
    .bg(t.chrome)
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(div().truncate().text_size(12.5).font_medium().child(o.title))
        .child(div().truncate().text_size(11).text_color(t.muted).child(o.detail)),
    )
    .when(Boolean(p?.loading), (el) => el.child(spinner(t, 12)))
    .children(o.actions);
  const body = v_flex().id(`${o.id}-body`).flex_1().min_h(0).relative().bg(t.background);
  if (!p || (p.loading && p.pages.length === 0)) return v_flex().id(o.id).flex_1().min_h(0).child(head).child(body);
  if (p.error && p.pages.length === 0)
    return v_flex()
      .id(o.id)
      .flex_1()
      .min_h(0)
      .child(head)
      .child(body.p(12).child(div().text_size(12).text_color(t.muted).child(p.error)));

  const { text, cut } = joinPages(p.pages);
  const rows = patchRows(text, cut);
  if (rows.length === 0) rows.push({ kind: "meta", old: null, new: null, text: "No text changes" });
  const keys = patchRowKeys(p.digest, rows);
  /** @type {Map<string, DraftComment>} */
  const byPos = new Map();
  for (const c of o.comments ?? []) byPos.set(`${c.side}:${c.line}`, c);
  const activeKey = o.activeLine ? `${o.activeLine.side}:${o.activeLine.line}` : null;
  const clickable = Boolean(o.onLineClick && p.digest);

  const more = p.pages.length < p.total;
  const longest = rows.reduce((n, r) => Math.max(n, r.text.length), 0);
  const width = Math.min(6000, Math.max(300, longest * 7 + 112));
  const font = /** @type {any} */ (settings())?.font_family ?? "JetBrains Mono";
  const vlist = v_virtual_list(
    `${o.id}-rows`,
    rows.length,
    ROW,
    (i) => keys[i],
    (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) {
        const r = rows[i];
        const pos = rowAnchorPos(r);
        const posKey = pos ? `${pos.side}:${pos.line}` : null;
        out.push(
          patchRow(t, r, {
            clickable: clickable && pos !== null,
            active: posKey !== null && posKey === activeKey,
            comment: posKey !== null ? (byPos.get(posKey) ?? null) : null,
          }),
        );
      }
      return out;
    },
  )
    .size_full()
    .when(Boolean(o.onLineClick), (el) =>
      el.on_item_click((/** @type {string} */ key, /** @type {any} */ cx) => o.onLineClick?.(key, rows, cx)),
    );

  body.child(
    div()
      .id(`${o.id}-x`)
      .size_full()
      .overflow_x_scrollbar()
      .font_family(font)
      .text_size(11.5)
      .child(div().w_full().min_w(width).h_full().child(vlist)),
  );
  body.child(Scrollbar.vertical(`${o.id}-rows`).absolute().inset_0());
  const pane = v_flex().id(o.id).flex_1().min_h(0).child(head);
  if (p.error)
    pane.child(
      div()
        .id(`${o.id}-error`)
        .flex_none()
        .px(12)
        .py(6)
        .border_b(1)
        .border_color(t.border)
        .bg(t.chrome)
        .text_size(11.5)
        .text_color(t.blocked)
        .child(`Could not read the patch again: ${p.error}`),
    );
  pane.child(body);
  if (more)
    pane.child(
      h_flex()
        .id(`${o.id}-more-row`)
        .h(36)
        .flex_none()
        .px(12)
        .gap(8)
        .items_center()
        .border_t(1)
        .border_color(t.border)
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11.5)
            .text_color(t.muted)
            .child(`Page ${p.pages.length} of ${p.total} · ${size(p.bytes)}`),
        )
        .child(
          button(t, {
            id: `${o.id}-more`,
            label: p.loading ? "Loading…" : "Show more",
            h: 24,
            enabled: !p.loading,
            onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => o.onMore(cx),
          }),
        ),
    );
  if (o.composer) pane.child(o.composer);
  return pane;
}

/** @param {number | null} n */
const num = (n) => (n === null ? "" : String(n));

/**
 * @param {Theme} t
 * @param {import("./model.js").PatchRow} r
 * @param {{ clickable: boolean, active: boolean, comment: DraftComment | null }} meta
 */
function patchRow(t, r, meta) {
  if (r.kind === "hunk" || r.kind === "meta" || r.kind === "note") {
    return h_flex()
      .h(ROW)
      .w_full()
      .flex_none()
      .px(12)
      .items_center()
      .when(r.kind === "hunk", (el) => el.bg(t.raised))
      .text_color(t.muted)
      .child(div().min_w(0).truncate().child(r.text));
  }
  const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : r.kind === "cut" ? "·" : " ";
  const hasComment = meta.comment !== null;
  const stale = Boolean(meta.comment?.stale);
  const barColor = stale ? t.blocked : t.accent;
  return h_flex()
    .h(ROW)
    .w_full()
    .flex_none()
    .relative()
    .items_center()
    .when(meta.active, (el) => el.bg(t.selected))
    .when(!meta.active && hasComment, (el) => el.bg(t.raised))
    .when(!meta.active && !hasComment && r.kind === "add", (el) => el.bg(ADDED_TINT))
    .when(!meta.active && !hasComment && r.kind === "del", (el) => el.bg(REMOVED_TINT))
    .when(meta.clickable, (el) => el.cursor_pointer().hover((s) => s.bg(meta.active ? t.selected : t.hover)))
    .when(meta.active || hasComment, (el) =>
      el.child(div().absolute().left(0).top(2).bottom(2).w(2).rounded(1).bg(barColor)),
    )
    .child(
      h_flex()
        .w(16)
        .flex_none()
        .items_center()
        .justify_center()
        .when(meta.clickable, (el) =>
          el.child(
            svg(ICONS.plus)
              .size(10)
              .flex_none()
              .text_color(meta.active || hasComment ? barColor : t.dim),
          ),
        ),
    )
    .child(div().w(36).flex_none().pr(6).text_right().text_color(t.muted).child(num(r.old)))
    .child(div().w(36).flex_none().pr(6).text_right().text_color(t.muted).child(num(r.new)))
    .child(div().w(14).flex_none().text_color(t.muted).child(sign))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_color(r.kind === "cut" ? t.muted : t.foreground)
        .child(r.kind === "cut" ? `Line too large to show (${size(r.bytes ?? 0)})` : r.text),
    )
    .when(hasComment, (el) =>
      el.child(
        div()
          .flex_none()
          .pr(8)
          .child(pill(t, stale ? "stale" : "comment", stale ? "blocked" : "accent")),
      ),
    );
}
