import { type ProviderAdapter} from "@chrona/contracts/steward";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";





import type { StewardPorts } from "../../Chrona/packages/kernel/src/ports";



import { secrets } from "../../Chrona/packages/kernel/src/system/secrets";






import { createPiOperations } from "../operations";
import { createBrowsers } from "../browser";
import { currentHostGeneration, hostStopped } from "../host-recovery";

describe("ordinary Pi browser discovery", () => {
  const cleanups: string[] = [];
  afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function temp() { const dir = await mkdtemp(join(tmpdir(), "chrona-browser-")); cleanups.push(dir); return dir; }
  const program = (name: string) => process.platform === "win32" ? `${name}.exe` : name;
  async function executable(path: string) { await writeFile(path, "browser fixture", { mode: 0o755 }); return realpathSync(path); }

  test("an explicit browser comes first, then host PATH with its native delimiter", async () => {
    const root = await temp(), bin = join(root, "bin"), empty = join(root, "empty");
    await mkdir(bin); await mkdir(empty);
    const onPath = await executable(join(bin, program("google-chrome"))), configured = await executable(join(root, program("my-chrome")));
    const path = [empty, bin].join(delimiter);
    const which = spyOn(Bun, "which");
    try {
      expect(createBrowsers({ configured, path }).find()).toBe(configured);
      expect(which).not.toHaveBeenCalled();
      expect(createBrowsers({ configured: join(root, "missing"), path }).find()).toBe(onPath);
      expect(createBrowsers({ path: empty }).find()).toBeNull();
    } finally { which.mockRestore(); }
  });

  test("missing browsers stay unavailable without acquisition, and an owner installation is found later", async () => {
    const root = await temp(), browsers = createBrowsers({ path: root });
    // Installed acquisition tools must not be invoked when no browser is present.
    await executable(join(root, program("nix")));
    await executable(join(root, program("unzip")));
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("Unexpected browser download"); }) as unknown as typeof fetch);
    try {
      const before = await readdir(root);
      expect(browsers.ensure()).toBeNull();
      expect(browsers.ensure()).toBeNull();
      await Promise.resolve();
      expect(await readdir(root)).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
      const browser = await executable(join(root, program("chromium")));
      expect(browsers.ensure()).toBe(browser);
    } finally { fetcher.mockRestore(); }
  });

  test("directories and non-executables are not browsers", async () => {
    const root = await temp(), bin = join(root, "bin");
    await mkdir(bin);
    expect(createBrowsers({ configured: root, path: bin }).ensure()).toBeNull();
    if (process.platform !== "win32") {
      const file = join(root, "plain-file");
      await writeFile(file, "", { mode: 0o600 });
      expect(createBrowsers({ configured: file, path: bin }).ensure()).toBeNull();
    }
  });
});

