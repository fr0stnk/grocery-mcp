import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const STDERR_TAIL = 2000;

/**
 * One store adapter, run as a child MCP server over stdio. The child is
 * started on first use and restarted on the next call after it exits.
 */
export class StoreClient {
  constructor({ id, label, toolPrefix, search, annotations, command, args, cwd, env, connectTimeoutMs = 30_000 }) {
    Object.assign(this, { id, label, toolPrefix, search, annotations, command, args, cwd, env, connectTimeoutMs });
    this.client = null;
    this.connecting = null;
    this.stderrTail = '';
    this.tools = null;
    this.instructions = null;
  }

  async connect() {
    if (this.client) return this.client;
    this.connecting ??= this.#start().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #start() {
    this.stderrTail = '';
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
      for (const line of text.split('\n')) if (line.trim()) process.stderr.write(`[${this.id}] ${line}\n`);
    });

    const client = new Client({ name: 'grocery-mcp', version: '0.1.0' });
    client.onclose = () => {
      if (this.client === client) this.client = null;
    };
    try {
      await withTimeout(client.connect(transport), this.connectTimeoutMs, `${this.label} did not start within ${this.connectTimeoutMs / 1000}s`);
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(`${this.label} failed to start: ${this.#reason(error)}`);
    }
    this.client = client;
    this.instructions = client.getInstructions() ?? null;
    return client;
  }

  /** The child's last stderr line usually says why it exited, e.g. a missing env var. */
  #reason(error) {
    const lastLine = this.stderrTail
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l))
      .pop();
    return lastLine ?? (error instanceof Error ? error.message : String(error));
  }

  async listTools() {
    const client = await this.connect();
    const { tools } = await client.listTools();
    this.tools = tools;
    return tools;
  }

  async callTool(name, args, timeoutMs = 60_000) {
    const client = await this.connect();
    try {
      return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (error) {
      if (!this.client) throw new Error(`${this.label} stopped: ${this.#reason(error)}`);
      throw error;
    }
  }

  exposedName(name) {
    return name.startsWith(this.toolPrefix) ? name : this.toolPrefix + name;
  }

  async close() {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }
}

export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
