import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SendCommandFn } from "../types.js";
import { joinChannel, autoJoinChannel, setChannelFileKey } from "../connection.js";
import { isEnabled } from "../../shared/flags.js";
import { parseFileKey } from "../file-key.js";

export function registerTools(
  server: McpServer,
  sendCommandToFigma: SendCommandFn,
  env: Record<string, string | undefined> = process.env,
  channels: { joinChannel: (name: string) => Promise<void>; autoJoinChannel: () => Promise<string> } = { joinChannel, autoJoinChannel },
) {
  // Read from the server environment only; no tool parameter can turn it on.
  const fileKeyEnabled = isEnabled("FILE_KEY", env);

  server.tool("set_focus", "Set focus on a specific node in Figma by selecting it and scrolling viewport to it", {
    nodeId: z.string().describe("The ID of the node to focus on"),
  }, async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return { content: [{ type: "text", text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });

  server.tool("set_selections", "Set selection to multiple nodes in Figma and scroll viewport to show them", {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  }, async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return { content: [{ type: "text", text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });

  server.tool("undo", "Undo the last tool call(s) that wrote to the file. Figma's history knows nothing about tool calls, so the plugin closes a history step around every write call and keeps a ledger of them (this plugin session only). count = number of recent write calls to revert, one history step each. It refuses, changing nothing, when count exceeds the recorded calls, or when a call in range may not have produced exactly one step: a call that failed part-way, figma_eval, screenshot_region. It cannot see hand edits made in Figma between calls, or a call that wrote nothing, and it cannot be proven exact without checking: run snapshot_positions before and diff_positions after. allowUncertain: true overrides the refusal for failed or uncertain calls. Returns the commands reverted.", {
    count: z.number().int().min(1).max(50).optional().describe("Number of recent write calls to revert (default 1, max 50)"),
    allowUncertain: z.boolean().optional().describe("Revert one step per call even when a call in range failed part-way or may not have written (default false: refuse)"),
  }, async ({ count, allowUncertain }: any) => {
    try {
      const steps = count || 1;
      const result: any = await sendCommandToFigma("undo", { count: steps, allowUncertain: !!allowUncertain });
      const reverted = Array.isArray(result?.reverted) ? result.reverted.join(", ") : "";
      return { content: [{ type: "text", text: `Undid ${steps} write call(s)${reverted ? `: ${reverted}` : ""}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error triggering undo: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });

  server.tool("join_channel", "Connect to a Figma file through its plugin channel. Leave channel empty to join the only connected file automatically. Other tools also auto-join, so this is only needed when several files are connected.", {
    channel: z.string().describe("Channel name shown in the Figma plugin. Empty = auto-join the only connected file").default(""),
    ...(fileKeyEnabled ? {
      fileKey: z.string().optional().describe("The file's key or its figma.com URL. Used as the file key when the plugin cannot report one (a development plugin does not). With channel empty it applies to the channel already joined, if there is one."),
    } : {}),
  }, async ({ channel, fileKey }: any) => {
    try {
      const userKey = fileKeyEnabled && fileKey ? parseFileKey(fileKey) : undefined;
      const joined = channel ? (await channels.joinChannel(channel), channel) : await channels.autoJoinChannel();
      if (userKey) setChannelFileKey(joined, userKey);
      return { content: [{ type: "text", text: `Successfully joined channel: ${joined}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
}
