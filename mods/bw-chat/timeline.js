// The chat's rows as elements, in a virtual list opened at the newest row. Adapted from Flockbook's
// herdr-app/mods/flockbook/chat.js (MIT, see THIRD_PARTY_NOTICES.md): rows, tool lines and the list;
// cards, the top bar, the helper card and menus dropped. Heights are estimate.js's guesses, so every
// element here is drawn to the height rowHeight counts for it.
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { BUBBLE, GUTTER, PIC_GAP, PIC_MAX } from "./estimate.js";
import { markdownView } from "./mdblocks.js";
import { megabytes } from "./target.js";
import { ICONS, chip, statusMark } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */

/** @param {string} name */
export const icon = (name) => `mods/bw-chat/icons/${name}.svg`;

/** A tool chip's SF Symbols name as one of this mod's icons. @param {unknown} symbol */
export function chipIcon(symbol) {
  const s = String(symbol ?? "");
  if (s.startsWith("terminal")) return icon("terminal");
  if (s.includes("pencil")) return icon("edit");
  if (s.startsWith("doc")) return icon("file");
  if (s.includes("magnifyingglass")) return icon("search");
  if (s.startsWith("globe")) return icon("web");
  if (s.startsWith("person")) return icon("agent");
  return icon("tool");
}

/** A text's first line with something in it, and " …" when more lines follow. @param {unknown} text */
export function oneLine(text) {
  const lines = String(text ?? "")
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\t/g, " ").trim());
  const i = lines.findIndex(Boolean);
  if (i < 0) return "";
  return lines.slice(i + 1).some(Boolean) ? `${lines[i]} …` : lines[i];
}

/**
 * @typedef {import("./feedstate.js").Row} Row
 * @typedef {ReturnType<typeof import("./pictures.js").createPictures>} Pictures
 * @typedef {object} Draw
 * @property {Theme} t themeColors()
 * @property {number} pane the pane's width
 * @property {number} col the reading column's width
 * @property {string} agent "Claude" or "Codex"
 * @property {boolean} blocked the terminal reports the agent is waiting on the person
 * @property {Set<string>} open tools rows showing their calls
 * @property {Pictures} pictures
 */

/** A row the person can answer only in the terminal (a picker question, a prompt). @param {Row} row */
export const waitsInTerminal = (row) =>
  (row.k === "perm" && row.perm?.state === "pending") ||
  (row.k === "question" && row.question?.state === "pending" && row.question?.delivery !== "message");

/** @param {Draw} d @param {string} text @param {any} glyph */
function notice(d, text, glyph) {
  return h_flex()
    .w_full()
    .h(44)
    .items_center()
    .child(
      h_flex()
        .h(28)
        .max_w(Math.floor(d.col * 0.9))
        .px(10)
        .gap(6)
        .items_center()
        .rounded(14)
        .bg(d.t.chrome)
        .border(1)
        .border_color(d.t.border)
        .text_size(12.5)
        .text_color(d.t.muted)
        .child(glyph)
        .child(div().min_w(0).truncate().child(text)),
    );
}

const check = (/** @type {Draw} */ d) => statusMark(d.t, "done", 12);
const spinner = (/** @type {Draw} */ d) => statusMark(d.t, "working", 12);
// The person is needed: a Peach mark that breathes until the request is answered.
const waiting = (/** @type {Draw} */ d) => statusMark(d.t, "blocked", 12);

/** @param {Row} row @param {Draw} d */
function perm(row, d) {
  if (row.perm?.state !== "pending") return notice(d, oneLine(row.text || row.perm?.title) || "A tool ran", check(d));
  // herdr-core shows every call without a result this way; only the terminal's status says it waits on the person.
  if (d.blocked) return notice(d, `${d.agent} is waiting for you · Answer in terminal (⌘J)`, waiting(d));
  return notice(d, `Running · ${oneLine(row.perm?.command || row.text) || "a tool"}`, spinner(d));
}

