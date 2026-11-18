import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_MODEL_ENVIRONMENT_KEYS, type PiProviderOptions } from "@chrona/pi";
import { THINKING_LEVELS } from "@chrona/contracts/steward";
import { z } from "zod";

const hostConfigurationSchema = z.object({
  command: z.string().optional(), agentDir: z.string().optional(), expectedVersion: z.string().optional(),
  model: z.string().optional(), thinking: z.enum(THINKING_LEVELS).optional(), resourcesFile: z.string().optional(),
  executionMode: z.enum(["trusted-local", "required-isolation"]).optional(),
  chronaExtension: z.string().optional(), webExtension: z.string().nullable().optional(), browserExtension: z.string().nullable().optional(),
  agentUrl: z.string().url().optional(), workspaceRoot: z.string().optional(), processHelper: z.string().optional(),
  idleTimeoutMs: z.number().int().positive().optional(), nativeTimeoutMs: z.number().int().positive().optional(),
  environment: z.record(z.string(), z.string()).optional(),
}).strict();

export async function readPiHostConfiguration(dataDir: string): Promise<PiProviderOptions> {
  const path = resolve(dataDir, "pi-host.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Pi configuration could not be read: ${path}`, { cause: error });
    console.error(JSON.stringify({ component: "pi", event: "host_configuration_absent", error: "pi-host.json is absent; Pi executable remains unconfigured" }));
    raw = {};
  }
  const { environment, ...options } = hostConfigurationSchema.parse(raw);
  const agentUrl = options.agentUrl ?? (process.env.CHRONA_KERNEL_URL ? new URL("/api/steward-agent", process.env.CHRONA_KERNEL_URL).href : "");
  for (const key of PI_MODEL_ENVIRONMENT_KEYS) {
    const value = environment?.[key];
    if (value !== undefined) process.env[key] = value;
  }
  return {
    chronaExtension: fileURLToPath(new URL("./adapter/resources/chrona-tools.ts", import.meta.url)),
    browserExtension: fileURLToPath(new URL("./adapter/resources/browser-tools.ts", import.meta.url)),
    workspaceRoot: resolve(dataDir, "workspaces"),
    processHelper: process.env.CHRONA_PROCESS_HELPER,
    executionMode: "trusted-local",
    command: "",
    ...options,
    agentUrl,
  };
}
