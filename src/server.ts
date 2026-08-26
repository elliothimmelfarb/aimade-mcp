/**
 * The server: dispatch, auth, rate limiting, and error translation.
 *
 * `callTool` is the whole request pipeline in one function, and it is
 * deliberately transport-agnostic — the MCP registration below and the tests
 * both go through it. Read it top to bottom and you have the pattern:
 *
 *   resolve identity → refuse if the tool needs a key → rate-limit →
 *   validate + run → shape the answer → translate any error
 *
 * The production instance of this is a Next.js route handler on
 * `mcp-handler` (streamable HTTP) at https://aimade.games/api/mcp. The only
 * thing that changes is what supplies the bearer token and how the result is
 * written back; everything below stays identical.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  ANONYMOUS_IDENTITY,
  ApiKeyError,
  identityFromToken,
  type Identity,
} from './auth.js';
import { messageForToolError } from './errors.js';
import { createLimiter, rateLimitMessage, type Limiter, type RateKind } from './rate-limit.js';
import { DEFAULT_SITE_URL } from './shape.js';
import type { Storage } from './storage/types.js';
import { TOOLS, ToolContext, type ToolDefinition } from './tools/index.js';

export const SERVER_NAME = 'aimade.games';
export const SERVER_VERSION = '1.0.0';

/**
 * The server instructions.
 *
 * This is the highest-leverage prose in the whole repository: it is the first
 * thing an agent reads, and it is what turns ~40 tools into one obvious path.
 * Name the happy path explicitly, in order, and say what a write needs.
 */
export const INSTRUCTIONS = `aimade.games is an arcade for games made with AI. You can browse it without a key.

To publish: create_game (lands as a draft) -> upload_game_build -> define_achievements -> add_screenshot -> set_cover -> publish_game.
Publishing requires a tagline, a categorySlug from list_categories, and a play URL.
Games are addressed by slug or id; list_my_games shows yours including drafts.
Writes need an API key from https://aimade.games/settings, sent as "Authorization: Bearer amg_...".

Games you build here get the Arcade SDK: one script tag (https://aimade.games/arcade.js) gives
identity, save states, leaderboards, achievements and async multiplayer, with no build step.
Read https://aimade.games/docs/arcade before you write the game. Achievements are maker data:
you declare the slugs with define_achievements, the build only calls Arcade.achievements.unlock()
against slugs that already exist.`;

/* -------------------------------------------------------------------------- */
/*  Results                                                                    */
/* -------------------------------------------------------------------------- */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Tool answers are JSON in a text block — the shape every MCP client renders. */
export function textResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Parse a tool result back into the object the handler returned. */
export function parseToolResult<T = unknown>(result: ToolResult): T {
  return JSON.parse(result.content[0]?.text ?? 'null') as T;
}

/* -------------------------------------------------------------------------- */
/*  The pipeline                                                               */
/* -------------------------------------------------------------------------- */

export interface ServerOptions {
  storage: Storage;
  /** Where public URLs point. The live instance is https://aimade.games. */
  siteUrl?: string;
  limiter?: Limiter;
  tools?: ToolDefinition[];
}

export interface CallOptions {
  /** The raw bearer token, if the caller sent one. */
  token?: string | null;
  /** The bucket keyless callers are counted against — an IP in production. */
  clientAddress?: string;
}

export class ArcadeMcpServer {
  readonly storage: Storage;
  readonly siteUrl: string;
  readonly limiter: Limiter;
  readonly tools: ToolDefinition[];

  constructor(options: ServerOptions) {
    this.storage = options.storage;
    this.siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
    this.limiter = options.limiter ?? createLimiter();
    this.tools = options.tools ?? TOOLS;
  }

  /**
   * Resolve who is calling.
   *
   * A bad key is surfaced as a refusal with a sentence, never as a silent
   * demotion to anonymous: someone who typed their key wrong deserves to be
   * told once, rather than getting "log in first" on every write forever.
   */
  private async identify(token: string | null | undefined): Promise<Identity> {
    if (!token?.trim()) return ANONYMOUS_IDENTITY;
    return identityFromToken(this.storage, token);
  }

  async callTool(name: string, args: unknown, options: CallOptions = {}): Promise<ToolResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      return textResult({ error: 'unknown_tool', message: `There is no tool called "${name}".` }, true);
    }

    let identity: Identity;
    try {
      identity = await this.identify(options.token);
    } catch (err) {
      return textResult(
        {
          error: 'invalid_token',
          message: err instanceof ApiKeyError ? err.message : 'That API key could not be verified.',
        },
        true,
      );
    }

    if (tool.access === 'key' && !identity.viewer.account) {
      return textResult(
        {
          error: 'authentication_required',
          message:
            'This tool needs an API key. Create one at https://aimade.games/settings and send it as `Authorization: Bearer amg_...`. The public tools (search_games, top_games, get_game, list_categories, list_changelog) work without one.',
        },
        true,
      );
    }

    // Writes are counted separately from reads, and keyless callers are counted
    // per client rather than per key — otherwise one anonymous loop would spend
    // everybody's budget.
    const kind: RateKind = identity.keyId ? (tool.mutates ? 'write' : 'read') : 'anonymous';
    const bucket = identity.keyId ?? options.clientAddress ?? 'unknown';
    const decision = this.limiter.check(kind, bucket);
    if (!decision.allowed) {
      return textResult({ error: 'rate_limited', message: rateLimitMessage(kind, decision) }, true);
    }

    try {
      const ctx = new ToolContext(this.storage, identity, this.siteUrl);
      return textResult(await tool.run(args, ctx));
    } catch (err) {
      // Never leak an internal stack or a driver message to a caller.
      return textResult({ error: 'tool_error', tool: tool.name, message: messageForToolError(err) }, true);
    }
  }

  /** Register every tool on an MCP server instance. */
  register(server: McpServer, options: CallOptions = {}): McpServer {
    for (const tool of this.tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema.shape,
          annotations: {
            title: tool.title,
            readOnlyHint: !tool.mutates,
            destructiveHint: tool.destructive === true,
            idempotentHint: !tool.mutates,
            openWorldHint: false,
          },
        },
        async (args: unknown) => this.callTool(tool.name, args, options),
      );
    }
    return server;
  }
}

/** Build a ready-to-connect MCP server over a storage backend. */
export function createMcpServer(options: ServerOptions & CallOptions): {
  server: McpServer;
  arcade: ArcadeMcpServer;
} {
  const arcade = new ArcadeMcpServer(options);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  arcade.register(server, { token: options.token, clientAddress: options.clientAddress });
  return { server, arcade };
}
