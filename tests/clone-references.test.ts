/**
 * clone_node and batch_clone copy componentPropertyReferences onto the clone's
 * descendants by child path. The figma global is mocked with nodes that behave
 * like a variant cloned into a component set: the clone comes back with every
 * binding empty. Contract mocks; they do not replace a live check.
 *   bun test tests/clone-references.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { batchClone, cloneNode, copyComponentPropertyReferences } from "../src/llm2figma_plugin/src/transforms";

const originalFigma = (globalThis as any).figma;
afterAll(() => { (globalThis as any).figma = originalFigma; });

let nodes: Map<string, any>;
let nextId: number;

function make(type: string, name: string, refs?: Record<string, string>, children: any[] = []): any {
  const n: any = { id: `${++nextId}:1`, type, name, children, parent: null, x: 0, y: 0, width: 10, height: 10 };
  if (refs) n.componentPropertyReferences = { ...refs };
  for (const c of children) c.parent = n;
  nodes.set(n.id, n);
  return n;
}

// A clone has the same shape and no bindings, as a variant cloned in a set does.
function cloneOf(source: any): any {
  const copy = make(source.type, source.name, source.componentPropertyReferences ? {} : undefined, source.children.map(cloneOf));
  return copy;
}

beforeEach(() => {
  nodes = new Map();
  nextId = 0;
  (globalThis as any).figma = {
    currentPage: make("PAGE", "Page"),
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    ui: { postMessage: () => {} },
  };
});

// variant > [label (characters), group > [icon (swap, visible)], inst > [innerText]]
function variant(): any {
  const label = make("TEXT", "label", { characters: "Title#1:0" });
  const icon = make("INSTANCE", "icon", { mainComponent: "Icon#2:0", visible: "ShowIcon#3:0" });
  const group = make("FRAME", "group", undefined, [icon]);
  const innerText = make("TEXT", "inner", { characters: "Inner#9:0" });
  const inst = make("INSTANCE", "inst", undefined, [innerText]);
  const v = make("COMPONENT", "variant", undefined, [label, group, inst]);
  v.clone = function () { return cloneOf(this); };
  return v;
}

function withSet(v: any) {
  const set = make("COMPONENT_SET", "set", undefined, [v]);
  v.parent = set;
  set.appendChild = function (c: any) { c.parent = this; this.children.push(c); };
  return set;
}

describe("copyComponentPropertyReferences", () => {
  test("copies bindings onto the clone's descendants by child path", () => {
    const source = variant();
    const clone = cloneOf(source);
    const result = copyComponentPropertyReferences(source, clone);
    expect(clone.children[0].componentPropertyReferences).toEqual({ characters: "Title#1:0" });
    expect(clone.children[1].children[0].componentPropertyReferences).toEqual({ mainComponent: "Icon#2:0", visible: "ShowIcon#3:0" });
    expect(result).toEqual({ copied: 2, failed: [] });
  });

  test("does not enter instances: their inner nodes keep what they have", () => {
    const source = variant();
    const clone = cloneOf(source);
    copyComponentPropertyReferences(source, clone);
    expect(clone.children[2].children[0].componentPropertyReferences).toEqual({});
  });

  test("a binding that is already there is not written again", () => {
    const source = variant();
    const clone = cloneOf(source);
    copyComponentPropertyReferences(source, clone);
    expect(copyComponentPropertyReferences(source, clone)).toEqual({ copied: 0, failed: [] });
  });

  test("a rejected assignment is reported with its path and does not stop the rest", () => {
    const source = variant();
    const clone = cloneOf(source);
    Object.defineProperty(clone.children[0], "componentPropertyReferences", {
      get: () => ({}),
      set: () => { throw new Error("no such property"); },
    });
    const result = copyComponentPropertyReferences(source, clone);
    expect(result.copied).toBe(1);
    expect(result.failed).toEqual([{ path: [0], error: "no such property" }]);
    expect(clone.children[1].children[0].componentPropertyReferences.visible).toBe("ShowIcon#3:0");
  });

  test("a clone with a different shape is matched as far as the paths agree", () => {
    const source = variant();
    const clone = cloneOf(source);
    clone.children.pop();
    expect(copyComponentPropertyReferences(source, clone).copied).toBe(2);
  });
});

describe("clone_node and batch_clone", () => {
  test("clone_node restores the bindings once the clone is in its set", async () => {
    const v = variant();
    const set = withSet(v);
    const result: any = await cloneNode({ nodeId: v.id, parentId: set.id });
    const clone = nodes.get(result.id);
    expect(clone.parent).toBe(set);
    expect(clone.children[0].componentPropertyReferences).toEqual({ characters: "Title#1:0" });
    expect(clone.children[1].children[0].componentPropertyReferences.visible).toBe("ShowIcon#3:0");
    expect(result.componentPropertyReferencesCopied).toBe(2);
    expect(result.componentPropertyReferencesFailed).toEqual([]);
  });

  test("clone_node of a node with no bindings adds no extra fields", async () => {
    const plain = make("FRAME", "plain", undefined, [make("RECTANGLE", "r")]);
    plain.clone = function () { return cloneOf(this); };
    plain.parent = (globalThis as any).figma.currentPage;
    (globalThis as any).figma.currentPage.appendChild = function (c: any) { c.parent = this; };
    const result: any = await cloneNode({ nodeId: plain.id });
    expect(result.componentPropertyReferencesCopied).toBeUndefined();
  });

  test("batch_clone restores the bindings on every clone", async () => {
    const v = variant();
    const set = withSet(v);
    const result: any = await batchClone({ sourceId: v.id, positions: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }] });
    expect(result.successCount).toBe(3);
    expect(set.children).toHaveLength(4);
    for (const c of set.children.slice(1)) {
      expect(c.children[0].componentPropertyReferences).toEqual({ characters: "Title#1:0" });
      expect(c.children[1].children[0].componentPropertyReferences.mainComponent).toBe("Icon#2:0");
    }
    expect(result.clones.every((c: any) => c.componentPropertyReferencesCopied === 2)).toBe(true);
  });
});
