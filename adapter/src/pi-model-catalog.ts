import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { z } from "zod";
import { THINKING_LEVELS, providerModelsV1 } from "@chrona/contracts/steward";
import { inspectPiLaunch, piEnvironment, piLaunchConfig, type PiProviderOptions } from "./pi-launch";
import { launchPiProcess } from "./pi-process";

const model = z.object({ provider: z.string().min(1), id: z.string().min(1), name: z.string().optional() });
const catalog = z.object({ models: z.array(model) });
const state = z.object({ model: model.nullish(), thinkingLevel: z.enum(THINKING_LEVELS).optional() });
const thinking = z.object({ levels: z.array(z.enum(THINKING_LEVELS)).min(1) });
const reply = z.object({ type: z.literal("response"), id: z.string(), command: z.string(), success: z.boolean(), data: z.unknown() });

export async function piModelCatalog(options: PiProviderOptions, cursor?: string) {
  const config = piLaunchConfig(options);
  const error = await inspectPiLaunch(config, true);
  if (error) throw new Error(error);
  const child = (options.launch ?? launchPiProcess)({ file: config.command,
    args: ["--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-prompt-templates",
      ...config.resources.extensions.flatMap(extension => ["-e", extension])],
    cwd: existsSync(config.agentDir) ? config.agentDir : homedir(), env: piEnvironment(config), timeoutMs: 8000, helperPath: options.processHelper });
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) child.kill("SIGKILL");
  });
  child.stderr.resume();
  child.stdin.on("error", () => child.kill("SIGKILL"));
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  let sequence = 0;
  async function request(type: string, fields = {}) {
    const id = String(++sequence);
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    for (;;) {
      const line = await lines.next();
      if (line.done) throw new Error(`Pi stopped before replying to ${type}`);
      let value: unknown;
      try { value = JSON.parse(line.value); }
      catch { throw new Error("Pi model catalog received an invalid RPC record"); }
      const response = reply.safeParse(value);
      if (response.success && response.data.id === id) {
        if (response.data.command !== type) throw new Error("Pi model catalog received an unmatched RPC reply");
        return response.data;
      }
    }
  }
  try {
    const available = catalog.parse((await request("get_available_models")).data).models;
    const current = state.parse((await request("get_state")).data);
    const byId = new Map(available.map(value => [`${value.provider}/${value.id}`, value]));
    const currentId = current.model ? `${current.model.provider}/${current.model.id}` : null;
    const configured = options.model;
    const matches = configured ? [...byId.entries()].filter(([id, candidate]) => id === configured || candidate.id === configured) : [];
    const defaultModel = configured ? (matches.length === 1 ? matches[0]![0] : null) : currentId;
    const ids = [...byId.keys()].sort().filter(id => cursor === undefined || id > cursor);
    const models = [];
    for (const id of ids.slice(0, 20)) {
      const selected = byId.get(id)!;
      const set = await request("set_model", { provider: selected.provider, modelId: selected.id });
      const levels = set.success ? thinking.safeParse((await request("get_available_thinking_levels")).data) : null;
      let effort = null;
      if (levels?.success) {
        const { thinkingLevel } = state.parse((await request("get_state")).data);
        const preferred = options.thinking ?? thinkingLevel;
        effort = { options: levels.data.levels, default: preferred && levels.data.levels.includes(preferred) ? preferred : null };
      }
      models.push({ id, label: selected.name || id, effort });
    }
    return providerModelsV1.parse({ defaultModel, models, nextCursor: ids.length > models.length ? models.at(-1)!.id : null });
  } finally {
    reader.close();
    child.stdin.end();
    await child.closed;
  }
}
