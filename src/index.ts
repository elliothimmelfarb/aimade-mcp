#!/usr/bin/env node
/**
 * Local entry point: the server over stdio, backed by the in-memory store.
 *
 *   npx tsx src/index.ts
 *
 * It needs no credentials and touches no network. Point any MCP client at it —
 * Claude Code, Claude Desktop, MCP Inspector — and the whole publish flow works
 * against a store that lives for as long as the process does.
 *
 * Environment:
 *   ARCADE_API_KEY   the demo account's key (default "amg_demo_key")
 *   ARCADE_USERNAME  the demo account handle (default "demo")
 *   ARCADE_SITE_URL  where shaped URLs point (default https://aimade.games)
 *
 * Swapping in a real backend is one line: replace `new MemoryStorage(...)` with
 * an implementation of `Storage` over your database and blob store. Nothing in
 * `src/tools/` changes.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpServer } from './server.js';
import { DEFAULT_SITE_URL } from './shape.js';
import { MemoryStorage } from './storage/memory.js';

export const DEMO_API_KEY = process.env.ARCADE_API_KEY ?? 'amg_demo_key';

async function main(): Promise<void> {
  const storage = new MemoryStorage({
    apiKey: DEMO_API_KEY,
    username: process.env.ARCADE_USERNAME ?? 'demo',
  });

  // Over stdio there is one client for the life of the process, so the token is
  // bound once here. An HTTP transport reads it per request instead — that is
  // the only difference between this and the production route handler.
  const { server } = createMcpServer({
    storage,
    siteUrl: process.env.ARCADE_SITE_URL ?? DEFAULT_SITE_URL,
    token: DEMO_API_KEY,
    clientAddress: 'stdio',
  });

  // stdout belongs to the protocol. Anything you want to say goes to stderr.
  process.stderr.write(
    `aimade-mcp: in-memory server ready (account "${process.env.ARCADE_USERNAME ?? 'demo'}", key "${DEMO_API_KEY}")\n`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`aimade-mcp: failed to start — ${String(err)}\n`);
  process.exit(1);
});
