import { describe, expect, test } from "bun:test";
import {
  babysitCommand,
  isMergeReady,
  isOpenPr,
  mergeCommand,
  parsePrLines,
  prNeedsAttention,
  prStatusArgs,
  toSharedPrEntry,
  updateSharedPrSummary,
} from "./pr-model.js";

const basePr = {
  number: 42,
  title: "Refine cockpit UI",
  url: "https://github.com/acme/bellwether/pull/42",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  unresolvedThreads: 0,
  passing: 5,
  failing: 0,
  pending: 0,
};

describe("isMergeReady and prNeedsAttention", () => {
  test("open non-draft PR with green checks, zero unresolved threads, and APPROVED/empty/null reviewDecision is merge-ready", () => {
    expect(isOpenPr(basePr)).toBe(true);
    expect(isMergeReady(basePr, basePr.headRefOid)).toBe(true);
    expect(isMergeReady({ ...basePr, reviewDecision: null }, basePr.headRefOid)).toBe(true);
    expect(isMergeReady({ ...basePr, reviewDecision: "" }, null)).toBe(true);
    expect(prNeedsAttention(basePr)).toBe(false);
  });

  test("draft, failing/pending checks, unresolved threads, REVIEW_REQUIRED, CHANGES_REQUESTED, or mismatched HEAD block Merge PR", () => {
    expect(isMergeReady({ ...basePr, isDraft: true })).toBe(false);
    expect(isMergeReady({ ...basePr, state: "MERGED" })).toBe(false);
    expect(isMergeReady({ ...basePr, failing: 1 })).toBe(false);
    expect(isMergeReady({ ...basePr, pending: 1 })).toBe(false);
    expect(isMergeReady({ ...basePr, unresolvedThreads: 2 })).toBe(false);
    expect(isMergeReady({ ...basePr, reviewDecision: "REVIEW_REQUIRED" })).toBe(false);
    expect(isMergeReady({ ...basePr, reviewDecision: "CHANGES_REQUESTED" })).toBe(false);
    expect(isMergeReady(basePr, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });

  test("prNeedsAttention flags failing checks, unresolved threads, or CHANGES_REQUESTED on open PRs only", () => {
    expect(prNeedsAttention({ ...basePr, failing: 1 })).toBe(true);
    expect(prNeedsAttention({ ...basePr, unresolvedThreads: 1 })).toBe(true);
    expect(prNeedsAttention({ ...basePr, reviewDecision: "CHANGES_REQUESTED" })).toBe(true);
    expect(prNeedsAttention({ ...basePr, reviewDecision: "REVIEW_REQUIRED" })).toBe(false);
    expect(prNeedsAttention({ ...basePr, state: "CLOSED", failing: 2 })).toBe(false);
    expect(prNeedsAttention(null)).toBe(false);
  });
});

describe("skill commands, CLI args, and shared PR summaries", () => {
  test("babysitCommand and mergeCommand format slash commands and reject invalid PR numbers", () => {
    expect(babysitCommand(42)).toBe("/babysit-pr 42");
    expect(mergeCommand(42)).toBe("/merge-pr 42");
    expect(() => babysitCommand(0)).toThrow();
    expect(() => mergeCommand(-5)).toThrow();
    expect(() => mergeCommand(Number.NaN)).toThrow();
  });

  test("prStatusArgs builds bw pr status argv and rejects empty or flag-like branch names", () => {
    expect(prStatusArgs("acme/bellwether", "feat/ui", basePr.headRefOid, { refresh: true })).toEqual([
      "pr",
      "status",
      "--repo",
      "acme/bellwether",
      "--branch",
      "feat/ui",
      "--head",
      basePr.headRefOid,
      "--refresh",
    ]);
    expect(prStatusArgs("acme/bellwether", "--evil")).toBe(null);
    expect(prStatusArgs(null, "main")).toBe(null);
    expect(prStatusArgs("acme/bellwether", null)).toBe(null);
  });

  test("parsePrLines reads pr and error NDJSON lines", () => {
    expect(parsePrLines([{ type: "pr", pr: basePr, cached: true, age_s: 12, stale: true }])).toEqual({
      ok: true,
      pr: basePr,
      cached: true,
      ageS: 12,
      stale: true,
    });
    expect(parsePrLines([{ type: "pr", pr: null, cached: false, age_s: 0, stale: false }])).toEqual({
      ok: true,
      pr: null,
      cached: false,
      ageS: 0,
      stale: false,
    });
    expect(parsePrLines([{ type: "error", code: "no_gh", message: "gh not installed" }])).toEqual({
      ok: false,
      code: "no_gh",
      message: "gh not installed",
    });
  });

  test("toSharedPrEntry and updateSharedPrSummary prune closed spaces and omit non-open PRs", () => {
    const entry = toSharedPrEntry({ ...basePr, failing: 1 }, basePr.headRefOid);
    expect(entry).toMatchObject({ number: 42, mergeReady: false, attention: true });
    expect(toSharedPrEntry({ ...basePr, state: "MERGED" }, basePr.headRefOid)).toBe(null);

    const first = updateSharedPrSummary({ staleSpace: entry }, "s1", entry, ["s1"]);
    expect(Object.keys(first ?? {})).toEqual(["s1"]);
    // Identical update returns null so setShared never churns.
    expect(updateSharedPrSummary(first, "s1", entry, ["s1"])).toBe(null);
  });
});
