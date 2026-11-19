import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPiProvider } from "./pi-provider";
import { prepareContent } from "./pi-launch";
import type { ProviderRunInput } from "@chrona/contracts/steward";

// Only fake subprocesses, never the installed model runner. Temp artifacts deliberately
// remain in OS temp (worker task forbids deletions).
async function fixture(mode = "normal") {
  const cwd = await mkdtemp(join(tmpdir(), "chrona-pi-rpc-"));
  const command = join(cwd, "pi");
  await writeFile(command, `#!${process.execPath}
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) {console.log('0.85.0');process.exit(0);}
writeFileSync('launch.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),profile:process.env.PI_CODING_AGENT_DIR,hasChronaDatabaseSecret:'CHRONA_DATABASE_SECRET' in process.env,hasRunToken:'CHRONA_AGENT_TOKEN' in process.env}));
const mode=${JSON.stringify(mode)};
const sessionId=process.argv[process.argv.indexOf('--session-id')+1];
const sessionDir=process.argv[process.argv.indexOf('--session-dir')+1];
const sessionFile=join(sessionDir,'fixture_'+sessionId+'.jsonl');
if(mode==='resume') writeFileSync('loaded-context.txt',existsSync(sessionFile)?readFileSync(sessionFile,'utf8'):'');
let streaming=false, queue=0, cycle=0, retried=false;
const emit = x => process.stdout.write(JSON.stringify(x)+'\\r\\n');
const reply=(c,data={})=>emit({id:c.id,type:'response',command:c.type,success:true,data});
function run() {
 streaming=true; cycle++; emit({type:'agent_start'});
 setTimeout(()=>{
  if(mode==='error') emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'failed '+'private-run-token'}});
  streaming=false; writeFileSync('completed-cycles.txt',String(cycle));emit({type:'agent_end'});
  if(queue) setTimeout(()=>{queue--; run();},45);
  else emit({type:'agent_settled'});
 },100);
}
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 buffer+=chunk;
 let n;
 while((n=buffer.indexOf('\\n'))!==-1){
  const c=JSON.parse(buffer.slice(0,n)); buffer=buffer.slice(n+1);
  appendFileSync('commands.jsonl',JSON.stringify(c)+'\\n');
  if(c.type==='get_state') {
   if(mode==='retry-state' && cycle===1 && !streaming && !retried) {
    retried=true;
    emit({type:'auto_retry_start'});
    setTimeout(()=>{
     emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'retry failed'}});
     emit({type:'auto_retry_end'});
     emit({type:'agent_end'});emit({type:'agent_settled'});
    },60);
   }
   reply(c,{sessionId:mode==='resume'?sessionId:mode==='missing-session-id'?undefined:'retained-session',model:{provider:'openai',id:mode==='wrong-model'?'other':'gpt-6.1-sol'},isStreaming:streaming,isCompacting:false,pendingMessageCount:queue});
  }
  if(c.type==='get_commands') reply(c,{commands:[]});
  if(c.type==='set_auto_retry'||c.type==='set_auto_compaction') reply(c);
  if(c.type==='clear_queue') {queue=0;reply(c,{steering:[],followUp:[]});}
  if(c.type==='prompt') {
   if(mode==='resume') {
    mkdirSync(sessionDir,{recursive:true});
    if(!existsSync(sessionFile)) writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()})+'\\n');
    appendFileSync(sessionFile,JSON.stringify({type:'message',message:{role:'user',content:c.message}})+'\\n');
   }
   reply(c);
   if(streaming&&c.streamingBehavior){queue++;continue;}
   if(mode==='crash'){process.stderr.write('crash '+'private-run-token');process.exit(7);}
   else if(mode==='malformed') process.stdout.write('not-json\\n');
   else if(mode==='partial') { const data=Buffer.from(JSON.stringify({type:'message_update',text:'你好\\u2028世界'})+'\\n'); process.stdout.write(data.subarray(0,43)); setTimeout(()=>{process.stdout.write(data.subarray(43));run();},10); }
   else if(mode!=='hang') run();
  }
  if(c.type==='steer'||c.type==='follow_up'){queue++;reply(c);}
  if(c.type==='abort'){reply(c); if(mode!=='hang')process.exit(0);}
 }
});
process.stdin.on('end',()=>process.exit(0));
`, { mode: 0o755 });
  await writeFile(join(cwd, "bridge.ts"), "");
  await writeFile(join(cwd, "web.ts"), "");
  const agentDir = await mkdtemp(join(tmpdir(), "chrona-pi-profile-"));
  const options = { command, agentDir, expectedVersion: "0.85.0", chronaExtension: join(cwd, "bridge.ts"), agentUrl: "http://127.0.0.1:1234/api/steward-agent" };
  const provider = createPiProvider(options);
  const input: ProviderRunInput = { runId: "run", token: "private-run-token", lane: "foreground", cwd, sessionDir: join(cwd, ".chrona/sessions"), sessionId: null, systemPrompt: "Fixture platform instructions", resources: "configured", prompt: "hello", deadline: new Date(Date.now() + 4000) };
  const commands = async () => (await readFile(join(cwd, "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { cwd, command, agentDir, options, provider, input, commands };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check().catch(() => false)) return; await Bun.sleep(10); }
  throw new Error("fixture did not reach expected state");
}
describe("Pi RPC provider", () => {
  test("minimal resources and supplied instructions do not depend on an execution identity", async () => {
    const f = await fixture();
    const provider = createPiProvider({ ...f.options, webExtension: join(f.cwd, "web.ts") });
    expect((await provider.start({ ...f.input, resources: "minimal", systemPrompt: "Perform a bounded document task." }).done).outcome).toBe("finished");
    const { args } = JSON.parse(await readFile(join(f.cwd, "launch.json"), "utf8"));
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Perform a bounded document task.");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--no-skills");
    expect(args).toContain(join(f.cwd, "web.ts"));
    expect((await provider.start({ ...f.input, sessionId: null }).done).outcome).toBe("finished");
    const configured = JSON.parse(await readFile(join(f.cwd, "launch.json"), "utf8")).args;
    expect(configured).not.toContain("--tools");
    expect(configured).toContain(join(f.cwd, "web.ts"));
  });
  test.each(["openai/gpt-6.1-sol", "gpt-6.1-sol"])("build model %s overrides defaults without rewriting the selected user profile", async model => {
    const f = await fixture();
    await writeFile(join(f.agentDir, "settings.json"), '{"retry":{"enabled":true}}');
    const provider = createPiProvider({ ...f.options, model: "other/default" });
    expect((await provider.start({ ...f.input, model, sessionId: null }).done).outcome).toBe("finished");
    const launch = JSON.parse(await readFile(join(f.cwd, "launch.json"), "utf8"));
    const args = launch.args;
    expect(args[args.indexOf("--model") + 1]).toBe(model);
    expect(launch.profile).toBe(f.agentDir);
    expect(existsSync(launch.profile)).toBe(true);
    expect(await readFile(join(f.agentDir, "settings.json"), "utf8")).toBe('{"retry":{"enabled":true}}');
    const commands = await f.commands();
    expect(commands.some(c => ["set_auto_retry", "set_auto_compaction"].includes(c.type))).toBe(false);
  });
  test.each(["openai/gpt-6.1-sol", "gpt-6.1-sol"])("model mismatch for %s fails without sending any prompt or falling back", async model => {
    const f = await fixture("wrong-model");
    expect((await f.provider.start({ ...f.input, model }).done).outcome).toBe("failed");
    expect((await f.commands()).some(c => c.type === "prompt")).toBe(false);
  });
  test("default and explicit trusted-local run locally; legacy required-isolation is rejected", async () => {
    const f = await fixture();
    for (const executionMode of [undefined, "trusted-local"] as const) {
      const local = createPiProvider({ ...f.options, executionMode });
      expect((await local.start(f.input).done).outcome).toBe("finished");
      expect(JSON.parse(await readFile(join(f.cwd, "launch.json"), "utf8")).args).not.toContain("--tmpfs");
    }
    await writeFile(join(f.cwd, "commands.jsonl"), "");
    const required = createPiProvider({ ...f.options, executionMode: "required-isolation" });
    expect((await required.start(f.input).done).outcome).toBe("unavailable");
    expect(await readFile(join(f.cwd, "commands.jsonl"), "utf8")).not.toContain('"type":"prompt"');
    expect(await required.health()).toMatchObject({ available: false, error: "Pi required-isolation is no longer supported; configure trusted-local execution" });
  });
  test("session, tools, images, cwd and filtered environment", async () => {
    const f = await fixture();
    const before = process.env.CHRONA_DATABASE_SECRET;
    process.env.CHRONA_DATABASE_SECRET = "must-not-leak";
    try {
      // The scoped bridge supplies module tools without restricting ambient native tools.
      const handle = f.provider.start({ ...f.input, images: [{ mime: "image/png", base64: "YWJj" }], extraTools: ["m_ledger_add_expense", "read,bash", "m_Bad"] });
      expect(await handle.done).toEqual({ outcome: "finished", sessionId: "retained-session", error: null });
      const launch = JSON.parse(await readFile(join(f.cwd, "launch.json"), "utf8"));
      expect(launch.cwd).toBe(f.cwd);
      expect(launch.hasChronaDatabaseSecret).toBe(false);
      expect(launch.hasRunToken).toBe(false);
      expect(launch.args[launch.args.indexOf("--session-id") + 1]).toBeString();
      expect(launch.args).not.toContain("--tools");
      expect(launch.args).not.toContain("builtin:tool-search");
      expect(launch.args).not.toContain("m_Bad");
      expect((await f.commands()).find(c => c.type === "prompt").images).toEqual([{ type: "image", mimeType: "image/png", data: "YWJj" }]);
      expect(await f.provider.health()).toEqual({ available: true, sandboxed: false, error: null });
    } finally { if (before === undefined) delete process.env.CHRONA_DATABASE_SECRET; else process.env.CHRONA_DATABASE_SECRET = before; }
  });
  test("deferred module tools load Pi's tool search and stay behind the m_* pattern", async () => {
    const f = await fixture();
    const handle = f.provider.start({ ...f.input, extraTools: ["m_ledger_add_expense"], searchTools: true });
    await handle.done;
    const args: string[] = JSON.parse(await readFile(join(f.cwd, "launch.json"), "utf8")).args;
    expect(args[args.indexOf("builtin:tool-search") - 1]).toBe("-e");
    expect(args).not.toContain("--tools");
  });
  test("injection queues steering during streaming and waits across agent_end", async () => {
    const f = await fixture(), handle = f.provider.start(f.input);
    await until(async () => (await f.commands()).some(c => c.type === "prompt"));
    await Bun.sleep(20);
    await handle.inject("more", [{ mime: "image/jpeg", base64: "ZA==" }]);
    expect((await f.commands()).find(c => c.type === "prompt" && c.message === "more")).toMatchObject({ streamingBehavior: "steer", images: [{ type: "image", mimeType: "image/jpeg", data: "ZA==" }] });
    expect((await handle.done).outcome).toBe("finished");
    expect(await readFile(join(f.cwd, "completed-cycles.txt"), "utf8")).toBe("2");
    expect((await f.commands()).filter(c => c.type === "get_state").length).toBeGreaterThanOrEqual(2);
  });
  test("rechecks completion when retry starts during get_state", async () => {
    const f = await fixture("retry-state");
    const result = await f.provider.start(f.input).done;
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("retry failed");
    expect((await f.commands()).filter(c => c.type === "get_state").length).toBeGreaterThan(2);
  });
  test("early injection waits for startup and lets Pi choose starting or steering", async () => {
    const f = await fixture(), handle = f.provider.start(f.input);
    await handle.inject("queued before streaming");
    expect((await handle.done).outcome).toBe("finished");
    expect((await f.commands()).find(c => c.message === "queued before streaming")).toMatchObject({ type: "prompt", streamingBehavior: "steer" });
    expect(await readFile(join(f.cwd, "completed-cycles.txt"), "utf8")).toBe("2");
  });
  test.each(["partial", "malformed", "error", "crash"])("handles %s output", async mode => {
    const f = await fixture(mode), result = await f.provider.start(f.input).done;
    expect(result.outcome).toBe(mode === "partial" ? "finished" : "failed");
    expect(result.error ?? "").not.toContain(f.input.token);
    if (mode === "error" || mode === "crash") expect(result.error).toContain("[redacted]");
  });
  test("deadline sends abort and returns timed_out; explicit abort waits for exit", async () => {
    const f = await fixture("hang");
    expect((await f.provider.start({ ...f.input, deadline: new Date(Date.now() + 200) }).done).outcome).toBe("timed_out");
    expect((await f.commands()).some(c => c.type === "abort")).toBe(true);
    const second = f.provider.start(f.input);
    await second.abort(); expect((await second.done).outcome).toBe("failed");
    await expect(second.inject("late")).rejects.toThrow();
  });
  test("unavailable executable and expired deadline", async () => {
    const f = await fixture();
    const provider = createPiProvider({ ...f.options, command: join(f.cwd, "missing") });
    expect((await provider.health()).available).toBe(false);
    expect((await provider.start(f.input).done).outcome).toBe("unavailable");
    expect((await provider.start({ ...f.input, deadline: new Date(0) }).done).outcome).toBe("timed_out");
    const noExtension = createPiProvider({ ...f.options, chronaExtension: join(f.cwd, "missing.ts") });
    expect((await noExtension.health()).error).toContain("extension missing");
  });
});

test("content areas are host links under content/ and stale links are replaced", async () => {
  const f = await fixture();
  const files = join(f.cwd, "content-files"), old = join(f.cwd, "content-old");
  await mkdir(files); await mkdir(old); await writeFile(join(files, "a.md"), "hi\n");
  prepareContent({ ...f.input, content: [{ name: "old", dir: old, writable: true }] });
  prepareContent({ ...f.input, content: [{ name: "files", dir: files, writable: false }] });
  expect(await readFile(join(f.input.cwd, "content", "files", "a.md"), "utf8")).toBe("hi\n");
  expect(existsSync(join(f.input.cwd, "content", "old"))).toBe(false);
});

describe("Pi Agent resume", () => {
  test.each(["missing", "wrong-id", "wrong-cwd", "malformed"])("%s disk context fails visibly before launch", async kind => {
    const f = await fixture();
    f.input.sessionId = "previous-id";
    if (kind !== "missing") {
      await mkdir(f.input.sessionDir, { recursive: true });
      await writeFile(join(f.input.sessionDir, "saved.jsonl"), kind === "malformed" ? "invalid\n" : JSON.stringify({ type: "session", id: kind === "wrong-id" ? "other-id" : f.input.sessionId, cwd: kind === "wrong-cwd" ? join(f.cwd, "other-project") : f.cwd }) + "\n");
    }
    const result = await f.provider.start(f.input).done;
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("Pi resume context");
    expect(existsSync(join(f.cwd, "launch.json"))).toBe(false);
    expect(existsSync(join(f.cwd, "commands.jsonl"))).toBe(false);
  });
  test.each(["normal", "missing-session-id"])("%s RPC session identity fails before prompting", async mode => {
    const f = await fixture(mode);
    f.input.sessionId = "previous-id";
    await mkdir(f.input.sessionDir, { recursive: true });
    await writeFile(join(f.input.sessionDir, "saved.jsonl"), JSON.stringify({ type: "session", id: f.input.sessionId, cwd: f.cwd }) + "\n");
    const result = await f.provider.start(f.input).done;
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("different session");
    expect(result.sessionId).toBe(f.input.sessionId);
    expect((await f.commands()).map(c => c.type)).toEqual(["get_state"]);
  });
  test("a fresh Agent Run persists context and a later Run resumes it before prompting", async () => {
    const f = await fixture("resume");
    const first = await f.provider.start({ ...f.input, sessionId: null, prompt: "Remember the first instruction." }).done;
    expect(first.outcome).toBe("finished");
    expect(first.sessionId).toBeString();
    const saved = await readFile(join(f.input.sessionDir, `fixture_${first.sessionId}.jsonl`), "utf8");
    const second = await f.provider.start({ ...f.input, sessionId: first.sessionId, prompt: "Continue using the saved instruction." }).done;
    expect(second).toEqual({ outcome: "finished", sessionId: first.sessionId, error: null });
    expect(await readFile(join(f.cwd, "loaded-context.txt"), "utf8")).toBe(saved);
    expect(saved).toContain("Remember the first instruction.");
    const launch = JSON.parse(await readFile(join(f.cwd, "launch.json"), "utf8"));
    expect(launch.args[launch.args.indexOf("--session-id") + 1]).toBe(first.sessionId);
    expect((await f.commands()).filter(c => c.type === "prompt").map(c => c.message)).toEqual(["Remember the first instruction.", "Continue using the saved instruction."]);
  });
});
