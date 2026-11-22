/**
 * Bounds on what one plugin call may hold or return: design_query matches,
 * figma_eval results, and the memory kept by position snapshots. The figma
 * global is mocked; contract mocks exercise the plugin logic and do not
 * replace a live check.
 *   bun test tests/plugin-scan-limits.test.ts
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DESIGN_QUERY_MAX_MATCHES, DESIGN_QUERY_MAX_PROPERTY_MATCHES, designQuery, EVAL_RESULT_MAX_CHARS,
  EVAL_RESULT_MAX_VALUES, figmaEval, safeSerialize,
} from "../src/llm2figma_plugin/src/analysis";
import { PositionSnapshotStore } from "../src/llm2figma_plugin/src/verify";

const originalFigma = (globalThis as any).figma;
afterAll(() => { (globalThis as any).figma = originalFigma; });

function page(count: number) {
  const children = Array.from({ length: count }, (_, i) => ({ id: `1:${i}`, name: `Item ${i}`, type: "RECTANGLE" }));
  return { id: "0:1", name: "Page", type: "PAGE", children };
}

beforeEach(() => {
  const root = page(0);
  (globalThis as any).figma = {
    currentPage: root,
    getNodeByIdAsync: async () => null,
    ui: { postMessage: () => {} },
  };
});
function useTree(count: number) {
  (globalThis as any).figma.currentPage = page(count);
}

describe("design_query bounds", () => {
  test("a query within the cap returns every match", async () => {
    useTree(30);
    const result: any = await designQuery({ select: { type: "RECTANGLE" } });
    expect(result.matched).toBe(30);
    expect(result.results).toHaveLength(30);
    expect(result.limitReached).toBeUndefined();
  });

  test("more matches than the cap, with no limit, is an error that says what to do", async () => {
    useTree(DESIGN_QUERY_MAX_MATCHES + 5);
    const error = await designQuery({ select: { type: "RECTANGLE" } }).catch((e: any) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`more than ${DESIGN_QUERY_MAX_MATCHES} nodes`);
    expect(error.message).toContain("limit");
  });

  test("exactly the cap is allowed", async () => {
    useTree(DESIGN_QUERY_MAX_MATCHES);
    const result: any = await designQuery({ select: { type: "RECTANGLE" } });
    expect(result.matched).toBe(DESIGN_QUERY_MAX_MATCHES);
  });

  test("a limit within the cap returns that many and says the limit was reached", async () => {
    useTree(DESIGN_QUERY_MAX_MATCHES + 50);
    const result: any = await designQuery({ select: { type: "RECTANGLE" }, limit: 10 });
    expect(result.matched).toBe(10);
    expect(result.limitReached).toBe(true);
  });

  test("a limit above the cap is refused", async () => {
    useTree(5);
    const error = await designQuery({ select: { type: "RECTANGLE" }, limit: DESIGN_QUERY_MAX_MATCHES + 1 }).catch((e: any) => e);
    expect(error.message).toContain("above the most one call returns");
  });

  test("includeProperties has a lower cap, checked before any introspection or update", async () => {
    useTree(DESIGN_QUERY_MAX_PROPERTY_MATCHES + 1);
    const error = await designQuery({ select: { type: "RECTANGLE" }, includeProperties: true }).catch((e: any) => e);
    expect(error.message).toContain(`more than ${DESIGN_QUERY_MAX_PROPERTY_MATCHES} nodes with includeProperties`);
    const limitError = await designQuery({ select: { type: "RECTANGLE" }, includeProperties: true, limit: DESIGN_QUERY_MAX_PROPERTY_MATCHES + 1 }).catch((e: any) => e);
    expect(limitError.message).toContain("with includeProperties");
  });

  test("a scan that runs out of time says so, and applies no update", async () => {
    useTree(10);
    let calls = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? 0 : 10_000_000));
    try {
      const read: any = await designQuery({ select: { type: "RECTANGLE" } });
      expect(read.timedOut).toBe(true);
      expect(read.note).toContain("time limit");
      calls = 0;
      const error = await designQuery({ select: { type: "RECTANGLE" }, update: { "x.fill": "#000000" } }).catch((e: any) => e);
      expect(error.message).toContain("no update was applied");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("figma_eval result bounds", () => {
  test("a result within the budget comes back as before", async () => {
    const result: any = await figmaEval({ code: "return { a: [1, 2, 3], b: 'text' };" });
    expect(result).toEqual({ success: true, result: { a: [1, 2, 3], b: "text" } });
  });

  test("a result with too many values fails with an error that says what to return instead", async () => {
    const result: any = await figmaEval({ code: `return Array.from({ length: ${EVAL_RESULT_MAX_VALUES + 10} }, (_, i) => i);` });
    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
    expect(result.error).toContain("counts, ids or a summary");
  });

  test("a result with too much text fails the same way", async () => {
    const result: any = await figmaEval({ code: `return 'x'.repeat(${EVAL_RESULT_MAX_CHARS + 1});` });
    expect(result.success).toBe(false);
    expect(result.error).toContain("characters of text");
  });

  test("safeSerialize without a budget keeps its old behaviour", () => {
    expect(safeSerialize(Array.from({ length: EVAL_RESULT_MAX_VALUES + 10 }, (_, i) => i))).toHaveLength(EVAL_RESULT_MAX_VALUES + 10);
  });
});

describe("snapshot store memory", () => {
  const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `1:${i}`, name: "n", parentId: null, box: null }));

  test("past the total node budget the oldest snapshots are dropped and the newest is kept", () => {
    const store = new PositionSnapshotStore(() => 1000);
    const per = PositionSnapshotStore.MAX_TOTAL_NODES / 2;
    const a = store.add("1:1", entries(per), false, {});
    const b = store.add("1:1", entries(per), false, {});
    expect(store.get(a.snapshotId).entries).toHaveLength(per);
    const c = store.add("1:1", entries(per), false, {});
    expect(() => store.get(a.snapshotId)).toThrow("dropped to keep plugin memory bounded");
    expect(store.get(b.snapshotId).entries).toHaveLength(per);
    expect(store.get(c.snapshotId).entries).toHaveLength(per);
  });

  test("a single snapshot over the budget is still kept, alone", () => {
    const store = new PositionSnapshotStore(() => 1000);
    const small = store.add("1:1", entries(5), false, {});
    const big = store.add("1:1", entries(PositionSnapshotStore.MAX_TOTAL_NODES + 1), false, {});
    expect(() => store.get(small.snapshotId)).toThrow("Snapshot expired");
    expect(store.get(big.snapshotId).entries).toHaveLength(PositionSnapshotStore.MAX_TOTAL_NODES + 1);
  });
});
