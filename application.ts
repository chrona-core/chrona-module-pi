import { randomUUID } from "node:crypto";
import { z } from "zod";
import { providerContextV1, providerInspectInput, providerAnswerSchema, runtimeStartSchema, runtimeEventSchema, type RuntimeEvent, type ProviderRunInput, type ProviderAdapter } from "@chrona/contracts/steward";
import { piModelCatalog, readPiTranscript, piTranscriptPage, PI_TRANSCRIPT_MAX_BYTES, piCompletionVersionError, piLaunchConfig, type PiProviderOptions } from "@chrona/pi";
import { Buffer } from "node:buffer";
import { createConfiguration, launchConfiguration, type ConfigurationSnapshot, type ThinkingLevel } from "./configuration";
import { createPiOperations, PiError } from "./operations";
import type { PrepareCompletion } from "./completions";
import { toolSchemas, isTool, runOptionsSchema, type ToolName } from "./schema";
import { settingsRegistration } from "./settings-page";

import { createRegistration } from "./registration";
export { REGISTRATION } from "./registration";
export type ApplicationInput = {
  data: string; options: PiProviderOptions & { thinking?: ThinkingLevel };
  createProvider(options: PiProviderOptions): ProviderAdapter;
  call(target: string, args: Record<string, unknown>): Promise<unknown>;
};
function authorize(name: ToolName, caller: { kind: string } | undefined, callId: string | undefined) {
  if (name === "configure" || name === "models") {
    // The ordinary router admits owner-authority modules to owner-visible tools.
    // A live call receipt is mandatory; no privileged agent-admit callback exists.
    if (!callId || !caller || !["owner", "module"].includes(caller.kind)) throw new PiError("forbidden", "Pi configuration requires an admitted owner call");
  } else if (caller?.kind !== "kernel") throw new PiError("forbidden", "Pi execution endpoints require the kernel");
}
function completionReady(snapshot: ConfigurationSnapshot, provider: ProviderAdapter, launchError: string | null): boolean {
  if (!provider.complete || !snapshot.effective.model) return false;
  const unavailable = piCompletionVersionError(piLaunchConfig(snapshot.options).version) ?? launchError;
  const complete = unavailable === null;
  if (!complete) {
    console.error(JSON.stringify({ component: "pi", event: "completion_unavailable", error: String(unavailable).slice(0, 300) }));
  }
  return complete;
}
export function createPiApplication({ data, options, createProvider, call }: ApplicationInput) {
  const configuration = createConfiguration(data, options);
  const settings = settingsRegistration(call), registration = createRegistration(configuration, call);
  async function event(callbackId: string, value: RuntimeEvent) {
    return call("runtime-callback.event", { callbackId, event: runtimeEventSchema.parse(value) });
  }
  function runInput(raw: unknown): ProviderRunInput {
    const { operationId: _id, configurationRevision: _revision, callbacks, deadline, ...request } = runtimeStartSchema.parse(raw);
    if (!callbacks) throw new PiError("forbidden", "Pi start requires kernel-bound callbacks");
    return { ...request, token: request.token ?? "", deadline: deadline === null ? null : new Date(deadline),
      async callTool({ name, ...args }) {
        const tool = request.tools?.find(tool => tool.name === name);
        if (!tool) throw new PiError("forbidden", "Tool is outside the Provider Run binding");
        return call("tool-delegation.invoke", { reference: tool.reference, ...args });
      },
      events: {
        async raw(value) { await event(callbacks, { kind: "raw", value: value as Extract<RuntimeEvent, { kind: "raw" }>["value"] }); },
        async progress(value) { await event(callbacks, { kind: "progress", value }); },
        async usage(value) { await event(callbacks, { kind: "usage", value }); },
        async resources(value) { await event(callbacks, { kind: "resources", value }); },
        async question(value, signal) {
          const requestId = randomUUID();
          const abort = () => { void event(callbacks, { kind: "interrupt", requestId }).catch(() => {}); };
          signal.addEventListener("abort", abort, { once: true });
          try {
            const answer = event(callbacks, { kind: "question", requestId, value });
            if (signal.aborted) abort();
            return providerAnswerSchema.parse(await answer);
          } finally { signal.removeEventListener("abort", abort); }
        },
      },
    };
  }
  const prepareCompletion: PrepareCompletion = async request => {
    if (!request.configurationRevision) throw new PiError("invalid", "Pi completion requires an admitted configuration revision");
    const snapshot = await configuration.snapshot(request.configurationRevision), model = request.model ?? snapshot.effective.model;
    if (!model) throw new PiError("unavailable", "Pi completion requires an explicit configured model");
    const thinking = request.thinking ?? snapshot.effective.thinking ?? undefined;
    return { provider: createProvider({ ...snapshot.options, model, ...(thinking ? { thinking } : {}) } as PiProviderOptions), input: {
      model, thinking, system: request.system, prompt: request.prompt, maxOutputTokens: request.maxOutputTokens, timeoutMs: request.timeoutMs,
    }, configuration: launchConfiguration(snapshot, { model: request.model, thinking: request.thinking }) };
  };
  const operations = createPiOperations(data, async request => {
    if (!request.configurationRevision) throw new PiError("invalid", "Pi launch requires an admitted configuration revision");
    const snapshot = await configuration.snapshot(request.configurationRevision), overrides = runOptionsSchema.parse(request.providerOptions ?? {});
    if (request.model && overrides.model && request.model !== overrides.model) throw new PiError("conflict", "Pi model conflicts with the kernel-pinned model");
    const selected = { ...snapshot.options, ...overrides, ...(request.model ? { model: request.model } : {}) };
    return { provider: createProvider(selected), input: runInput({ ...request, providerOptions: {
      ...(snapshot.effective.thinking ? { thinking: snapshot.effective.thinking } : {}), ...overrides,
    } }), configuration: launchConfiguration(snapshot, overrides, request.model) };
  }, async (operationId, callbacks, outcome) => { await event(callbacks, { kind: "settled", operationId, outcome }); }, 64, prepareCompletion);

  async function inspect(name: "health" | "transcript", args: unknown) {
    if (name === "health") {
      try {
        const snapshot = await configuration.snapshot(), provider = createProvider(snapshot.options);
        const health = await provider.health();
        const complete = completionReady(snapshot, provider, health.available ? null : health.error ?? "Pi unavailable");
        return { name: "pi", supportsRunModel: provider.supportsRunModel ?? false, complete, ...health };
      } catch (error) {
        // Callers get a fixed reason (host configuration may be private); the operator log gets the real one.
        console.error(JSON.stringify({ component: "pi", event: "health_unavailable", error: String((error as Error)?.message ?? error).slice(0, 300) }));
        return { name: "pi", supportsRunModel: true, complete: false, available: false, sandboxed: false, error: "Pi configuration or host bridge is unavailable" };
      }
    }
    const request = args as { sessionDir: string; limit: number; runId?: string; page?: true; cursor?: string };
    if (request.page) return piTranscriptPage(request);
    return readPiTranscript(request);
  }
  const catalogPages = new Map<string, ReturnType<typeof piModelCatalog>>();
  function catalogPage(options: PiProviderOptions, revision: string, cursor: string | undefined) {
    const key = JSON.stringify([revision, cursor]);
    const pending = catalogPages.get(key);
    if (pending) return pending;
    if (catalogPages.size >= 4) throw new PiError("capacity", "Too many Pi catalog probes are running");
    const page = piModelCatalog(options, cursor).finally(() => { catalogPages.delete(key); });
    catalogPages.set(key, page);
    return page;
  }
  async function query({ query, version, operationId, configurationRevision, args }: z.infer<typeof providerInspectInput>) {
    if (query === "context" && version === 1 && operationId) {
      z.strictObject({}).parse(args);
      return { query, version, data: providerContextV1.parse(await operations.contextUsage(operationId)) };
    }
    if (query === "models" && version === 1 && !operationId) {
      const { cursor } = z.strictObject({ cursor: z.string().min(1).max(600).optional() }).parse(args);
      const snapshot = await configuration.snapshot(configurationRevision);
      const prefix = `${snapshot.revision}:`;
      if (cursor && !cursor.startsWith(prefix)) throw new PiError("conflict", "Pi model catalog configuration changed");
      try {
        const data = await catalogPage(snapshot.options, snapshot.revision, cursor?.slice(prefix.length));
        return { query, version, data: { ...data, nextCursor: data.nextCursor ? prefix + data.nextCursor : null } };
      }
      catch (error) {
        if (error instanceof PiError) throw error;
        console.error(JSON.stringify({ component: "pi", event: "model_inspection_failed", error: String(error) }));
        throw new PiError("unavailable", "Pi model catalog is unavailable");
      }
    }
    throw new PiError("invalid", "Pi does not support this inspection query, version or scope");
  }
  async function handle(name: string, raw: unknown, caller?: { kind: string }, callId?: string) {
    if (!isTool(name)) throw new PiError("not_found", "Pi tool not found");
    authorize(name, caller, callId);
    const args = toolSchemas[name][0].parse(raw);
    let result: unknown;
    if (name === "configure") result = await registration.configure(args);
    else if (name === "models") result = await configuration.models();
    else if (name === "inspect") result = await query(args as z.infer<typeof providerInspectInput>);
    else if (name === "start") result = await operations.start(args);
    else if (name === "complete") result = await operations.complete(args);
    else if (["status", "inject", "abort", "release", "native"].includes(name)) result = await operations.control(name, args as { operationId: string });
    else result = await inspect(name as "health" | "transcript", args);
    const parsed = toolSchemas[name][1].parse(result);
    // Enforce the bound before the SDK frames a reply, including adapter results.
    if (name === "transcript" && Buffer.byteLength(JSON.stringify(parsed)) > PI_TRANSCRIPT_MAX_BYTES) throw Object.assign(new Error("Pi transcript exceeds its reply bound"), { code: "too_large" });
    return parsed;
  }
  async function activate() { await registration.activate(); await settings.activate(); return {}; }
  async function refreshSettings() { await registration.refresh(); await settings.refresh(); }
  async function stop() { await operations.stop(); }
  return { handle, activate, refreshSettings, stop };
}

/** Never return parser values, backend exception strings, credentials or private request bodies. */
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof PiError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: "invalid", message: "Invalid Pi arguments" };
  if (error instanceof Error && "code" in error) {
    // Adapter errors carry fixed categories. Preserve the category without leaking
    // arbitrary backend exception text or a rejected native request body.
    const messages = {
      invalid: "Invalid Pi settings or native request",
      unsupported: "Pi native request cannot replace the bound session, model or bridge, or bypass Run admission",
      too_large: "Pi response exceeds its bound; transcript callers can request page:true and follow nextCursor",
      cursor_expired: "Pi transcript cursor expired; start a new page request",
      unavailable: "Pi backend or native handle is unavailable",
    };
    if (typeof error.code === "string" && Object.hasOwn(messages, error.code)) return { code: error.code, message: messages[error.code as keyof typeof messages] };
  }
  return { code: "unknown", message: "Pi operation remains unconfirmed" };
}
