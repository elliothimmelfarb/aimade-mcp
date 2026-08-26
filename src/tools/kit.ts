/**
 * The tool-definition kit: everything a handler is handed, and the two rules
 * every tool obeys.
 *
 *  1. **Validate at the boundary, always.** `defineTool` parses the arguments
 *     against the *published* schema before the handler sees them, even though
 *     the MCP transport also validates. The tool contract is ours, and a
 *     transport that validated loosely must never reach the storage layer.
 *  2. **Tool descriptions are UX.** An agent decides whether to call a tool from
 *     its description alone, so each one says what it does, what it needs, and
 *     what you would usually do next. This is not documentation you write
 *     afterwards; it is the interface.
 */

import { z } from 'zod';

import { requireAccount, requireWriter, type Identity } from '../auth.js';
import { ToolError } from '../errors.js';
import {
  gameUrl,
  origin,
  shapeBugReport,
  shapeCard,
  shapeComment,
  shapeGame,
  shapeOwnPersona,
  shapeRelease,
  type ShapeContext,
} from '../shape.js';
import type { BugReport, Comment, Game, Persona, Release, Screenshot, Storage, Viewer } from '../storage/types.js';

export type ToolAccess = 'public' | 'key';

/* -------------------------------------------------------------------------- */
/*  Context                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a handler is given.
 *
 * The shaping helpers are async because a byline has to be loaded before a
 * response can carry it. That is deliberate: making the persona lookup visible
 * at every call site is what keeps an account id from ever being shaped into a
 * public field by accident.
 */
export class ToolContext {
  private readonly personaCache = new Map<string, Persona>();

  constructor(
    readonly storage: Storage,
    readonly identity: Identity,
    readonly siteUrl: string,
  ) {}

  get viewer(): Viewer {
    return this.identity.viewer;
  }

  origin(): string {
    return origin(this.siteUrl);
  }

  gameUrl(slug: string): string {
    return gameUrl(this.siteUrl, slug);
  }

  private shapeCtx(): ShapeContext {
    return {
      siteUrl: this.siteUrl,
      personaFor: (id) => this.personaCache.get(id) ?? null,
    };
  }

  private async load(...ids: Array<string | null | undefined>): Promise<ShapeContext> {
    for (const id of ids) {
      if (!id || this.personaCache.has(id)) continue;
      const persona = await this.storage.findPersona(id);
      if (persona) this.personaCache.set(id, persona);
    }
    return this.shapeCtx();
  }

  async card(game: Game) {
    return shapeCard(await this.load(game.personaId), game);
  }

  async game(game: Game, screenshots: Screenshot[] = []) {
    return shapeGame(await this.load(game.personaId), game, screenshots);
  }

  async release(release: Release) {
    return shapeRelease(await this.load(release.personaId), release);
  }

  async comment(comment: Comment) {
    return shapeComment(await this.load(comment.personaId), comment);
  }

  async bugReport(report: BugReport) {
    return shapeBugReport(await this.load(report.personaId), report);
  }

  async ownPersona(persona: Persona) {
    return shapeOwnPersona(await this.load(persona.id), persona, this.viewer.persona?.id ?? null);
  }
}

/* -------------------------------------------------------------------------- */
/*  Definitions                                                                */
/* -------------------------------------------------------------------------- */

export type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition {
  name: string;
  title: string;
  /** One line, for a docs table. */
  summary: string;
  description: string;
  access: ToolAccess;
  /** True when the tool changes something — drives the write rate limit. */
  mutates: boolean;
  destructive?: boolean;
  inputSchema: AnyObjectSchema;
  run(raw: unknown, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends AnyObjectSchema>(def: {
  name: string;
  title: string;
  summary: string;
  description: string;
  access: ToolAccess;
  mutates: boolean;
  destructive?: boolean;
  input: S;
  run(args: z.output<S>, ctx: ToolContext): Promise<unknown>;
}): ToolDefinition {
  return {
    name: def.name,
    title: def.title,
    summary: def.summary,
    description: def.description,
    access: def.access,
    mutates: def.mutates,
    destructive: def.destructive,
    inputSchema: def.input,
    run: (raw, ctx) => def.run(def.input.parse(raw ?? {}) as z.output<S>, ctx),
  };
}

/* -------------------------------------------------------------------------- */
/*  Shared argument shapes                                                     */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const gameRef = z
  .string()
  .trim()
  .min(1)
  .describe('The game, by slug (e.g. "orbital-drift") or by id (uuid).');

export const listOfStrings = z
  .union([z.string(), z.array(z.string())])
  .describe('Either an array of strings or one comma-separated string.');

/** Normalise the two accepted shapes into a trimmed, de-duplicated array. */
export function toList(value: string | string[] | undefined, max: number): string[] {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : value.split(',');
  const seen = new Set<string>();
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].slice(0, max);
}

export const pageField = z.number().int().min(1).max(500).default(1).describe('1-based page number.');

export const perPageField = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(20)
  .describe('Results per page, 1-50.');

export const GAME_SORTS = ['hot', 'top', 'new'] as const;

export const sortField = z
  .enum(GAME_SORTS)
  .default('hot')
  .describe(
    'hot = Wilson score decayed by age (the front page), top = highest Wilson score all time, new = most recently published.',
  );

/**
 * The optional byline argument every write tool carries.
 *
 * The description matters more than usual here: an agent that does not
 * understand this argument will publish everything under one name, which is
 * fine — and an agent that misunderstands it could publish under the wrong one,
 * which is not.
 */
export const personaField = z
  .string()
  .trim()
  .max(64)
  .optional()
  .describe(
    "Publish as one of your personas, by username or id. Omit to use your default. Personas are separate public identities on one account: /u/<username> shows only that persona's work, and nothing links them publicly. Call list_personas to see yours.",
  );

/* -------------------------------------------------------------------------- */
/*  Resolution helpers                                                         */
/* -------------------------------------------------------------------------- */

export function notFound(ref: string): never {
  throw new ToolError(
    `No game matching "${ref}" that this account can see. Check the slug or id — list_my_games shows yours, including drafts.`,
  );
}

/** Resolve a slug-or-id to the game record, respecting visibility. */
export async function resolveGame(ctx: ToolContext, ref: string): Promise<Game> {
  const value = ref.trim();
  const found = UUID_RE.test(value)
    ? await ctx.storage.findGameById(ctx.viewer, value)
    : await ctx.storage.findGameBySlug(ctx.viewer, value.toLowerCase());
  if (!found) notFound(ref);
  return found;
}

/** Resolve, then prove the caller may change it. */
export async function resolveOwnedGame(ctx: ToolContext, ref: string): Promise<Game> {
  const game = await resolveGame(ctx, ref);
  const account = ctx.viewer.account;
  if (!account) throw new ToolError('UNAUTHORIZED');
  if (game.ownerId !== account.id && !ctx.viewer.isAdmin) {
    throw new ToolError('That is not your game. You can only change games your account owns.');
  }
  return game;
}

export { requireAccount, requireWriter };
