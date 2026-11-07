// Fake "gpui-kit" and "gpui-base" for the headless harness. Elements keep their children,
// attributes and handlers so tests can walk the tree and fire events. Adapted from Flockbook's
// herdr-app/test/stub/ui.mjs (MIT, see THIRD_PARTY_NOTICES.md); unlike its any-method Proxy, an
// element refuses a builder method that `interface NativeElement` does not declare.
import { existsSync } from "node:fs";
import { join } from "node:path";
import api from "./api.json";
import { inPhase, phase, refuse, repo, touch } from "./herdr-stub.js";

const ELEMENT = new Set(api.element);
const IFACES = /** @type {Record<string, string[]>} */ (api.baseMembers.interfaces);
const CONSTS = /** @type {Record<string, string[]>} */ (api.baseMembers.consts);
/** @param {string} name */
const ifaceSet = (name) => {
  if (!IFACES[name]) throw new Error(`kit-stub: api.json declares no interface ${name}`);
  return new Set(IFACES[name]);
};
const DECLARE = new Set(api.elementDeclare);
const NODE = Symbol("element");
// Names runtimes and test tools probe on any object (await, expect, inspect); they are not builder calls.
const PROBES = new Set(["then", "constructor", "nodeType", "length", "prototype", "inspect", "asymmetricMatch"]);
const FIELDS = ["tag", "kids", "attrs", "handlers"];
for (const f of FIELDS) if (ELEMENT.has(f)) throw new Error(`kit-stub: element field ${f} is now a builder method; rename the field`);

/**
 * @typedef {{ tag: string, kids: unknown[], attrs: Record<string, any>, handlers: Record<string, Function>, parent: Node | null }} Node
 * @typedef {any} El
 */

let modRoot = "mods";
/** Where mount loads mods from, so a fixture mod's own `mods/bw-x/…` files count as existing. @param {string} root */
export function setModRoot(root) { modRoot = root; }

/** @param {string} kind @param {unknown} path */
function checkPath(kind, path) {
  if (typeof path !== "string") refuse(`${kind} path must be a string, got ${typeof path}`);
  if (path.startsWith("icons/")) return;
  // bw picture and bw browser tabs copy pictures and favicons here, relative to the app home as image() reads them.
  if (kind === "image" && /^data\/bellwether\/(pictures|favicons)\/[0-9a-f]{16}\.[a-z0-9]+$/.test(path)) return;
  const m = /^mods\/(bw-[^/]+)\/(.+)$/.exec(path);
  if (m && (existsSync(join(repo, path)) || existsSync(join(repo, modRoot, m[1], m[2])))) return;
  refuse(`${kind} path ${path} is neither an existing mods/bw-* file nor icons/…`);
}

/** @param {Node} node @param {unknown} c */
function addChild(node, c) {
  const n = /** @type {any} */ (c)?.[NODE];
  if (n) {
    if (n.parent) refuse("element used twice as a child: an element is consumed when it is added");
    n.parent = node;
  }
  node.kids.push(c);
}

// Depth of virtual-list renderers running now: Herdr calls them inside layout and refuses handlers there.
let layoutDepth = 0;

/** @param {string} tag @param {Record<string, any>} [attrs] @param {Set<string> | null} [extra] methods beyond NativeElement's
 * @returns {El} */
function make(tag, attrs = {}, extra = null) {
  /** @type {Node} */
  const node = { tag, kids: [], attrs: { ...attrs }, handlers: {}, parent: null };
  /** @type {El} */
  const el = new Proxy(node, {
    get(t, k) {
      if (k === NODE) return t;
      if (typeof k === "symbol") return undefined;
      if (FIELDS.includes(k)) return /** @type {any} */ (t)[k];
      if (PROBES.has(k) || !/^[a-z][a-z0-9_]*$/.test(k)) return undefined;
      if (!ELEMENT.has(k) && !extra?.has(k)) refuse(`unknown builder method ${k}`);
      return (/** @type {any[]} */ ...a) => call(el, t, k, a);
    },
  });
  return el;
}