/** @param {Row} row @param {Draw} d */
function question(row, d) {
  const q = row.question;
  if (q?.state === "pending") {
    const text =
      q.delivery === "message"
        ? `${d.agent} is waiting for your answer · Reply below`
        : `${d.agent} is waiting for you · Answer in terminal (⌘J)`;
    return notice(d, text, waiting(d));
  }
  const asked = oneLine(q?.questions?.[0]?.text);
  const answers = Array.isArray(q?.answers) && q.answers.length ? ` · ${q.answers.join(", ")}` : "";
  const text = q?.state === "declined" ? `Declined “${asked}”` : `Asked “${asked}”${answers}`;
  return notice(d, text, check(d));
}

/** One 22 px line per call: name, summary, the output's first line in monospace, and its state.
 * @param {Row} row @param {Draw} d */
function calls(row, d) {
  const all = (row.chips ?? []).flatMap((/** @type {any} */ c) => c.calls ?? []);
  return v_flex()
    .w_full()
    .pl(22)
    .children(
      all.map((/** @type {any} */ k, /** @type {number} */ i) =>
        h_flex()
          .id(`call-${row.id}-${i}`)
          .h(22)
          .w_full()
          .overflow_hidden()
          .gap(8)
          .items_center()
          .text_size(12)
          .child(
            div()
              .flex_none()
              .text_color(d.t.foreground)
              .child(oneLine(k.name) || "tool"),
          )
          .child(div().flex_1().min_w(0).truncate().text_color(d.t.muted).child(oneLine(k.summary)))
          .when(Boolean(oneLine(k.output)), (el) =>
            el.child(
              div()
                .flex_none()
                .max_w(Math.floor(d.col * 0.35))
                .truncate()
                .font_family("Menlo")
                .text_size(11.5)
                .text_color(d.t.muted)
                .child(oneLine(k.output)),
            ),
          )
          .child(k.error ? div().flex_none().text_color(d.t.blocked).child("failed") : k.done ? check(d) : spinner(d)),
      ),
    );
}

/** @param {Row} row @param {Draw} d */
function tools(row, d) {
  const open = d.open.has(row.id);
  const first = row.chips?.[0];
  const text = row.sentence || (row.chips ?? []).map((/** @type {any} */ c) => c.text).join(", ");
  const line = h_flex()
    .h(28)
    .w_full()
    .items_center()
    .child(
      chip(d.t, { color: row.error ? d.t.blocked : undefined })
        .child(
          row.live ? spinner(d) : row.error ? svg(ICONS.close).size(12).flex_none().text_color(d.t.blocked) : check(d),
        )
        .child(svg(chipIcon(first?.symbol)).size(14).flex_none())
        .child(div().min_w(0).truncate().child(text))
        .child(
          svg(open ? ICONS["chevron-down"] : ICONS["chevron-right"])
            .size(10)
            .flex_none()
            .text_color(d.t.dim),
        ),
    );
  return open ? v_flex().w_full().child(line).child(calls(row, d)) : line;
}

/** @param {Row} row @param {Draw} d */
function changed(row, d) {
  return h_flex()
    .h(28)
    .w_full()
    .items_center()
    .child(
      chip(d.t)
        .child(svg(icon("changes")).size(14).flex_none())
        .child(
          div()
            .min_w(0)
            .truncate()
            .child(row.text || "Changed files"),
        )
        .child("·")
        .child(div().flex_none().font_medium().text_color(d.t.accent).child("Open in Changes")),
    );
}

/** A picture's drawn size: the column's width, at most PIC_MAX tall, as estimate.js counts it.
 * @param {any} p @param {number} col */
function picSize(p, col) {
  if (!(p.width > 0 && p.height > 0)) return { w: col, h: PIC_MAX };
  const h = Math.min(PIC_MAX, (col * p.height) / p.width);
  return { w: Math.min(col, (h * p.width) / p.height), h };
}

