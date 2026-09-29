import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getConfig } from "../config";
import { SystemOneResponseSchema } from "../types";
import {
  EVALUATE_INPUT_SHAPE,
  EVALUATE_TOOL_DESCRIPTION,
  EVALUATE_TOOL_NAME,
  type EvaluateInput,
  runEvaluate,
  type ToolResult,
} from "./evaluateTool";

export const SERVER_NAME = "xev";
export const SERVER_VERSION = "1.0.0";

/**
 * `McpServer.registerTool` infers its argument and result types from the
 * schemas, dispatching over the SDK's union of two zod versions, and that
 * inference exceeds TypeScript's instantiation depth. This is the same call with
 * the signature spelled out: what goes in, what comes out. Nothing about the
 * runtime path changes, so the SDK still derives the published JSON Schema from
 * the Zod schemas and still validates `structuredContent` against the output one.
 */
type RegisterTool = (
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    outputSchema: z.ZodTypeAny;
    annotations?: ToolAnnotations;
  },
  handler: (args: EvaluateInput) => Promise<ToolResult>
) => unknown;

/**
 * Builds the server with its tools registered but not yet connected, so tests can
 * drive it over an in-memory transport pair.
 */
export function createServer(): McpServer {
  const config = getConfig();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "xev turns an LLM into a structured evaluator. Call xev_evaluate with the text or data to " +
        "evaluate plus a map of questions (choice / score / noul); all questions are answered in one " +
        `LLM call. Connection: ${config.model} via ${config.baseURL}.`,
      capabilities: { tools: {} },
    }
  );

  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;

  registerTool(
    EVALUATE_TOOL_NAME,
    {
      title: "Evaluate state with questions",
      description: EVALUATE_TOOL_DESCRIPTION,
      inputSchema: EVALUATE_INPUT_SHAPE,
      // The API contract itself, so `structuredContent` is typed for clients that
      // consume it as data and cannot drift from what the HTTP endpoint returns.
      outputSchema: SystemOneResponseSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runEvaluate(args)
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the JSON-RPC stream, so a stray write to it corrupts the
  // protocol. Every diagnostic has to go to stderr, which MCP clients surface.
  console.error("xev mcp: ready on stdio");
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("xev mcp: fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
