import { randomUUID } from "node:crypto";
import { connectLoopbackChannel } from "chrona/transport";
import type { RuntimeStart, runtimeToolCallSchema } from "@chrona/contracts/steward";
import type { z } from "zod";

type Request = z.infer<typeof runtimeToolCallSchema>;
type Definitions = Omit<NonNullable<RuntimeStart["tools"]>[number], "reference">[];
type ToolResult = { content: { type: "text"; text: string }[]; details: undefined };
type BridgeApi = { registerTool(tool: Definitions[number] & {
  label: string;
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}): void };

export default async function (pi: BridgeApi) {
  const endpoint = process.env.CHRONA_TOOL_CHANNEL, token = process.env.CHRONA_TOOL_CHANNEL_TOKEN;
  if (!endpoint || !token) return;
  const definitions = Promise.withResolvers<Definitions>();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const connection = connectLoopbackChannel({ endpoint, token,
    onDisconnect(error) {
      definitions.reject(error);
      for (const request of pending.values()) request.reject(error);
    },
    onMessage(raw) {
      const message = raw as { tools?: Definitions; id?: string; output?: unknown; error?: string };
      if (message.tools) { definitions.resolve(message.tools); return; }
      const request = message.id && pending.get(message.id);
      if (!request) return;
      if (message.error) request.reject(new Error(message.error.replaceAll(token, "[redacted]")));
      else request.resolve(message.output);
    },
  });
  try { await connection.ready; }
  catch (error) { definitions.reject(error); }
  for (const tool of await definitions.promise) {
    const properties = tool.parameters.properties as Record<string, unknown> | undefined;
    const hasTimeout = Object.hasOwn(properties ?? {}, "timeoutSeconds");
    pi.registerTool({ ...tool, label: tool.name,
      parameters: hasTimeout ? tool.parameters : { ...tool.parameters, properties: { ...properties,
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, description: "Maximum wait in seconds (default 60)" } } },
      async execute(key, params, signal) {
        const args = { ...(params ?? {}) as Request["args"] };
        const requested = args.timeoutSeconds;
        const timeoutSeconds = !hasTimeout && typeof requested === "number" && Number.isInteger(requested) && requested > 0
          ? Math.min(requested, 600) : undefined;
        if (!hasTimeout) delete args.timeoutSeconds;
        const id = randomUUID(), request = Promise.withResolvers<unknown>();
        const stop = AbortSignal.any([AbortSignal.timeout((timeoutSeconds ?? 60) * 1000 + 5000), ...(signal ? [signal] : [])]);
        const abort = () => request.reject(new Error("Tool wait ended. Check the original receipt before retrying an operation with effects."));
        stop.throwIfAborted();
        stop.addEventListener("abort", abort, { once: true });
        pending.set(id, request);
        try {
          connection.send({ id, request: { name: tool.name, args, key, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) } });
          const text = JSON.stringify((await request.promise) ?? null).replaceAll(token, "[redacted]");
          return { content: [{ type: "text", text: text.length > 30_000 ? `${text.slice(0, 30_000)}\n[Chrona tool result truncated from ${text.length} characters. Narrow the request or read the remaining content by reference.]` : text }], details: undefined };
        } finally {
          pending.delete(id);
          stop.removeEventListener("abort", abort);
        }
      },
    });
  }
}
