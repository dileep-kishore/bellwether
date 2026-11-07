// Which of a chat's pictures to copy next with `bw picture`, and what each one shows. Pure.
// One fetch at a time and one try per digest: a picture that failed stays a placeholder for this chat.

/**
 * @typedef {object} Pic One entry of a row's `pics`.
 * @property {string} digest
 * @property {string} format
 * @property {number} width
 * @property {number} height
 * @property {number} offset
 * @property {number} index
 */

/** @typedef {"loading" | "ready" | "too_big" | "gone" | "failed"} PicState */

const FILE = /^data\/bellwether\/pictures\/[0-9a-f]{16}\.[a-z0-9]+$/;
const DIGEST = /^[0-9a-f]{16}$/;

/** @param {unknown} p @returns {p is Pic} */
const isPic = (p) => {
  const x = /** @type {any} */ (p);
  return Boolean(x) && typeof x.digest === "string" && DIGEST.test(x.digest)
    && Number.isInteger(x.offset) && x.offset >= 0 && Number.isInteger(x.index) && x.index >= 0;
};

export function createPictures() {
  /** @type {Map<string, { state: PicState, file: string | null, bytes: number | null }>} */
  const seen = new Map();
  let inFlight = false;

  return {
    /** Pictures not tried yet, newest row first; none while one is being fetched.
     * @param {{ pics?: unknown[] }[]} rows @returns {Pic[]} */
    wanted(rows) {
      if (inFlight) return [];
      /** @type {Pic[]} */
      const out = [];
      const listed = new Set();
      for (let i = rows.length - 1; i >= 0; i--) {
        for (const p of rows[i].pics ?? []) {
          if (!isPic(p) || seen.has(p.digest) || listed.has(p.digest)) continue;
          listed.add(p.digest);
          out.push(p);
        }
      }
      return out;
    },
    /** @param {string} digest */
    start(digest) {
      inFlight = true;
      seen.set(digest, { state: "loading", file: null, bytes: null });
    },
    /**
     * @param {string} digest
     * @param {{ ok: boolean, lines?: any[] }} answer what `helper.call(null, ["picture", …])` resolved
     */
    done(digest, answer) {
      inFlight = false;
      const line = answer.ok ? (answer.lines ?? []).find((l) => l?.type === "picture" && l.digest === digest) : null;
      const bytes = typeof line?.bytes === "number" ? line.bytes : null;
      // Only a file under the pictures folder is drawn, so a bad answer can never become a broken image.
      if (typeof line?.file === "string" && FILE.test(line.file)) seen.set(digest, { state: "ready", file: line.file, bytes });
      else if (line?.state === "too_big") seen.set(digest, { state: "too_big", file: null, bytes });
      else if (line?.state === "gone") seen.set(digest, { state: "gone", file: null, bytes });
      else seen.set(digest, { state: "failed", file: null, bytes });
    },
    /** @param {string} digest @returns {string | null} */
    fileOf: (digest) => seen.get(digest)?.file ?? null,
    /** null when the picture is ready or not tried yet. @param {string} digest @returns {Exclude<PicState, "ready"> | null} */
    stateOf(digest) {
      const s = seen.get(digest)?.state ?? null;
      return s === "ready" ? null : s;
    },
    /** @param {string} digest @returns {number | null} */
    bytesOf: (digest) => seen.get(digest)?.bytes ?? null,
  };
}
