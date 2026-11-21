// Undo bookkeeping. figma.triggerUndo() walks Figma's own history, which knows
// nothing about tool calls: consecutive plugin writes with no commitUndo between
// them merge into one step, and a user's hand edit is a step too. So the plugin
// closes a history step before and after every write command, and keeps a short
// ledger of those calls. undo only reverts calls the ledger holds, and refuses
// when it cannot say which steps a call produced.

export const MAX_LEDGER = 50;

// Commands that never add a history step (reads, selection, viewport, events).
export const READ_ONLY_COMMANDS = new Set([
  "notify", "get_document_info", "get_selection", "get_node_info", "get_nodes_info", "read_my_design",
  "assert_contained", "snapshot_positions", "diff_positions", "export_spec", "read_spec_nodes",
  "get_styles", "get_local_components", "export_node_as_image", "scan_text_nodes", "get_annotations",
  "scan_nodes_by_types", "get_instance_overrides", "get_reactions", "set_focus", "set_selections",
  "get_local_variables", "get_library_variables", "get_vector_network", "scan_node_styles",
  "introspect_node", "design_query", "diff_components", "get_interactions", "get_flows",
  "get_dev_resources", "get_measurements", "subscribe_events", "unsubscribe_events", "undo",
]);

// Commands that may or may not have written: arbitrary code, and a screenshot
// that clones nodes to render them. A call that threw is uncertain too, since
// it may have written part of its work before failing.
export const UNCERTAIN_COMMANDS = new Set(["figma_eval", "screenshot_region"]);

export interface UndoEntry {
  seq: number;
  command: string;
  uncertain: boolean;
  reason: string;
}

let ledger: UndoEntry[] = [];
let seq = 0;

function commitUndo() {
  const f: any = figma;
  if (typeof f.commitUndo === "function") f.commitUndo();
}

export function isTracked(command: string): boolean {
  return !READ_ONLY_COMMANDS.has(command);
}

/** Close any open history step so this call's writes start a step of their own. */
export function beginCommand(command: string) {
  if (isTracked(command)) commitUndo();
}

/** Close this call's step and record it. */
export function endCommand(command: string, failed: boolean) {
  if (!isTracked(command)) return;
  commitUndo();
  const maybeNoop = UNCERTAIN_COMMANDS.has(command);
  ledger.push({
    seq: ++seq,
    command,
    uncertain: failed || maybeNoop,
    reason: failed ? "the call failed and may have written part of its changes" : maybeNoop ? "this command may not have written anything" : "",
  });
  if (ledger.length > MAX_LEDGER) ledger = ledger.slice(ledger.length - MAX_LEDGER);
}

export function undoLedger(): UndoEntry[] {
  return ledger.slice();
}

export function resetUndoLedger() {
  ledger = [];
  seq = 0;
}

/**
 * Revert the last `count` recorded write calls, one history step each.
 * Throws instead of reaching past the ledger or past a call whose step count
 * is unknown (unless allowUncertain).
 */
export function undoLastCalls(count: number, allowUncertain: boolean) {
  const n = Math.floor(count);
  if (!(n >= 1)) throw new Error("count must be a whole number of at least 1");
  if (ledger.length === 0) {
    throw new Error("Nothing to undo: this plugin session has not recorded a write call. Undo is limited to calls made since the plugin started; use Cmd/Ctrl+Z in Figma for anything older.");
  }
  if (n > ledger.length) {
    throw new Error(`Cannot undo ${n} calls: only ${ledger.length} write call(s) are recorded. Undo will not reach into earlier history, because that would revert changes that were not part of those calls.`);
  }
  const range = ledger.slice(ledger.length - n);
  const uncertain = range.filter(e => e.uncertain);
  if (uncertain.length > 0 && !allowUncertain) {
    const list = uncertain.map(e => `${e.command} (${e.reason})`).join("; ");
    throw new Error(`Undo refused: it cannot tell how many history steps these call(s) produced: ${list}. Nothing was undone. Inspect the document, then repeat with allowUncertain: true to revert one step per call, or fix the affected nodes directly.`);
  }
  commitUndo();
  for (let i = 0; i < n; i++) figma.triggerUndo();
  ledger = ledger.slice(0, ledger.length - n);
  return {
    success: true,
    steps: n,
    reverted: range.map(e => e.command).reverse(),
    uncertain: uncertain.length,
    remaining: ledger.length,
  };
}
