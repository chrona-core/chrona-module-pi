import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiHostConfiguration } from "./host";

test("Pi startup uses its private configuration and local extension resources", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-host-"));
  try {
    await writeFile(join(data, "pi-host.json"), JSON.stringify({ agentUrl: "http://127.0.0.1:3000/api/steward-agent", command: "/configured/pi", environment: { CHRONA_UNSAFE_CARRIER: "ignored" } }));
    const options = await readPiHostConfiguration(data);
    expect(options).toMatchObject({ command: "/configured/pi", agentUrl: "http://127.0.0.1:3000/api/steward-agent", executionMode: "trusted-local" });
    expect(options.chronaExtension).toEndWith("adapter/resources/chrona-tools.ts");
    expect(options.browserExtension).toEndWith("adapter/resources/browser-tools.ts");
    expect(process.env.CHRONA_UNSAFE_CARRIER).not.toBe("ignored");
    await writeFile(join(data, "pi-host.json"), JSON.stringify({ command: "/configured/pi" }));
    const previous = process.env.CHRONA_KERNEL_URL;
    try {
      process.env.CHRONA_KERNEL_URL = "http://127.0.0.1:9876";
      expect((await readPiHostConfiguration(data)).agentUrl).toBe("http://127.0.0.1:9876/api/steward-agent");
    } finally { if (previous === undefined) delete process.env.CHRONA_KERNEL_URL; else process.env.CHRONA_KERNEL_URL = previous; }
  } finally { await rm(data, { recursive: true, force: true }); }
});
