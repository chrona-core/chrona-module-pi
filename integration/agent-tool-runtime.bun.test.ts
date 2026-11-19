import { selectContextTools } from "../../Chrona/packages/kernel/src/agent/agent-context-tools";
import { moduleCallbackContractHash } from "../../Chrona/packages/kernel/src/modules/module-tool-contract";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { moduleManifestSchema } from "@chrona/contracts/steward";
import { agentFixture } from "./agent-application.fixtures";
import { startLocalProvider } from "../../Chrona/packages/kernel/src/execution/local-runtime";
import { createStewardRuntime } from "../../Chrona/apps/server/src/steward-runtime";

// Generic server/Agent acceptance uses the real SDK host and a local fake Pi process.
async function fixture() {
  const f = await agentFixture();
  // Reuse only the Pi provider host; discard the engine fixture's unrelated placeholder rows.
  await f.ports.db.module.deleteMany({ where: { name: { in: ["web", "mcp", "files", "notify", "events"] } } });
  const runtime = createStewardRuntime(f.ports.db, { dataDir: f.ports.dataDir, sandbox: f.ports.sandbox });
  runtime.ports.moduleExternalResources = f.ports.moduleExternalResources;
  runtime.ports.moduleSdk = f.ports.moduleSdk;
  const db = f.ports.db;
  const entry = await db.module.create({ data: { workspaceId: f.workspaceId, name: "execution-test-entry", activeHash: "v1" } });
  await db.moduleVersion.create({ data: { moduleId: entry.id, hash: "v1", source: "user", status: "approved", intent: {}, report: {},
    manifest: moduleManifestSchema.parse({ name: entry.name, entry: "index.ts", tests: ["test.ts"], effects: [], keepAlive: true, uses: ["modules.list"] }) } });
  const context = await db.agentContext.create({ data: { workspaceId: f.workspaceId, ownerId: "owner", moduleId: entry.id, hash: "v1" } });
  await db.run.update({ where: { id: f.input.runId }, data: { sessionId: context.id } });
  const selected = await selectContextTools(runtime.ports, { workspaceId: f.workspaceId, ownerId: "owner", caller: { kind: "module", moduleId: entry.id, hash: "v1" } }, ["modules.list"]);
  await db.agentRunAdmission.create({ data: { runId: f.input.runId, moduleId: entry.id, hash: context.hash, targets: selected.entries.map(entry => ({ target: `${entry.module.name}.${entry.tool.name}`, moduleId: entry.module.id, contractHash: moduleCallbackContractHash(entry.tool) })), content: [] } });
  return { ...f, runtime, db, entry, async close() { await runtime.stop(); await f.close(); } };
}
async function waitForPid(cwd: string) {
  for (let i = 0; i < 100; i++) {
    try { return Number(await readFile(join(cwd, "pi.pid"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await Bun.sleep(20); }
  }
  throw new Error("Fake Pi did not start");
}

test("a fake Pi subprocess executes its injected tool through the real SDK with the Run caller’s identity", async () => {
  const f = await fixture();
  let handle: Awaited<ReturnType<typeof startLocalProvider>> | undefined;
  try {
    const progress: unknown[] = [];
    handle = await startLocalProvider(f.runtime.ports, f.workspaceId, { ...f.input,
      events: { async progress(value) { progress.push(value); }, async usage() {}, async resources() {}, async question() { return { decision: "cancel" }; } },
    });
    expect(await waitForPid(f.input.cwd)).toBeGreaterThan(0);
    const definitions = JSON.parse(await readFile(join(f.input.cwd, "tool-definitions.json"), "utf8")) as { name: string }[];
    expect(definitions.map(tool => tool.name)).toEqual(["m_modules_list"]);
    expect(JSON.parse(await readFile(join(f.input.cwd, "tool-result.json"), "utf8"))).toMatchObject({ items: expect.any(Array) });
    expect(await f.db.moduleInvocation.findFirst({ where: { target: "modules", tool: "list" } })).toMatchObject({ callerModuleId: f.entry.id, status: "succeeded" });
    for (let i = 0; i < 100; i++) {
      if (progress.some(value => {
        const update = value as { phase: string; tool: string | null };
        return update.phase === "reading" && update.tool === "read";
      })) break;
      await Bun.sleep(20);
    }
    expect(progress).toContainEqual({ phase: "reading", tool: "read" });
    await handle.abort();
    const outcome = await handle.done; handle = undefined;
    expect(outcome).toMatchObject({ outcome: "failed" });
    const callbacks = await f.db.moduleInvocation.findMany({ where: { target: "runtime-callback", tool: "event" } });
    expect(callbacks).toEqual([]);
    expect(JSON.stringify(await f.db.moduleInvocation.findMany())).not.toContain("private-agent");
  } finally { if (handle) { await handle.abort().catch(() => {}); await handle.done.catch(() => {}); } await f.close(); }
}, 20_000);

test.skipIf(process.platform !== "linux")("losing the actual Pi SDK host stops fake Pi without inventing a successful completion", async () => {
  const f = await fixture();
  try {
    const handle = await startLocalProvider(f.runtime.ports, f.workspaceId, f.input);
    const done = handle.done.then(outcome => ({ outcome, error: null }), error => ({ outcome: null, error }));
    const pid = await waitForPid(f.input.cwd);
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const parentPid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
    expect(parentPid).toBeGreaterThan(0);
    process.kill(-parentPid, "SIGKILL");
    const result = await done;
    expect(result.outcome).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    for (let i = 0; i < 100; i++) {
      try { if ((await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z")) break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
      await Bun.sleep(20);
    }
    let alive = false;
    try { alive = !(await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    expect(alive).toBe(false);
  } finally { await f.close(); }
}, 20_000);
