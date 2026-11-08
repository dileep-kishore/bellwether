import { describe, expect, test } from "bun:test";
import { moveLink, normalizeOrigin, readLink, suggest, writeLink } from "./linear-links.js";

const link = (name, id = name) => ({ projectId: id, name, at: 1 });

describe("normalizeOrigin", () => {
  test("SSH, scp-like and HTTPS spellings of one repository agree", () => {
    for (const u of [
      "git@github.com:Dileep-Kishore/Bellwether.git",
      "ssh://git@github.com/dileep-kishore/bellwether.git",
      "ssh://git@github.com:22/dileep-kishore/bellwether",
      "https://github.com/dileep-kishore/bellwether",
      "https://user:pw@GitHub.com/dileep-kishore/bellwether.git/",
    ])
      expect(normalizeOrigin(u)).toBe("github.com/dileep-kishore/bellwether");
  });
  test("a local path or nothing is no origin", () => {
    for (const u of ["/srv/repos/a.git", "file:///srv/a.git", "", null, undefined, "./a"])
      expect(normalizeOrigin(u)).toBe(null);
  });
});

describe("links", () => {
  const bare = { machine: null, commonDir: "/private/tmp/a/.git", origin: null };
  const withOrigin = { ...bare, origin: "git@github.com:me/a.git" };

  test("place key without origin", () => {
    const s = writeLink(undefined, bare, link("Bellwether"));
    expect(readLink(s, bare)?.name).toBe("Bellwether");
    expect(Object.keys(s.links)).toEqual(['place:[null,"/private/tmp/a/.git"]']);
    // The same folder on another machine is another repository.
    expect(readLink(s, { ...bare, machine: "macbook" })).toBe(null);
  });

  test("origin key is shared across machines", () => {
    const s = writeLink(undefined, withOrigin, link("Scratch"));
    expect(Object.keys(s.links)).toEqual(["origin:github.com/me/a"]);
    expect(
      readLink(s, { machine: "macbook", commonDir: "/elsewhere/.git", origin: "https://github.com/me/a" })?.name,
    ).toBe("Scratch");
  });

  test("moves to the origin key", () => {
    const s = writeLink(undefined, bare, link("Bellwether"));
    expect(moveLink(s, bare)).toBe(null);
    const moved = moveLink(s, withOrigin);
    expect(Object.keys(moved.links)).toEqual(["origin:github.com/me/a"]);
    expect(readLink(moved, withOrigin)?.name).toBe("Bellwether");
    // Read before the move is written, the place key still answers.
    expect(readLink(s, withOrigin)?.name).toBe("Bellwether");
  });

  test("an origin link already there wins over the place link", () => {
    let s = writeLink(undefined, withOrigin, link("Origin"));
    s = { version: 1, links: { ...s.links, ...writeLink(undefined, bare, link("Place")).links } };
    const moved = moveLink(s, withOrigin);
    expect(readLink(moved, withOrigin)?.name).toBe("Origin");
    expect(Object.keys(moved.links)).toEqual(["origin:github.com/me/a"]);
  });

  test("unlink removes both keys; junk reads as no links", () => {
    let s = writeLink(undefined, bare, link("Bellwether"));
    s = writeLink(s, withOrigin, null);
    expect(s.links).toEqual({});
    expect(readLink({ version: 2, links: {} }, bare)).toBe(null);
    expect(readLink({ version: 1, links: { x: { name: 3 } } }, bare)).toBe(null);
  });
});

describe("suggest", () => {
  const ps = [{ name: "CommScores" }, { name: "Bellwether scratch" }, { name: "Bellwether" }];
  test("equal names first, ignoring case and separators", () => {
    expect(suggest(ps, "bellwether")?.name).toBe("Bellwether");
    expect(suggest(ps, "bellwether-scratch")?.name).toBe("Bellwether scratch");
    expect(suggest(ps, "comm_scores")?.name).toBe("CommScores");
  });
  test("a prefix match, else none", () => {
    expect(suggest([{ name: "Bellwether app" }], "bellwether")?.name).toBe("Bellwether app");
    expect(suggest(ps, "zendots")).toBe(null);
    expect(suggest(ps, "")).toBe(null);
  });
});
