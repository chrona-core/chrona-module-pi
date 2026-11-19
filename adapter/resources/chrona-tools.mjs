// adapter/resources/chrona-tools.ts
import { randomUUID } from "node:crypto";

// ../Chrona/packages/app-sdk/transport.ts
import { createConnection, createServer } from "node:net";
var MAX_FRAME_BYTES = 32 * 1024 * 1024;
var MAX_AUTH_BYTES = 1024;
var AUTH_TIMEOUT_MS = 5000;
var TOKEN_PATTERN = /^[0-9a-f]{64}$/;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function portOf(endpoint, protocol) {
  const match = new RegExp(`^${protocol}://127\\.0\\.0\\.1:([1-9][0-9]{0,4})$`).exec(endpoint);
  if (!match || Number(match[1]) > 65535)
    throw new Error("Invalid loopback endpoint");
  return Number(match[1]);
}
function encode(value) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > MAX_FRAME_BYTES)
    throw new Error("Invalid or oversized channel message");
  return Buffer.from(json + `
`);
}
function readFrames(socket, limit, onValue, fail) {
  let parts = [], size = 0, stopped = false;
  socket.on("data", (chunk) => {
    let start = 0;
    while (start < chunk.length && !stopped && !socket.destroyed) {
      const end = chunk.indexOf(10, start), stop = end === -1 ? chunk.length : end;
      const bytes = stop - start;
      if (size + bytes > limit()) {
        stopped = true;
        parts = [];
        fail();
        return;
      }
      if (bytes) {
        parts.push(chunk.subarray(start, stop));
        size += bytes;
      }
      if (end === -1)
        return;
      const text = Buffer.concat(parts, size).toString("utf8");
      parts = [];
      size = 0;
      start = end + 1;
      try {
        onValue(JSON.parse(text));
      } catch {
        stopped = true;
        fail();
        return;
      }
    }
  });
}
function connectLoopbackChannel({ endpoint, token, onMessage, onDisconnect }) {
  const port = portOf(endpoint, "tcp");
  if (!TOKEN_PATTERN.test(token))
    throw new Error("Invalid channel token");
  const ready = deferred();
  const socket = createConnection({ host: "127.0.0.1", port });
  let authenticated = false, ended = false, pending = [], pendingBytes = 0, closing;
  const timer = setTimeout(() => fail(new Error("Module channel handshake timed out")), AUTH_TIMEOUT_MS);
  function fail(error) {
    if (ended)
      return;
    ended = true;
    clearTimeout(timer);
    pending = [];
    pendingBytes = 0;
    socket.destroy();
    ready.reject(error);
    onDisconnect?.(error);
  }
  socket.on("connect", () => {
    if (!ended)
      socket.write(encode({ type: "auth", version: 1, token }));
  });
  socket.on("error", () => fail(new Error("Module disconnected")));
  socket.on("close", () => fail(new Error("Module disconnected")));
  readFrames(socket, () => authenticated ? MAX_FRAME_BYTES : MAX_AUTH_BYTES, (value) => {
    if (!authenticated) {
      if (!record(value) || value.type !== "ready" || Object.keys(value).length !== 2 || value.version !== 1)
        throw new Error("Invalid ready ACK");
      authenticated = true;
      clearTimeout(timer);
      for (const frame of pending)
        socket.write(frame);
      pending = [];
      pendingBytes = 0;
      ready.resolve();
    } else {
      if (record(value) && (value.type === "auth" || value.type === "ready" || value.type === "http-ready"))
        throw new Error("Unexpected handshake");
      onMessage(value);
    }
  }, () => fail(new Error("Invalid channel message")));
  return {
    ready: ready.promise,
    send(value) {
      if (ended)
        throw new Error("Module disconnected");
      const frame = encode(value);
      if (authenticated)
        socket.write(frame);
      else {
        if (pendingBytes + frame.length > MAX_FRAME_BYTES + 1)
          throw new Error("Channel send queue exceeded");
        pending.push(frame);
        pendingBytes += frame.length;
      }
    },
    close() {
      if (!closing)
        closing = new Promise((resolve) => {
          if (socket.closed) {
            resolve();
            return;
          }
          socket.once("close", () => resolve());
          fail(new Error("Module channel closed"));
        });
      return closing;
    }
  };
}

// adapter/resources/chrona-tools.ts
async function chrona_tools_default(pi) {
  const endpoint = process.env.CHRONA_TOOL_CHANNEL, token = process.env.CHRONA_TOOL_CHANNEL_TOKEN;
  if (!endpoint || !token)
    return;
  const definitions = Promise.withResolvers();
  const pending = new Map;
  const connection = connectLoopbackChannel({
    endpoint,
    token,
    onDisconnect(error) {
      definitions.reject(error);
      for (const request of pending.values())
        request.reject(error);
    },
    onMessage(raw) {
      const message = raw;
      if (message.tools) {
        definitions.resolve(message.tools);
        return;
      }
      const request = message.id && pending.get(message.id);
      if (!request)
        return;
      if (message.error)
        request.reject(new Error(message.error.replaceAll(token, "[redacted]")));
      else
        request.resolve(message.output);
    }
  });
  try {
    await connection.ready;
  } catch (error) {
    definitions.reject(error);
  }
  for (const tool of await definitions.promise) {
    const properties = tool.parameters.properties;
    const hasTimeout = Object.hasOwn(properties ?? {}, "timeoutSeconds");
    pi.registerTool({
      ...tool,
      label: tool.name,
      parameters: hasTimeout ? tool.parameters : { ...tool.parameters, properties: {
        ...properties,
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, description: "Maximum wait in seconds (default 60)" }
      } },
      async execute(key, params, signal) {
        const args = { ...params ?? {} };
        const requested = args.timeoutSeconds;
        const timeoutSeconds = !hasTimeout && typeof requested === "number" && Number.isInteger(requested) && requested > 0 ? Math.min(requested, 600) : undefined;
        if (!hasTimeout)
          delete args.timeoutSeconds;
        const id = randomUUID(), request = Promise.withResolvers();
        const stop = AbortSignal.any([AbortSignal.timeout((timeoutSeconds ?? 60) * 1000 + 5000), ...signal ? [signal] : []]);
        const abort = () => request.reject(new Error("Tool wait ended. Check the original receipt before retrying an operation with effects."));
        stop.throwIfAborted();
        stop.addEventListener("abort", abort, { once: true });
        pending.set(id, request);
        try {
          connection.send({ id, request: { name: tool.name, args, key, ...timeoutSeconds !== undefined ? { timeoutSeconds } : {} } });
          const text = JSON.stringify(await request.promise ?? null).replaceAll(token, "[redacted]");
          return { content: [{ type: "text", text: text.length > 30000 ? `${text.slice(0, 30000)}
[Chrona tool result truncated from ${text.length} characters. Narrow the request or read the remaining content by reference.]` : text }], details: undefined };
        } finally {
          pending.delete(id);
          stop.removeEventListener("abort", abort);
        }
      }
    });
  }
}
export {
  chrona_tools_default as default
};
