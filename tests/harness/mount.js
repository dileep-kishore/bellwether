// Loads one mod the way Herdr does (init, its tasks, render) against fake live data, and throws
// after every step on a rule the mod broke.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeCx } from "./cx.js";
import { fake, inPhase, log, repo, reset, violations } from "./herdr-stub.js";
import { byId, fire, setModRoot } from "./kit-stub.js";

export { repo };

const NO_MODIFIERS = { shift: false, control: false, alt: false, platform: false, function: false };
let loads = 0;

/** A fresh copy of tests/fixtures/live/<name>.json. @param {string} name @returns {Record<string, any>} */
export function live(name) {
  return JSON.parse(readFileSync(join(repo, "tests/fixtures/live", `${name}.json`), "utf8"));
}

function check() {
  if (violations.length) throw violations[0];
}

/**
 * @param {string} name a folder under `root`, e.g. "bw-projects"
 * @param {{ props?: Record<string, unknown>, live?: Record<string, any>, root?: string }} [opts]
 */
export async function mount(name, { props = {}, live: data = {}, root = "mods" } = {}) {
  reset();
  Object.assign(fake, data);
  fake.props = props;
  setModRoot(root);

  const file = join(repo, root, name, "main.js");
  if (!existsSync(file)) throw new Error(`no ${root}/${name}/main.js`);
  // The query makes Bun load a fresh copy, so module state never leaks between mounts.
  const mod = await import(`${file}?mount=${++loads}`);
  const ViewClass = mod.default;
  if (typeof ViewClass !== "function") throw new Error(`${root}/${name}/main.js has no default View class`);

  const cx = makeCx();
  // Herdr calls init with undefined as its first argument; a mod reads its props through props().
  const view = inPhase("init", () => new ViewClass());
  await inPhase("init", async () => view.init?.(undefined, cx));
  check();
  await cx.flush();
  check();

  /** @type {any} */
  let el = null;
  const render = () => {
    el = inPhase("render", () => view.render(cx));
    check();
    return el;
  };

  /** Fires on_click on the element with that id, runs the tasks it started, and renders again. @param {string} id */
  const click = async (id) => {
    const target = byId(el, id);
    if (!target) throw new Error(`no element with id ${id}`);
    await fire(target, "on_click", { click_count: 1, modifiers: NO_MODIFIERS }, cx);
    check();
    await cx.flush();
    check();
    return render();
  };

  /** Runs the i-th timer.every callback with phase "timer", then the tasks it started. @param {number} i */
  const tickTimer = async (i) => {
    const t = cx.timers[i];
    if (!t) throw new Error(`no timer.every #${i} (${cx.timers.length} registered)`);
    await inPhase("timer", async () => t.fn(cx));
    check();
    await cx.flush();
    check();
  };

  render();
  return {
    view,
    cx,
    get el() {
      return el;
    },
    render,
    click,
    tickTimer,
    log,
  };
}