/** @param {El} el @param {Node} t @param {string} k @param {any[]} a */
function call(el, t, k, a) {
  if (k === "child") { addChild(t, a[0]); return el; }
  if (k === "children") { for (const c of a[0]) addChild(t, c); return el; }
  if (k === "map") return a[0](el);
  if (k === "when") return a[0] ? a[1](el) : el;
  if (DECLARE.has(k)) {
    // Style callbacks get a scratch element, so builder names inside hover() are checked too.
    const scratch = make(k);
    a[0](scratch);
    t.attrs[k] = scratch[NODE].attrs;
    return el;
  }
  if (k.startsWith("on_")) {
    if (layoutDepth) refuse(`${k} inside a virtual list's renderer: use on_item_click on the list`);
    const fn = a.findLast((x) => typeof x === "function");
    const button = a.length > 1 && typeof a[0] === "string" ? a[0] : null;
    t.handlers[button && button !== "left" ? `${k}:${button}` : k] = fn;
    if (button === "left") t.handlers[`${k}:left`] = fn;
    return el;
  }
  t.attrs[k] = a.length <= 1 ? a[0] : a;
  return el;
}

/** @param {unknown} x */
export const isElement = (x) => typeof x === "string" || Boolean(/** @type {any} */ (x)?.[NODE]);

/** Depth first, the first element whose id is `id`. @param {El} el @param {string} id @returns {El | null} */
export function byId(el, id) {
  return findAll(el, (e) => e.attrs.id === id)[0] ?? null;
}

/** Every element, depth first, for which `pred` is true. @param {El} el @param {(e: El) => boolean} pred @returns {El[]} */
export function findAll(el, pred) {
  /** @type {El[]} */
  const out = [];
  const walk = (/** @type {any} */ e) => {
    if (!e?.[NODE]) return;
    if (pred(e)) out.push(e);
    for (const k of e.kids) walk(k);
  };
  walk(el);
  return out;
}

/** All text in a tree, joined by spaces. @param {unknown} el @returns {string} */
export function textOf(el) {
  if (el == null || typeof el === "boolean") return "";
  if (typeof el === "string" || typeof el === "number") return String(el);
  const e = /** @type {any} */ (el);
  if (!e[NODE]) return "";
  return e.kids.map(textOf).filter(Boolean).join(" ");
}

/** Runs one of an element's handlers ("on_click", "on_mouse_down:right", …) with phase "event".
 * @param {El} el @param {string} handler @param {...unknown} args */
export function fire(el, handler, ...args) {
  const fn = el?.handlers?.[handler];
  if (!fn) throw new Error(`no ${handler} handler on ${el?.attrs?.id ?? el?.tag ?? "that element"}`);
  return inPhase("event", () => fn(...args));
}

export class View {
  /** @param {unknown} [_props] */
  constructor(_props) {}
}

export const div = () => make("div");
export const svg = (/** @type {string} */ path) => { checkPath("svg", path); return make("svg", { path }); };
export const image = (/** @type {string} */ path) => { checkPath("image", path); return make("image", { path }); };
export const h_flex = () => make("h_flex");
export const v_flex = () => make("v_flex");

export const Button = { new: (/** @type {string | number} */ id) => make("Button", { id }) };

export const InputState = {
  new: (/** @type {{ placeholder?: string, value?: string }} */ o = {}) => {
    let v = o.value ?? "";
    /** @type {Record<string, Function>} */
    const handlers = {};
    return {
      placeholder: o.placeholder,
      handlers,
      value: () => v,
      set_value: (/** @type {string} */ x) => { v = String(x); },
      replace: (/** @type {string} */ x) => { v = String(x); },
      on: (/** @type {string} */ e, /** @type {Function} */ f) => { handlers[e] = f; return true; },
      focus() {},
      release: () => true,
    };
  },
};
export const Input = { new: (/** @type {unknown} */ state) => make("Input", { state }) };

/** What a test may read or set on a host object the stubs made (a TextareaState's value, a handle's scrolls). */
const INTERNAL = new WeakMap();
/** @param {object} obj @returns {any} */
export const inspect = (obj) => INTERNAL.get(obj);

/**
 * A retained host object that answers only the members `interface <name>` declares.
 * @param {string} name @param {Record<string, Function>} impl @param {Record<string, any>} rec
 */
