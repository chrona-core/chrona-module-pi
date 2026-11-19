import { strict as assert } from "node:assert";
import { mock } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderRunInput } from "@chrona/contracts/steward";
import { piTranscript, piTranscriptPage, PI_TRANSCRIPT_MAX_BYTES } from "./adapter/src/pi-transcript";

type Trigger = { id: string; args: Record<string, unknown>; caller?: { kind: string }; call?: { id: string } };
let tool!: (value: Trigger) => Promise<{ result: unknown }>, activated!: () => Promise<unknown>, disconnect!: () => void;
const calls: { target: unknown; args: Record<string, unknown> }[] = [], configurations: Record<string, unknown>[] = [], runs: ProviderRunInput[] = [];
let finish!: (value: { outcome: "finished"; sessionId: null; error: null }) => void, starts = 0;
const data = process.env.CHRONA_DATA!, scenario = process.argv[2]!;
class ModelError extends Error { constructor(readonly code: string, message: string) { super(message); } }
mock.module("chrona", () => ({ ModelError, chrona: { paths: { data }, dependencies: { web: "web-module-id" }, async call(target: unknown, args: Record<string, unknown>) { calls.push({ target, args }); return {}; } },
  on(name: string, callback: typeof tool & typeof activated) { if (name === "tool") tool = callback; if (name === "activated") activated = callback; }, onDisconnect(callback: () => void) { disconnect = callback; },
}));
mock.module("@chrona/pi", () => ({ piTranscriptPage, readPiTranscript: piTranscript, PI_TRANSCRIPT_MAX_BYTES, PI_MODEL_ENVIRONMENT_KEYS: ["OPENAI_API_KEY"],
  async listPiModels() { return ["fixture/available"]; },
  async piModelCatalog() { return { defaultModel: null, models: [], nextCursor: null }; },
  piLaunchConfig: (options: Record<string, unknown>) => options,
  piCompletionVersionError() { return null; },
  createPiProvider(options: Record<string, unknown>) { configurations.push(options); return {
  name: "pi", supportsRunModel: true, async health() { return { available: true, sandboxed: false, error: null }; },
  start(input: ProviderRunInput) { starts++; runs.push(input); return { done: new Promise(resolve => { finish = resolve; }), async inject() {}, async abort() {}, async native(request: Record<string, unknown>) { return { type: "response", request, instance: starts }; } }; },
}; } }));
if (scenario === "invalid") {
  await writeFile(join(data, "pi-host.json"), '{"privateHostValue":');
  await assert.rejects(import("./runtime.js"), { message: `Pi configuration could not be read: ${join(data, "pi-host.json")}` });
  assert.equal(configurations.length, 0);
} else {
  const profile = join(data, "profile"); await mkdir(profile, { mode: 0o700 });
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "fixture", defaultThinkingLevel: "high" }));
  await writeFile(join(data, "pi-host.json"), JSON.stringify({ command: "/fake/pi", agentDir: profile, chronaExtension: "/host/bridge", agentUrl: "http://host/runtime", environment: { OPENAI_API_KEY: "fixture-only-credential", CHRONA_UNSAFE_CARRIER: "must-not-install" } }));
  await (scenario === "artifact" ? import("./runtime.js") : import("./runtime"));
  assert.equal(process.env.OPENAI_API_KEY, "fixture-only-credential"); assert.equal(process.env.CHRONA_UNSAFE_CARRIER, undefined);
  await activated(); assert.equal(calls[0]!.target, "agent.register");
  assert.deepEqual(calls[1]!.target, { moduleId: "web-module-id", tool: "page-set" });
  for (const id of ["health", "start", "status", "inject", "abort", "release", "native", "transcript", "complete"]) await assert.rejects(tool({ id, args: {}, caller: { kind: "module" }, call: { id: "consumer-call" } }), { code: "forbidden" });
  assert.equal(configurations.length, 0);
  const models = await tool({ id: "models", args: {}, caller: { kind: "owner" }, call: { id: "owner-call" } });
  assert.deepEqual((models.result as { items: unknown[] }).items, [{ id: "fixture/available", label: "fixture/available", source: "pi" }]);
  const configurationRevision = (calls[0]!.args.configuration as { revision: string }).revision;
  assert.match(configurationRevision, /^[a-f0-9]{64}$/);
  const request = { configurationRevision, operationId: "fixture-operation", runId: "fixture-run", token: "fixture-token", callbacks: "00000000-0000-4000-8000-000000000001", lane: "foreground", cwd: data, sessionDir: data, sessionId: null, prompt: "fixture", systemPrompt: "", resources: "configured", deadline: null };
  const kernel = async (id: string, args: Record<string, unknown>) => (await tool({ id, args, caller: { kind: "kernel" } })).result;
  assert.deepEqual(await kernel("start", request), { operationId: request.operationId });
  assert.equal(runs[0]!.providerOptions!.thinking, "high"); assert.equal(configurations[0]!.model, "local/fixture");
  assert.deepEqual(await kernel("native", { operationId: request.operationId, request: { type: "future_feature", "opaque-key": null } }), { response: { type: "response", request: { type: "future_feature", "opaque-key": null }, instance: 1 } });
  assert.equal(configurations.length, 1); assert.equal(starts, 1);
  await writeFile(join(data, "configuration.json"), "invalid configuration");
  await writeFile(join(data, "session.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: "retained reply" } }) + "\n");
  assert.deepEqual(await kernel("transcript", { sessionDir: data, limit: 1 }), [{ id: "session.jsonl:0:0", at: "", kind: "text", text: "retained reply" }]);
  finish({ outcome: "finished", sessionId: null, error: null });
  disconnect();
}
