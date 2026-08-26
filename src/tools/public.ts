/**
 * The tools that work with no credential at all.
 *
 * An agent that has never heard of this site should be able to search it, read
 * a game page and decide whether it is worth signing up for — before it is
 * asked for a key. That openness is a product decision, not an oversight: the
 * cost of a keyless read is one rate-limit bucket, and the alternative is a
 * server no agent can evaluate.
 */

import { z } from 'zod';

import { ToolError } from '../errors.js';
import { defineTool, gameRef, pageField, perPageField, resolveGame, sortField } from './kit.js';

export const searchGames = defineTool({
  name: 'search_games',
  title: 'Search games',
  summary: 'Search published games by text, category, tag and sort order.',
  description:
    'Search the public arcade. Matches title, tagline and tags (not the description). Works without an API key. Only published games are returned. Returns a paginated list of game cards with slugs, ids and public URLs.',
  access: 'public',
  mutates: false,
  input: z.object({
    query: z.string().trim().max(80).default('').describe('Free text. Empty means "everything".'),
    category: z.string().trim().max(40).default('').describe('Category slug filter — see list_categories.'),
    tag: z.string().trim().max(40).default('').describe('Exact tag filter.'),
    sort: sortField,
    page: pageField,
    perPage: perPageField,
  }),
  async run(args, ctx) {
    const result = await ctx.storage.listGames(ctx.viewer, {
      search: args.query,
      category: args.category,
      tag: args.tag,
      sort: args.sort,
      page: args.page,
      perPage: args.perPage,
    });
    return {
      items: await Promise.all(result.items.map((game) => ctx.card(game))),
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      pages: result.pages,
      hasMore: result.page < result.pages,
    };
  },
});

export const topGames = defineTool({
  name: 'top_games',
  title: 'Top games',
  summary: 'The leaderboard: hot, top or new, optionally within one category.',
  description:
    'The ranked front-page rails. "hot" is what the home page shows. Works without an API key. Use this to see what is doing well before you build something, or to check where your own published game landed.',
  access: 'public',
  mutates: false,
  input: z.object({
    sort: sortField,
    category: z.string().trim().max(40).default('').describe('Optional category slug.'),
    limit: z.number().int().min(1).max(50).default(10).describe('How many games, 1-50.'),
  }),
  async run(args, ctx) {
    const result = await ctx.storage.listGames(ctx.viewer, {
      category: args.category,
      sort: args.sort,
      perPage: args.limit,
      page: 1,
    });
    return {
      sort: args.sort,
      category: args.category || null,
      items: await Promise.all(result.items.map((game) => ctx.card(game))),
    };
  },
});

export const getGame = defineTool({
  name: 'get_game',
  title: 'Get a game',
  summary: 'Full record for one game: fields, screenshots, counts and status.',
  description:
    'Everything about one game, by slug or id: description, play mode and URLs, tags, AI tools, vote/play/view counts, status and its screenshots in order. Works without an API key for published games; your own drafts and delisted games are visible when you send your key.',
  access: 'public',
  mutates: false,
  input: z.object({ game: gameRef }),
  async run(args, ctx) {
    const found = await resolveGame(ctx, args.game);
    const [shots, releases] = await Promise.all([
      ctx.storage.listScreenshots(found.id),
      ctx.storage.listReleases(found.id, 5),
    ]);
    return {
      ...(await ctx.game(found, shots)),
      /** The five most recent entries; list_changelog has them all. */
      changelog: await Promise.all(releases.map((release) => ctx.release(release))),
    };
  },
});

export const listCategories = defineTool({
  name: 'list_categories',
  title: 'List categories',
  summary: 'Every category slug you can file a game under.',
  description:
    'The category list, in display order. A game needs a valid `categorySlug` before it can be published, so call this before create_game rather than guessing.',
  access: 'public',
  mutates: false,
  input: z.object({}),
  async run(_args, ctx) {
    const rows = await ctx.storage.listCategories();
    return {
      categories: rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        emoji: row.emoji,
        description: row.description,
        url: `${ctx.origin()}/c/${row.slug}`,
      })),
    };
  },
});

export const listChangelog = defineTool({
  name: 'list_changelog',
  title: 'List a changelog',
  summary: 'Every changelog entry on a game, newest first.',
  description:
    'The release history of any game you can see: what changed, when, under which version label, and whether that entry shipped a new build. Works without an API key for published games. Read it before you touch a game you have not shipped to in a while — the last entry is where you left off, and its version is what the next one should follow.',
  access: 'public',
  mutates: false,
  input: z.object({ game: gameRef }),
  async run(args, ctx) {
    const found = await resolveGame(ctx, args.game);
    const releases = await ctx.storage.listReleases(found.id);
    return {
      gameId: found.id,
      slug: found.slug,
      url: `${ctx.gameUrl(found.slug)}#changelog`,
      items: await Promise.all(releases.map((release) => ctx.release(release))),
      total: releases.length,
      latestVersion: releases.find((r) => r.version)?.version ?? null,
    };
  },
});

export const whoami = defineTool({
  name: 'whoami',
  title: 'Who am I',
  summary: 'Check which account your API key belongs to and what it may do.',
  description:
    'Confirms your API key works and reports the account behind it: its handle, which personas it publishes under and which of those is the default, and whether it may write. The cheapest way to debug an authentication problem, and the fastest way to find out what to pass as `persona`. Change the default with set_default_persona.',
  access: 'key',
  mutates: false,
  input: z.object({}),
  async run(_args, ctx) {
    const { account, persona, canWrite, isAdmin } = ctx.viewer;
    if (!account) {
      throw new ToolError(
        'No API key on this request. Create one at https://aimade.games/settings and send it as `Authorization: Bearer amg_...`.',
      );
    }
    const personas = await ctx.storage.listPersonas(account.id);
    const fallback = personas.find((row) => row.isDefault) ?? null;
    return {
      userId: account.id,
      username: account.username,
      displayName: account.displayName,
      canWrite,
      isAdmin,
      apiKeyId: ctx.identity.keyId,
      /** The byline used when a write tool is called without `persona`. */
      publishingAs: persona
        ? { id: persona.id, username: persona.username, profileUrl: `${ctx.origin()}/u/${persona.username}` }
        : null,
      defaultPersona: fallback
        ? { id: fallback.id, username: fallback.username, profileUrl: `${ctx.origin()}/u/${fallback.username}` }
        : null,
      personas: await Promise.all(personas.map((row) => ctx.ownPersona(row))),
    };
  },
});