function hostObject(name, impl, rec) {
  const declared = ifaceSet(name);
  for (const k of Object.keys(impl)) if (!declared.has(k)) throw new Error(`kit-stub: ${name}.${k} is not declared`);
  const obj = new Proxy(impl, {
    get(t, k) {
      if (typeof k === "symbol" || PROBES.has(k)) return undefined;
      if (!declared.has(k)) refuse(`${name} has no ${k}`);
      if (rec.released && k !== "release") refuse(`${name} used after release`);
      const fn = t[k];
      if (!fn) return () => { throw new Error(`stub: ${name}.${k} not faked`); };
      return (/** @type {any[]} */ ...a) => { touch(); return fn(...a); };
    },
  });
  INTERNAL.set(obj, rec);
  return obj;
}

/** @param {string} name */
function noRetainedStateHere(name) {
  if (phase() === "render" || layoutDepth) refuse(`${name}.new in render: create it in init or in an event handler`);
}

/**
 * The namespace object of `export const <name>: {…}`, with every declared member faked or refusing.
 * @param {string} name @param {Record<string, Function>} impl
 */
function constObject(name, impl) {
  const declared = CONSTS[name];
  if (!declared) throw new Error(`kit-stub: api.json declares no const ${name}`);
  for (const k of Object.keys(impl)) if (!declared.includes(k)) throw new Error(`kit-stub: ${name}.${k} is not declared`);
  /** @type {Record<string, Function>} */
  const out = {};
  for (const k of declared) out[k] = impl[k] ?? (() => { throw new Error(`stub: ${name}.${k} not faked`); });
  return out;
}

const TEXT_VIEW = ifaceSet("TextViewElement");
// The text goes in as the element's one child, so textOf reads it like any drawn text.
const textView = (/** @type {string} */ kind) => (/** @type {string} */ id, /** @type {string} */ text) => {
  if (typeof id !== "string" || !id) refuse(`TextView.${kind} needs a string id`);
  const el = make("TextView", { id, [kind]: String(text) }, TEXT_VIEW);
  el.kids.push(String(text));
  return el;
};
export const TextView = constObject("TextView", { html: textView("html"), markdown: textView("markdown") });

const TEXTAREA_EVENTS = new Set(["change", "submit", "focus", "blur", "paste_other"]);
export const TextareaState = constObject("TextareaState", {
  new: (/** @type {{ placeholder?: string, value?: string, rows?: number }} */ o = {}) => {
    noRetainedStateHere("TextareaState");
    const rec = { value: o.value ?? "", placeholder: o.placeholder ?? null, rows: o.rows ?? null, autoGrow: /** @type {number[] | null} */ (null),
      softWrap: true, focused: 0, released: false, /** @type {Record<string, Function>} */ handlers: {} };
    return hostObject("TextareaState", {
      value: () => rec.value,
      set_value: (/** @type {any} */ x) => { rec.value = typeof x === "string" ? x : String(x?.text ?? ""); },
      replace: (/** @type {string} */ x) => { rec.value += String(x); },
      on: (/** @type {string} */ e, /** @type {Function} */ f) => {
        if (!TEXTAREA_EVENTS.has(e)) refuse(`TextareaState.on: unknown event ${e}`);
        rec.handlers[e] = f;
        return true;
      },
      set_rows: (/** @type {number} */ n) => { rec.rows = n; },
      set_auto_grow: (/** @type {number} */ a, /** @type {number} */ b) => { rec.autoGrow = [a, b]; },
      set_soft_wrap: (/** @type {boolean} */ w) => { rec.softWrap = w; },
      focus: () => { rec.focused++; },
      release: () => { rec.released = true; return true; },
    }, rec);
  },
});
export const Textarea = constObject("Textarea", { new: (/** @type {unknown} */ state) => make("Textarea", { state }) });

/** Runs a retained state's handler for `event` as Herdr would, with phase "event". @param {object} state
 * @param {string} event @param {unknown} payload @param {unknown} cx */
export function emit(state, event, payload, cx) {
  const fn = inspect(state)?.handlers?.[event];
  if (!fn) throw new Error(`no ${event} handler on that state`);
  return inPhase("event", () => fn(payload, cx));
}

export const VirtualListScrollHandle = constObject("VirtualListScrollHandle", {
  new: () => {
    noRetainedStateHere("VirtualListScrollHandle");
    const rec = { released: false, /** @type {unknown[][]} */ calls: [] };
    return hostObject("VirtualListScrollHandle", {
      scroll_to_item: (/** @type {number} */ i, /** @type {string | undefined} */ strategy) => {
        if (!Number.isInteger(i) || i < 0) refuse(`scroll_to_item(${i}): not an index`);
        if (strategy !== undefined && strategy !== "top" && strategy !== "center") refuse(`scroll_to_item: unknown strategy ${strategy}`);
        rec.calls.push(["item", i, strategy]);
      },
      scroll_to_bottom: () => { rec.calls.push(["bottom"]); },
      release: () => { rec.released = true; return true; },
    }, rec);
  },
});