/** @param {any} p @param {Draw} d */
function picture(p, d) {
  const { w, h } = picSize(p, d.col);
  const file = d.pictures.fileOf(p.digest);
  if (file) return image(file).w(w).h(h).flex_none().mb(PIC_GAP).rounded(10);
  const state = d.pictures.stateOf(p.digest);
  const bytes = d.pictures.bytesOf(p.digest);
  const text =
    state === "too_big"
      ? `Picture too large${bytes === null ? "" : ` (${megabytes(bytes)})`}`
      : state === "gone" || state === "failed"
        ? "Picture unavailable"
        : "Loading picture…";
  return h_flex()
    .w(Math.max(w, Math.min(d.col, 200)))
    .h(h)
    .flex_none()
    .mb(PIC_GAP)
    .gap(6)
    .items_center()
    .justify_center()
    .rounded(10)
    .bg(d.t.chrome)
    .border(1)
    .border_color(d.t.border)
    .text_size(12)
    .text_color(d.t.muted)
    .child(svg(icon("picture")).size(14).flex_none())
    .child(text);
}

/** A row's content, without the list's fixed height. No handlers: list rows cannot have any.
 * @param {Row} row @param {Draw} d */
function body(row, d) {
  const t = d.t;
  switch (row.k) {
    case "user": {
      const w = Math.floor(d.col * BUBBLE);
      // The bubble takes its width from its TextView, which keeps the width it last wrapped at under its
      // id: without the width in the id, a bubble drawn narrow stays narrow in a wider pane and is cut.
      return h_flex()
        .w_full()
        .justify_end()
        .py(8)
        .child(
          v_flex()
            .max_w(w)
            .px(14)
            .py(10)
            .rounded(16)
            .bg(t.raised)
            .text_color(t.foreground)
            .child(markdownView(`${row.id}-w${w}`, row.text || "", t, w - 28)),
        );
    }
    case "assistant":
      return div()
        .w_full()
        .py(8)
        .text_color(t.foreground)
        .child(markdownView(row.id, row.text || "", t, d.col));
    case "tools":
      return tools(row, d);
    case "changed":
      return changed(row, d);
    case "perm":
      return perm(row, d);
    case "question":
      return question(row, d);
    case "sep":
      return h_flex()
        .w_full()
        .h(40)
        .items_center()
        .justify_center()
        .text_size(11.5)
        .text_color(t.muted)
        .child(row.text || "");
    case "footer":
      return div()
        .w_full()
        .h(30)
        .pt(2)
        .text_size(11.5)
        .text_color(t.muted)
        .child(row.text || "");
    case "status":
      return h_flex()
        .w_full()
        .h(34)
        .items_center()
        .justify_center()
        .text_size(12)
        .text_color(t.muted)
        .child(oneLine(row.text));
    default:
      return div().h(30);
  }
}

/** @param {Row} row @param {Draw} d @param {number} height */
function item(row, d, height) {
  const pad = Math.max(GUTTER, Math.floor((d.pane - d.col) / 2));
  const pics = /** @type {any[]} */ (row.pics ?? []);
  return div()
    .h(height)
    .w_full()
    .px(pad)
    .overflow_hidden()
    .child(
      v_flex()
        .w_full()
        .child(body(row, d))
        .when(pics.length > 0, (el) =>
          el.child(
            v_flex()
              .w_full()
              .when(row.k === "user", (x) => x.items_end())
              .children(pics.map((p) => picture(p, d))),
          ),
        ),
    );
}

/**
 * @typedef {object} ListHooks
 * @property {number[]} sizes one height per row
 * @property {any} scroll the VirtualListScrollHandle
 * @property {(key: string, cx: any) => void} onClick
 * @property {(e: any, cx: any) => void} onWheel
 * @property {(range: { start: number, end: number }) => void} onRange called from layout: plain fields only
 */

/** @param {Row[]} rows @param {Draw} d @param {ListHooks} h */
export function timeline(rows, d, h) {
  return v_flex()
    .id("timeline")
    .relative()
    .flex_1()
    .min_h(0)
    .on_scroll_wheel(h.onWheel)
    .child(
      v_virtual_list(
        "chat",
        rows.length,
        h.sizes,
        (i) => rows[i].id,
        (range) => {
          h.onRange(range);
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(item(rows[i], d, h.sizes[i]));
          return out;
        },
      )
        .track_scroll(h.scroll)
        .on_item_click(h.onClick),
    )
    .child(Scrollbar.vertical("chat").absolute().inset_0());
}
