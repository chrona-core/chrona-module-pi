import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { moduleManifestSchema, type AgentProviderRegistration, type ProviderRunInput } from "@chrona/contracts/steward";
import { assertProviderBinding, callProviderEndpoint, registerAgentProvider, runProviderBinding, selectAgentProvider } from "../../Chrona/packages/kernel/src/agent/agent-provider";
import { reconcileAgentStops } from "../../Chrona/packages/kernel/src/agent/agent-recovery";
import { admitContextPrimitive } from "../../Chrona/packages/kernel/src/agent/agent-context";
import { moduleContext } from "../../Chrona/packages/kernel/src/modules/module-context";
import { requestStatus, setStatusIn } from "../../Chrona/packages/kernel/src/modules/module-status";
import { moduleSupervisor } from "../../Chrona/packages/kernel/src/modules/module-supervisor";
import { testModuleProcess } from "../../Chrona/packages/kernel/src/__testing__/module-test-process";
import { testDb } from "../../Chrona/packages/kernel/src/__testing__/test-db";
import { startLocalProvider } from "../../Chrona/packages/kernel/src/execution/local-runtime";
import { createRuns } from "../../Chrona/packages/kernel/src/execution/runs";
import { agent } from "../../Chrona/packages/kernel/src/system/agent";
import { registerSystemModules } from "../../Chrona/packages/kernel/src/system/system-modules";
import { CallError } from "../../Chrona/packages/kernel/src/modules/module-call-error";
import type { StewardPorts } from "../../Chrona/packages/kernel/src/ports";
import "../../Chrona/packages/kernel/src/modules/module-effects";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const declaration: AgentProviderRegistration = {
  id: "offline", name: "Fence recovery backend", protocolVersion: 1,
  capabilities: { conversation: true, completion: true, native: true, images: false, interactions: false, resume: true },
  endpoints: { health: "health", start: "start", status: "status", inject: "inject", abort: "abort", release: "release", native: "native", complete: "complete", transcript: "transcript" },
};
async function fixture({ activated = false, stage = "unknown", fenceApplication = false, confirmAbort = true }: { activated?: boolean; stage?: "queued" | "running" | "unknown"; fenceApplication?: boolean; confirmAbort?: boolean } = {}) {
  registerSystemModules();
  const db = testDb({ injectedAgent: false }), dataDir = await mkdtemp(join(tmpdir(), "chrona-provider-fence-"));
  const databases = await db.$queryRawUnsafe<{ name: string; file: string }[]>("PRAGMA database_list");
  const workspaceId = (await db.workspace.create({ data: { name: "provider fence recovery" } })).id;
  const requests: { name: string; args: Record<string, unknown> }[] = [];
  let stopped = false;
  const peer = testModuleProcess(async event => {
    if (event.trigger.kind !== "tool") return {};
    const { id: name, args } = event.trigger;
    requests.push({ name, args });
    if (name === "health") return { result: { name: "offline", supportsRunModel: true, complete: true, available: true, sandboxed: false, error: null } };
    // Model an ambiguous submission with a durable launch receipt and no attached observer.
    if (name === "start") throw new CallError("unknown", "Submission response lost");
    if (name === "abort" && confirmAbort) stopped = true;
    if (name === "status") return { result: { operationId: args.operationId, outcome: stopped ? { outcome: "failed", sessionId: null, error: "Original operation stopped; external effects remain unconfirmed" } : null, failure: false } };
    return { result: {} };
  });
  const ports: StewardPorts = { db, dataDir, publicUrl: null, now: () => new Date(), sandbox: { available: true, isolated: false, startModule: peer.startModule } };
  cleanups.push(async () => { await moduleSupervisor(ports).stop(); await db.$disconnect(); await rm(dataDir, { recursive: true, force: true }); await rm(dirname(databases.find(row => row.name === "main")!.file), { recursive: true, force: true }); });
  const backend = await db.module.create({ data: { workspaceId, name: "fenced-backend", status: "active", activeHash: "backend-v1", activationId: "original-activation" } });
  const string = { type: "string" }, object = { type: "object", properties: {} };
  const startProperties = Object.fromEntries(["operationId", "runId", "token", "lane", "cwd", "sessionDir", "prompt", "systemPrompt", "resources", "callbacks", "model", "configurationRevision"].map(key => [key, string]));
  Object.assign(startProperties, { sessionId: { type: ["string", "null"] }, deadline: { type: ["string", "null"] }, providerOptions: object, searchTools: { type: "boolean" }, images: { type: "array", items: object }, extraTools: { type: "array", items: string }, hostPaths: { type: "array", items: string }, content: { type: "array", items: object } });
  const manifest = moduleManifestSchema.parse({ name: backend.name, entry: "index.ts", tests: ["test.ts"], activated, uses: ["agent.register"], effects: [], tools: Object.values(declaration.endpoints).map(name => ({ name, description: name, visibility: ["kernel"], parameters: { type: "object", properties: name === "health" ? {} : name === "start" ? startProperties : { operationId: string } }, output: {} })) });
  await db.moduleVersion.create({ data: { moduleId: backend.id, hash: backend.activeHash!, manifest, source: "user", status: "approved", intent: {}, report: {} } });
  const backendCaller = { kind: "module" as const, module: backend.name, moduleId: backend.id, hash: backend.activeHash! };
  await registerAgentProvider(ports, workspaceId, backendCaller, declaration);
  const app = await db.module.create({ data: { workspaceId, name: "entry-app", activeHash: "app-v1" } });
  const appManifest = moduleManifestSchema.parse({ name: app.name, entry: "index.ts", tests: ["test.ts"], keepAlive: true, effects: [], uses: ["agent.run", "agent.stop"], model: { tier: "any", maxCalls: 2, maxOutputTokens: 20 } });
  await db.moduleVersion.create({ data: { moduleId: app.id, hash: app.activeHash!, manifest: appManifest, source: "user", status: "approved", intent: {}, report: {} } });
  const caller = { kind: "module" as const, module: app.name, moduleId: app.id, hash: app.activeHash! };
  const admitted = await agent.handle({ ports, workspaceId, caller, call: { id: "original-run", key: "original-run" } }, "run", { prompt: "offline recovery" }) as { runId: string };
  const claimed = stage === "queued" ? null : await createRuns(ports, workspaceId).claimNext("background");
  if (stage !== "queued") expect(claimed?.runId).toBe(admitted.runId);
  const run = await db.run.findUniqueOrThrow({ where: { id: admitted.runId } });
  const input: ProviderRunInput = { runId: run.id, token: claimed?.token ?? "", lane: "background", cwd: run.cwd, sessionDir: join(dataDir, "sessions"), sessionId: null, prompt: run.prompt, systemPrompt: "system", resources: "configured", deadline: run.deadlineAt };
  if (stage !== "queued") await expect(startLocalProvider(ports, workspaceId, input)).rejects.toMatchObject({ code: "unknown" });
  if (stage === "unknown") await createRuns(ports, workspaceId).finish(run.id, { outcome: "unavailable", sessionId: null, error: "Lost observer" });
  const context = moduleContext(ports, workspaceId);
  await expect(requestStatus(context, fenceApplication ? app.id : backend.id, "paused", "drain")).rejects.toMatchObject({ code: "conflict" });
  const binding = await runProviderBinding(ports, workspaceId, run.id);
  const control = (endpoint: "status" | "abort" | "release", key?: string) => callProviderEndpoint(ports, workspaceId, binding, endpoint, { operationId: run.id }, key);
  return { db, ports, workspaceId, backend, backendCaller, manifest, context, binding, run, input, requests, control, app, caller, confirmStop: () => { stopped = true; } };
}

