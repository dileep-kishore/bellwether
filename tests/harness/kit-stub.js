// Fake "gpui-kit" and "gpui-base" for the headless harness. Elements keep their children,
// attributes and handlers so tests can walk the tree and fire events. Adapted from Flockbook's
// herdr-app/test/stub/ui.mjs (MIT, see THIRD_PARTY_NOTICES.md); unlike its any-method Proxy, an
// element refuses a builder method that `interface NativeElement` does not declare.
import { existsSync } from "node:fs";
import { join } from "node:path";
import api from "./api.json";
import { inPhase, refuse, repo } from "./herdr-stub.js";

const ELEMENT = new Set(api.element);
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

/** @param {string} tag @param {Record<string, any>} [attrs] @returns {El} */
function make(tag, attrs = {}) {
  /** @type {Node} */
  const node = { tag, kids: [], attrs: { ...attrs }, handlers: {}, parent: null };
  /** @type {El} */
  const el = new Proxy(node, {
    get(t, k) {
      if (k === NODE) return t;
      if (typeof k === "symbol") return undefined;
      if (FIELDS.includes(k)) return /** @type {any} */ (t)[k];
      if (PROBES.has(k) || !/^[a-z][a-z0-9_]*$/.test(k)) return undefined;
      if (!ELEMENT.has(k)) refuse(`unknown builder method ${k}`);
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

/** @param {string} name */
function unfaked(name) {
  const fail = () => { throw new Error(`stub: ${name} not faked`); };
  return new Proxy(fail, { get: (_t, k) => (typeof k === "symbol" || PROBES.has(k) ? undefined : fail()) });
}

const kitImpl = { View, div, svg, image };
const baseImpl = { h_flex, v_flex, Button, InputState, Input };

/** @param {string[]} names @param {Record<string, unknown>} impl */
const namespace = (names, impl) => Object.fromEntries(names.map((n) => [n, impl[n] ?? unfaked(n)]));

export const kitModule = namespace(api.kit, kitImpl);
export const baseModule = namespace(api.base, baseImpl);