describe("ordinary Pi host stop evidence", () => {
  const generation = "a".repeat(64);
  const receipt = { version: 1, generation, state: "stopped", scope: "descendants", treeClean: true };
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "chrona-pi-host-receipt-"));
    await mkdir(join(root, ".host-stops"), { mode: 0o700 });
    const previousReceipt = process.env.CHRONA_HOST_STOP_RECEIPT;
    process.env.CHRONA_HOST_STOP_RECEIPT = join(root, ".host-stops", "b".repeat(64) + ".json");
    return { root, path: join(root, ".host-stops", generation + ".json"), previousReceipt };
  }

  test.skipIf(process.platform !== "linux")("Pi accepts only exact descendant stop evidence for the original generation", async () => {
    const { root, path, previousReceipt } = await fixture();
    try {
      expect(await hostStopped(generation)).toBe(false);
      await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
      expect(await hostStopped(generation)).toBe(true);
      for (const invalid of [
        { ...receipt, version: 2 }, { ...receipt, generation: "b".repeat(64) },
        { ...receipt, state: "unknown" }, { ...receipt, scope: "process-group" },
        { ...receipt, treeClean: false }, { ...receipt, treeClean: "true" },
        { version: 1, generation }, null, "malformed JSON",
      ]) {
        await writeFile(path, invalid === "malformed JSON" ? "{" : JSON.stringify(invalid));
        expect(await hostStopped(generation)).toBe(false);
      }
      for (const invalid of ["", "../../Chrona/packages/kernel/src" + generation, "A".repeat(64), "a".repeat(63)]) {
        expect(await hostStopped(invalid)).toBe(false);
      }
    } finally { if (previousReceipt === undefined) delete process.env.CHRONA_HOST_STOP_RECEIPT; else process.env.CHRONA_HOST_STOP_RECEIPT = previousReceipt; await rm(root, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform !== "linux")("Pi rejects receipts with untrusted storage", async () => {
    const { root, path, previousReceipt } = await fixture();
    try {
      await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
      await chmod(path, 0o644);
      expect(await hostStopped(generation)).toBe(false);
      await chmod(path, 0o600);
      const getuid = spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      try { expect(await hostStopped(generation)).toBe(false); } finally { getuid.mockRestore(); }
      await link(path, join(root, "hardlink"));
      expect(await hostStopped(generation)).toBe(false);
      await rm(join(root, "hardlink"));
      await writeFile(path, JSON.stringify(receipt) + " ".repeat(512));
      expect(await hostStopped(generation)).toBe(false);
      await rm(path);
      await writeFile(join(root, "target"), JSON.stringify(receipt), { mode: 0o600 });
      await symlink(join(root, "target"), path);
      expect(await hostStopped(generation)).toBe(false);
      await rm(path);
      await mkdir(path, { mode: 0o700 });
      expect(await hostStopped(generation)).toBe(false);
    } finally { if (previousReceipt === undefined) delete process.env.CHRONA_HOST_STOP_RECEIPT; else process.env.CHRONA_HOST_STOP_RECEIPT = previousReceipt; await rm(root, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform !== "linux")("a receipt cannot confirm termination of the current Pi host", async () => {
    const { root, path, previousReceipt } = await fixture(), previous = process.env.CHRONA_HOST_GENERATION;
    try {
      await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
      process.env.CHRONA_HOST_GENERATION = generation;
      expect(currentHostGeneration()).toBe(generation);
      expect(await hostStopped(generation)).toBe(false);
      process.env.CHRONA_HOST_GENERATION = "invalid";
      expect(currentHostGeneration()).toBeUndefined();
      expect(await hostStopped(generation)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CHRONA_HOST_GENERATION;
      else process.env.CHRONA_HOST_GENERATION = previous;
      if (previousReceipt === undefined) delete process.env.CHRONA_HOST_STOP_RECEIPT; else process.env.CHRONA_HOST_STOP_RECEIPT = previousReceipt; await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ordinary Pi completion durability", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  const args = { commandKey: "completion", prompt: "private prompt", maxOutputTokens: 200, timeoutMs: 5000 };
  async function setup(complete: NonNullable<ProviderAdapter["complete"]>) {
    const data = await mkdtemp(join(tmpdir(), "chrona-p0-pi-completion-"));
    cleanups.push(() => rm(data, { recursive: true, force: true }));
    const provider: ProviderAdapter = { name: "pi", async health() { return { available: true, sandboxed: false, error: null }; },
      start() { throw new Error("Unexpected conversational start"); }, complete };
    const prepare = async () => ({ provider, input: { ...args, model: "fixture/model" } });
    const operations = () => createPiOperations(data, async () => { throw new Error("Unexpected conversation preparation"); }, undefined, 64, prepare);
    return { data, operations };
  }
  async function settled(operations: ReturnType<typeof createPiOperations>) {
    const until = Date.now() + 2000;
    for (;;) {
      const status = await operations.control("status", { operationId: args.commandKey }) as { operationId: string; outcome: unknown; failure: boolean; completion?: unknown };
      if (status.outcome || status.failure) return status;
      if (Date.now() >= until) throw new Error("Completion receipt did not settle");
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  test("a bounded long completion is delivered whole and replayed after restart", async () => {
    const text = "ordinary result ".repeat(10_000); let launches = 0;
    const f = await setup(async () => { launches++; return { text, inputTokens: 2, outputTokens: 180 }; });
    const expected = { text, inputTokens: 2, outputTokens: 180 };
    const first = f.operations();
    expect(await first.complete(args)).toEqual({ operationId: args.commandKey });
    expect(await settled(first)).toMatchObject({ outcome: { outcome: "finished" }, completion: expected });
    const restarted = f.operations();
    expect(await restarted.complete(args)).toEqual({ operationId: args.commandKey });
    expect(await settled(restarted)).toMatchObject({ outcome: { outcome: "finished" }, completion: expected });
    expect(launches).toBe(1);
  });

  test("failed outcome persistence never acknowledges a result or repeats the effect after restart", async () => {
    let launches = 0;
    const f = await setup(async () => {
      launches++;
      // The durable claim exists before execution; obstruct only the outcome commit.
      const key = createHash("sha256").update(JSON.stringify(args.commandKey)).digest("hex");
      await mkdir(join(f.data, "operations", key + ".json.pending"));
      return { text: "uncommitted result", inputTokens: 2, outputTokens: 3 };
    });
    const first = f.operations();
    expect(await first.complete(args)).toEqual({ operationId: args.commandKey });
    expect(await settled(first)).toEqual({ operationId: args.commandKey, outcome: null, failure: true });
    await expect(first.complete(args)).rejects.toMatchObject({ code: "unknown" });
    await expect(f.operations().complete(args)).rejects.toMatchObject({ code: "unknown" });
    expect(launches).toBe(1);
  });
});