const bar = (/** @type {string} */ axis) => (/** @type {string | number} */ id) => make("Scrollbar", { id, axis });
export const Scrollbar = constObject("Scrollbar", { new: bar("both"), horizontal: bar("horizontal"), vertical: bar("vertical") });

// What a renderer's cx may do inside layout: nothing that asks for a frame or makes state.
const layoutCx = new Proxy({}, {
  get(_t, k) {
    if (typeof k === "symbol" || PROBES.has(k)) return undefined;
    return () => refuse(`cx.${String(k)}() inside a virtual list's renderer`);
  },
});

/**
 * Herdr calls `render` during layout with the visible range; the stub shows every row at once.
 * @param {string | number} id @param {number} count @param {number | number[]} sizes
 * @param {(i: number) => string} getKey @param {(range: { start: number, end: number }, cx: unknown) => unknown[]} render
 */
export function v_virtual_list(id, count, sizes, getKey, render) {
  if (!Number.isInteger(count) || count < 0) refuse(`v_virtual_list ${id}: item_count ${count} is not a count`);
  if (Array.isArray(sizes)) {
    if (sizes.length !== count) refuse(`v_virtual_list ${id}: ${sizes.length} sizes for ${count} items`);
    if (!sizes.every((h) => Number.isFinite(h) && h >= 0)) refuse(`v_virtual_list ${id}: a size is not a number of px`);
  } else if (!Number.isFinite(sizes) || sizes < 0) refuse(`v_virtual_list ${id}: size ${sizes} is not a number of px`);
  if (typeof getKey !== "function" || typeof render !== "function") refuse(`v_virtual_list ${id}: get_key and render are required`);
  const keys = Array.from({ length: count }, (_v, i) => getKey(i));
  const seen = new Set();
  for (const k of keys) {
    if (typeof k !== "string") refuse(`v_virtual_list ${id}: get_key gave ${typeof k}, not a string`);
    if (seen.has(k)) refuse(`v_virtual_list ${id}: duplicate key ${k}`);
    seen.add(k);
  }
  layoutDepth++;
  let items;
  try {
    items = render({ start: 0, end: count }, layoutCx);
  } finally {
    layoutDepth--;
  }
  if (!Array.isArray(items) || items.length !== count) refuse(`v_virtual_list ${id}: render returned ${items?.length} elements for ${count} items`);
  const el = make("VirtualList", { id, count, sizes, keys });
  for (const c of /** @type {unknown[]} */ (items)) addChild(el[NODE], c);
  renderers.set(el[NODE], render);
  return el;
}

/** @type {WeakMap<object, (range: { start: number, end: number }, cx: unknown) => unknown[]>} */
const renderers = new WeakMap();

/**
 * Lays a virtual list out again with another range, as Herdr does on a scroll the mod never sees
 * (a scrollbar drag) or when it measures one representative row. Returns how many elements came back.
 * @param {El} list @param {{ start: number, end: number }} range
 */
export function layOut(list, range) {
  const render = renderers.get(list?.[NODE]);
  if (!render) throw new Error("layOut: not a virtual list");
  layoutDepth++;
  try {
    return /** @type {unknown[]} */ (render(range, layoutCx)).length;
  } finally {
    layoutDepth--;
  }
}

/** @param {string} name */
function unfaked(name) {
  const fail = () => { throw new Error(`stub: ${name} not faked`); };
  return new Proxy(fail, { get: (_t, k) => (typeof k === "symbol" || PROBES.has(k) ? undefined : fail()) });
}

const kitImpl = { View, div, svg, image };
const baseImpl = { h_flex, v_flex, Button, InputState, Input, TextView, Textarea, TextareaState, VirtualListScrollHandle, Scrollbar, v_virtual_list };

/** @param {string[]} names @param {Record<string, unknown>} impl */
const namespace = (names, impl) => Object.fromEntries(names.map((n) => [n, impl[n] ?? unfaked(n)]));

export const kitModule = namespace(api.kit, kitImpl);
export const baseModule = namespace(api.base, baseImpl);
