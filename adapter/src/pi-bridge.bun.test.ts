import { expect, test } from "bun:test";
import { createLoopbackChannel } from "chrona/transport";
import bridge from "../resources/chrona-tools";

test("Pi registers the injected tools and forwards keyed requests over the Run channel", async () => {
  const requests: unknown[] = [];
  const parameters = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  const definition = { name: "m_demo_echo", description: "Echo text", parameters };
  const channel = await createLoopbackChannel({ onMessage(raw) {
    const { id, request } = raw as { id: string; request: { args: { text: string } } };
    requests.push(request);
    if (request.args.text === "fail") channel.send({ id, error: "forbidden: tool is outside the Run binding" });
    else channel.send({ id, output: { text: request.args.text } });
  } });
  const env = [process.env.CHRONA_TOOL_CHANNEL, process.env.CHRONA_TOOL_CHANNEL_TOKEN];
  process.env.CHRONA_TOOL_CHANNEL = channel.endpoint;
  process.env.CHRONA_TOOL_CHANNEL_TOKEN = channel.token;
  try {
    const tools: Parameters<Parameters<typeof bridge>[0]["registerTool"]>[0][] = [];
    await Promise.all([bridge({ registerTool: tool => tools.push(tool) }), channel.ready.then(() => channel.send({ tools: [definition] }))]);
    expect(tools.map(tool => tool.name)).toEqual([definition.name]);
    const [tool] = tools;
    expect(tool.parameters).toMatchObject({ ...parameters, properties: { ...parameters.properties, timeoutSeconds: { type: "integer" } } });
    expect(await tool.execute("same-key", { text: "hello", timeoutSeconds: 12 })).toEqual({ content: [{ type: "text", text: '{"text":"hello"}' }], details: undefined });
    expect(requests).toEqual([{ name: definition.name, args: { text: "hello" }, key: "same-key", timeoutSeconds: 12 }]);
    await expect(tool.execute("forbidden-key", { text: "fail" })).rejects.toThrow("outside the Run binding");
    await expect(tool.execute("cancelled-key", { text: "hello" }, AbortSignal.abort())).rejects.toThrow();
    expect(requests).toHaveLength(2);
  } finally {
    for (const [i, key] of ["CHRONA_TOOL_CHANNEL", "CHRONA_TOOL_CHANNEL_TOKEN"].entries()) {
      if (env[i] === undefined) delete process.env[key];
      else process.env[key] = env[i];
    }
    await channel.close();
  }
});
