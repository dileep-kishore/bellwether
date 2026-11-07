// What a click in the project sidebar runs. Pure: each returns commands or an overlay spec.

/** @typedef {import("./projects-model.js").WorktreeNode} WorktreeNode */
/** @typedef {import("./projects-model.js").ProjectNode} ProjectNode */
/** @typedef {import("./projects-model.js").AgentLine} AgentLine */
/** @typedef {[string, Record<string, unknown>]} Command */

/**
 * @typedef {object} OverlaySpec
 * @property {string} mod
 * @property {"popup" | "dialog"} kind
 * @property {number} width
 * @property {number} [height]
 * @property {Record<string, unknown>} [props]
 */

/**
 * An open worktree goes to its first space; a closed one becomes a space there. `machine: ""` is this
 * Mac: omitted, Herdr would use the focused space's machine.
 *
 * @param {WorktreeNode} node
 * @param {string | null} machine
 * @returns {Command[]}
 */
export function openWorktree(node, machine) {
  if (node.prunable) return [];
  if (node.open && node.spaces.length) return [["space.select", { id: node.spaces[0] }]];
  return [["space.new", { folder: node.path, machine: machine ?? "" }]];
}

/**
 * @param {AgentLine} a
 * @returns {Command[]}
 */
export function focusAgent(a) {
  return [
    ["space.select", { id: a.space }],
    ["tab.select", { id: a.tab }],
    ["agent.focus", { terminal: a.address }],
  ];
}

/**
 * @param {ProjectNode} p
 * @returns {OverlaySpec}
 */
export function projectMenu(p) {
  const { key, machine, commonDir, main, name, open } = p;
  return {
    mod: "bw-menu",
    kind: "popup",
    width: 220,
    props: { project: { key, machine, commonDir, main, name, open } },
  };
}

/** @returns {OverlaySpec} */
export function addProject() {
  return { mod: "bw-add", kind: "dialog", width: 420, height: 220 };
}

/**
 * @param {ProjectNode} p
 * @returns {OverlaySpec}
 */
export function newInMain(p) {
  return { mod: "bw-new", kind: "popup", width: 232, height: 300, props: { machine: p.machine, folder: p.main } };
}