test.skipIf(process.platform !== "linux")("cold actual Pi SDK rejects fenced activation yet reconciles only the original host's descendant-stop receipt", async () => {
  const f = await fixture({ activated: true });
  const data = join(f.ports.dataDir, "platform/data", f.backend.id), profile = join(data, "profile");
  await mkdir(profile, { recursive: true });
  await mkdir(join(data, "operations"));
  await mkdir(join(f.ports.dataDir, "platform", "host-stops"), { recursive: true });
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  await writeFile(join(data, "pi-host.json"), JSON.stringify({ command: "/must-not-launch-pi", agentDir: profile, chronaExtension: "/fixture/bridge", agentUrl: "http://fixture.invalid" }), { mode: 0o600 });
  const generation = "a".repeat(64), key = createHash("sha256").update(JSON.stringify(f.run.id)).digest("hex");
  const journal = join(data, "operations", `${key}.json`), stopReceipt = join(f.ports.dataDir, "platform", "host-stops", `${generation}.json`);
  await writeFile(journal, JSON.stringify({ digest: "c".repeat(64), hostGeneration: generation }), { mode: 0o600 });
  const receipt = (treeClean: boolean) => JSON.stringify({ version: 1, generation, state: "stopped", scope: "descendants", treeClean });
  await writeFile(stopReceipt, receipt(false), { mode: 0o600 });
  const children: ReturnType<typeof Bun.spawn>[] = [];
  f.ports.sandbox!.startModule = input => {
    const child = Bun.spawn([process.execPath, "--no-install", join(import.meta.dir, "../runtime.ts")], {
      cwd: join(import.meta.dir, "../../Chrona"), stdin: "ignore", stdout: "ignore", stderr: "pipe",
      env: { ...process.env, CHRONA_IPC_ENDPOINT: input.ipcEndpoint, CHRONA_IPC_TOKEN: input.ipcToken, CHRONA_DATA: input.dataDir,
        CHRONA_MODULE_BINDINGS: "{}", CHRONA_HOST_GENERATION: "b".repeat(64), CHRONA_HOST_STOP_RECEIPT: join(f.ports.dataDir, "platform", "host-stops", "b".repeat(64) + ".json") },
    });
    children.push(child);
    return { pid: child.pid, exited: child.exited.then(code => ({ code, signal: null })), stderr: () => "", kill: () => { child.kill(); } };
  };
  // The production SDK preserves the forbidden category for failed registration,
  // so the supervisor treats activation rejection as a nonfatal handler response.
  const now = f.ports.now().toISOString();
  await expect(moduleSupervisor(f.ports).deliver(f.backend.id, f.binding.hash, { now, params: {}, trigger: { kind: "activated", id: "activated", firedAt: now } })).rejects.toMatchObject({ code: "forbidden" });
  expect(await f.control("status")).toMatchObject({ operationId: f.run.id, outcome: null, failure: true });
  await expect(f.control("release")).rejects.toMatchObject({ code: "conflict" });
  await reconcileAgentStops(f.ports, f.workspaceId);
  await expect(requestStatus(f.context, f.backend.id, "active", "no descendant proof")).rejects.toMatchObject({ code: "conflict" });
  // An abort on an orphaned operation is unknown, and cannot invent stop proof.
  await expect(f.control("abort")).rejects.toMatchObject({ code: "unknown" });
  expect((await f.db.run.findUniqueOrThrow({ where: { id: f.run.id } })).stopStatus).toBe("unknown");
  expect(JSON.parse(await readFile(journal, "utf8"))).not.toHaveProperty("outcome");
  // That unknown reply intentionally retires this SDK process. Wait only for its
  // actual exit before the next cold host reads the trusted original receipt.
  await children[0]!.exited;
  await writeFile(stopReceipt, receipt(true));
  await reconcileAgentStops(f.ports, f.workspaceId);
  expect((await f.db.run.findUniqueOrThrow({ where: { id: f.run.id } })).stopStatus).toBe("confirmed");
  expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({ hostGeneration: generation, outcome: { outcome: "failed", error: expect.stringContaining("work was not replayed") } });
  await f.control("abort");
  await f.control("release");
  await requestStatus(f.context, f.backend.id, "active", "trusted descendant stop");
  expect((await f.db.module.findUniqueOrThrow({ where: { id: f.backend.id } })).executionFenceAt).toBeNull();
  expect(f.requests.filter(request => request.name === "start")).toHaveLength(1);
  expect(await f.db.providerLaunch.count({ where: { runId: f.run.id } })).toBe(1);
  expect(children).toHaveLength(2);
  expect(children[1]!.exitCode).toBeNull();
  expect(await f.db.moduleRun.count({ where: { moduleId: f.backend.id, triggerId: "activated", error: { not: null } } })).toBe(1);
});
