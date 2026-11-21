/**
 * undo reverts exactly the last write calls, or refuses. The figma global is
 * a small model of Figma's history: writes join the open step, commitUndo
 * closes it, triggerUndo reverts the newest closed step. A model of the
 * documented behaviour, not a replacement for a live check.
 *   bun test tests/undo-ledger.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  beginCommand, endCommand, isTracked, MAX_LEDGER, resetUndoLedger, undoLastCalls, undoLedger,
} from "../src/llm2figma_plugin/src/undo-ledger";

const originalFigma = (globalThis as any).figma;
afterAll(() => { (globalThis as any).figma = originalFigma; });

let closed: string[][];
let open: string[];
let doc: string[];

// Run a command the way the plugin's message handler does.
function run(command: string, writes: string[], opts: { fail?: boolean } = {}) {
  beginCommand(command);
  for (const w of writes) { open.push(w); doc.push(w); }
  endCommand(command, !!opts.fail);
}

beforeEach(() => {
  closed = []; open = []; doc = [];
  resetUndoLedger();
  (globalThis as any).figma = {
    commitUndo() { if (open.length) { closed.push(open); open = []; } },
    triggerUndo() {
      const step = closed.pop();
      if (!step) return;
      for (const w of step) doc.splice(doc.lastIndexOf(w), 1);
    },
  };
});

describe("undo ledger", () => {
  test("each write call is its own history step, so undo reverts exactly the last call", () => {
    run("batch_clone", ["a1", "a2", "a3"]);
    run("set_fills", ["b1", "b2"]);
    run("move_node", ["c1"]);
    undoLastCalls(1, false);
    expect(doc).toEqual(["a1", "a2", "a3", "b1", "b2"]);
  });

  test("undoing several calls reverts those calls and leaves the earlier batch whole", () => {
    run("batch_clone", ["a1", "a2", "a3", "a4"]);
    run("set_fills", ["b1"]);
    run("move_node", ["c1"]);
    const result = undoLastCalls(2, false);
    expect(doc).toEqual(["a1", "a2", "a3", "a4"]);
    expect(result).toMatchObject({ success: true, steps: 2, reverted: ["move_node", "set_fills"], remaining: 1 });
  });

  test("without the brackets, consecutive calls merge into one step (the behaviour this replaces)", () => {
    // What the old code did: no commitUndo between calls, then triggerUndo n times.
    open.push("a1", "a2"); doc.push("a1", "a2");
    open.push("b1"); doc.push("b1");
    (globalThis as any).figma.commitUndo();
    (globalThis as any).figma.triggerUndo();
    expect(doc).toEqual([]); // one undo took out two calls' work
  });

  test("reads and selection changes are not recorded and do not consume an undo", () => {
    run("batch_clone", ["a1"]);
    run("get_node_info", []);
    run("set_selections", []);
    run("snapshot_positions", []);
    expect(undoLedger().map(e => e.command)).toEqual(["batch_clone"]);
    undoLastCalls(1, false);
    expect(doc).toEqual([]);
    expect(isTracked("undo")).toBe(false);
  });

  test("a count above the recorded calls is refused and nothing is undone", () => {
    run("set_fills", ["b1"]);
    expect(() => undoLastCalls(2, false)).toThrow("only 1 write call(s) are recorded");
    expect(doc).toEqual(["b1"]);
    expect(undoLedger()).toHaveLength(1);
  });

  test("an empty ledger is refused", () => {
    expect(() => undoLastCalls(1, false)).toThrow("Nothing to undo");
  });

  test("a call that failed part-way makes the range uncertain: refused unless allowUncertain", () => {
    run("set_fills", ["b1"]);
    run("batch_clone", ["c1"], { fail: true });
    const error = (() => { try { undoLastCalls(1, false); } catch (e: any) { return e; } })();
    expect(error.message).toContain("Undo refused");
    expect(error.message).toContain("batch_clone");
    expect(doc).toEqual(["b1", "c1"]);
    const forced = undoLastCalls(1, true);
    expect(forced.uncertain).toBe(1);
    expect(doc).toEqual(["b1"]);
  });

  test("figma_eval and screenshot_region are uncertain even when they succeed", () => {
    run("figma_eval", ["e1"]);
    expect(undoLedger()[0]).toMatchObject({ command: "figma_eval", uncertain: true });
    expect(() => undoLastCalls(1, false)).toThrow("figma_eval");
    run("screenshot_region", []);
    expect(() => undoLastCalls(1, false)).toThrow("screenshot_region");
  });

  test("an uncertain call outside the requested range does not block the undo", () => {
    run("figma_eval", ["e1"]);
    run("set_fills", ["b1"]);
    undoLastCalls(1, false);
    expect(doc).toEqual(["e1"]);
    expect(undoLedger().map(e => e.command)).toEqual(["figma_eval"]);
  });

  test("a hand edit between calls is its own step: undo never reaches it", () => {
    run("set_fills", ["b1"]);
    open.push("hand"); doc.push("hand"); // the user edits in Figma
    run("move_node", ["c1"]);
    undoLastCalls(1, false);
    expect(doc).toEqual(["b1", "hand"]);
  });

  test("the ledger keeps the most recent MAX_LEDGER calls", () => {
    for (let i = 0; i < MAX_LEDGER + 5; i++) run("set_fills", [`w${i}`]);
    expect(undoLedger()).toHaveLength(MAX_LEDGER);
    expect(() => undoLastCalls(MAX_LEDGER + 1, false)).toThrow("only 50 write call(s) are recorded");
  });

  test("a count that is not a whole number of at least 1 is refused", () => {
    run("set_fills", ["b1"]);
    expect(() => undoLastCalls(0, false)).toThrow("at least 1");
    expect(() => undoLastCalls(NaN, false)).toThrow("at least 1");
  });
});
