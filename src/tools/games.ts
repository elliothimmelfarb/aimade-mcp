/**
 * Owning a game: create, patch, publish, retire.
 *
 * The shape of this group is the whole publish flow:
 *
 *   create_game → upload_game_build → define_achievements
 *              → add_screenshot → set_cover → publish_game
 *
 * `create_game` always lands a draft. Publishing is a separate, deliberate act,
 * which is what gives an agent room to assemble a complete listing before
 * anything is public — and what lets `publish_game` validate the whole record
 * once, at the only moment it matters.
 */

import { z } from 'zod';

import { ToolError } from '../errors.js';
import { checkPublishable } from '../publishable.js';
import type { GameUpdateInput } from '../storage/types.js';
import { viewerPublishingAs } from '../auth.js';
import {
  defineTool,
  gameRef,
  listOfStrings,
  personaField,
  requireWriter,
  resolveOwnedGame,
  toList,
} from './kit.js';

const PLAY_MODES = ['external', 'embed', 'hosted'] as const;

/** Draft fields shared by create_game and update_game. */
const draftFields = {
  title: z.string().trim().min(2).max(100).describe("The game's name."),
  tagline: z.string().trim().max(140).describe('One line hook, max 140 chars. Required before publishing.'),
  description: z
    .string()
    .trim()
    .max(20_000)
    .describe('Markdown body: what the game is, how to play, what you built it with.'),
  categorySlug: z
    .string()
    .trim()
    .max(40)
    .describe('Category slug from list_categories. Required before publishing.'),
  tags: listOfStrings.describe('Up to 8 free-form tags.'),
  aiTools: listOfStrings.describe(
    'The AI tools you built it with, e.g. ["Claude Code", "Cursor"]. Up to 6. These are shown as badges of pride, not a disclaimer.',
  ),
  playMode: z
    .enum(PLAY_MODES)
    .describe(
      'external = Play links out to playUrl · embed = the game runs in a sandboxed iframe of embedUrl · hosted = a single HTML file we host (send it with upload_game_build, which sets this mode for you).',
    ),
  playUrl: z
    .string()
    .trim()
    .max(2048)
    .describe('https:// URL the Play button opens (playMode "external"). Send "" to clear.'),
  embedUrl: z
    .string()
    .trim()
    .max(2048)
    .describe('https:// URL to put in the iframe (playMode "embed"). Send "" to clear.'),
  coverUrl: z
    .string()
    .trim()
    .max(2048)
    .describe('https:// URL of the cover image. Prefer set_cover, which can upload one.'),
} as const;

export const listMyGames = defineTool({
  name: 'list_my_games',
  title: 'List my games',
  summary: 'Every game on your account, drafts and delisted ones included.',
  description:
    'Your whole catalogue, newest first, including drafts and delisted entries that never appear in search. Use it to find the id or slug you need for the other tools.',
  access: 'key',
  mutates: false,
  input: z.object({
    limit: z.number().int().min(1).max(100).default(50).describe('How many games, 1-100.'),
    includeUnpublished: z.boolean().default(true).describe('Set false to see only what the public can see.'),
  }),
  async run(args, ctx) {
    const account = ctx.viewer.account;
    if (!account) throw new ToolError('UNAUTHORIZED');
    const items = await ctx.storage.listByOwner(ctx.viewer, account.id, {
      includeUnpublished: args.includeUnpublished,
      limit: args.limit,
    });
    return { items: await Promise.all(items.map((game) => ctx.card(game))), total: items.length };
  },
});

export const createGame = defineTool({
  name: 'create_game',
  title: 'Create a game',
  summary: 'Create a game as a draft. Nothing is public until you publish it.',
  description:
    'Creates a game on your account. It always lands as a draft — publishing is a separate, deliberate act, which gives you room to add screenshots and a cover first. Only `title` is required to start. The slug is minted from the title and never changes afterwards, because links outlive titles. Typical flow: create_game → upload_game_build → define_achievements → add_screenshot → set_cover → publish_game.',
  access: 'key',
  mutates: true,
  input: z.object({
    title: draftFields.title,
    tagline: draftFields.tagline.default(''),
    description: draftFields.description.default(''),
    categorySlug: draftFields.categorySlug.default(''),
    tags: draftFields.tags.optional(),
    aiTools: draftFields.aiTools.optional(),
    playMode: draftFields.playMode.default('external'),
    playUrl: draftFields.playUrl.default(''),
    embedUrl: draftFields.embedUrl.default(''),
    coverUrl: draftFields.coverUrl.default(''),
    persona: personaField,
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const viewer = await viewerPublishingAs(ctx.storage, ctx.identity, args.persona);
    const game = await ctx.storage.createGame(viewer, {
      title: args.title,
      tagline: args.tagline,
      description: args.description,
      categorySlug: args.categorySlug,
      tags: toList(args.tags, 8),
      aiTools: toList(args.aiTools, 6),
      playMode: args.playMode,
      playUrl: args.playUrl,
      embedUrl: args.embedUrl,
      coverUrl: args.coverUrl,
    });
    return {
      game: await ctx.game(game),
      nextSteps:
        'Send the build with upload_game_build, declare its badges with define_achievements, add up to 6 screenshots with add_screenshot, pick one as the cover with set_cover, then call publish_game. Publishing needs a tagline, a categorySlug and a working play URL.',
    };
  },
});

export const updateGame = defineTool({
  name: 'update_game',
  title: 'Update a game',
  summary: 'Patch any field of a game you own. Omitted fields keep their value.',
  description:
    'A genuine partial update: send only what changes and everything else is preserved exactly. Send an empty string to clear an optional URL. The slug never changes, and updating a published game does not take it offline.',
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    title: draftFields.title.optional(),
    tagline: draftFields.tagline.optional(),
    description: draftFields.description.optional(),
    categorySlug: draftFields.categorySlug.optional(),
    tags: draftFields.tags.optional(),
    aiTools: draftFields.aiTools.optional(),
    playMode: draftFields.playMode.optional(),
    playUrl: draftFields.playUrl.optional(),
    embedUrl: draftFields.embedUrl.optional(),
    coverUrl: draftFields.coverUrl.optional(),
    persona: z
      .string()
      .trim()
      .max(64)
      .optional()
      .describe(
        'Move this game to another of your personas, by username or id. Omit to leave its byline alone. This changes who the public sees as the maker — including on votes and comments already left on it — so do not do it casually.',
      ),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);

    const patch: GameUpdateInput = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.tagline !== undefined) patch.tagline = args.tagline;
    if (args.description !== undefined) patch.description = args.description;
    if (args.categorySlug !== undefined) patch.categorySlug = args.categorySlug;
    if (args.tags !== undefined) patch.tags = toList(args.tags, 8);
    if (args.aiTools !== undefined) patch.aiTools = toList(args.aiTools, 6);
    if (args.playMode !== undefined) patch.playMode = args.playMode;
    if (args.playUrl !== undefined) patch.playUrl = args.playUrl;
    if (args.embedUrl !== undefined) patch.embedUrl = args.embedUrl;
    if (args.coverUrl !== undefined) patch.coverUrl = args.coverUrl;
    if (args.persona !== undefined) {
      const viewer = await viewerPublishingAs(ctx.storage, ctx.identity, args.persona);
      if (viewer.persona) patch.personaId = viewer.persona.id;
    }

    const updated = await ctx.storage.updateGame(game.id, patch);
    const shots = await ctx.storage.listScreenshots(game.id);
    return { game: await ctx.game(updated, shots) };
  },
});

export const publishGame = defineTool({
  name: 'publish_game',
  title: 'Publish a game',
  summary: 'Make a draft public. Validates it is complete first.',
  description:
    'Publishes a game to the arcade. The stored record is re-validated first, so this fails loudly if the game is missing a tagline, a category or a working play URL — fix those with update_game and call again. Re-publishing a delisted game keeps its original publish date so it does not fake its way back to the top of "new".',
  access: 'key',
  mutates: true,
  input: z.object({ game: gameRef }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);

    const check = await checkPublishable(ctx.storage, game);
    if (!check.ok) throw new ToolError(check.message);

    // The first publish stamps the date; a re-publish keeps the original.
    const published = await ctx.storage.setGameStatus(
      game.id,
      'published',
      game.publishedAt ?? new Date(),
    );
    return {
      game: await ctx.game(published),
      url: ctx.gameUrl(published.slug),
      publishedAt: published.publishedAt?.toISOString() ?? null,
    };
  },
});

export const unpublishGame = defineTool({
  name: 'unpublish_game',
  title: 'Unpublish a game',
  summary: 'Send a published game back to a private draft.',
  description:
    'Takes a live game offline and back to draft. Nobody but you (and admins) can see it afterwards. Reversible with publish_game; votes and comments are untouched.',
  access: 'key',
  mutates: true,
  input: z.object({ game: gameRef }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    return { game: await ctx.game(await ctx.storage.setGameStatus(game.id, 'draft')) };
  },
});

export const delistGame = defineTool({
  name: 'delist_game',
  title: 'Delist a game',
  summary: 'Retire a published game: 404 to the public, still yours to read.',
  description:
    'Retires a game from the public site. Its page 404s for everyone else, it leaves search and the sitemap, and you keep the record along with its votes and comments. Use this rather than delete_game for anything that has been live.',
  access: 'key',
  mutates: true,
  destructive: true,
  input: z.object({ game: gameRef }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    return { game: await ctx.game(await ctx.storage.setGameStatus(game.id, 'delisted')) };
  },
});

export const deleteGame = defineTool({
  name: 'delete_game',
  title: 'Delete a game',
  summary: 'Delete a draft outright; anything already published is delisted instead.',
  description:
    'Deletes a game that has never been published. If it HAS been published, this delists it rather than deleting it — people have linked to it, voted on it and commented on it, and hard-deleting would take their words with it. The response tells you which of the two happened.',
  access: 'key',
  mutates: true,
  destructive: true,
  input: z.object({ game: gameRef }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);

    // "Has been published" is the publish date, not the current status: a game
    // that was live and is now delisted still has readers who linked to it.
    if (game.publishedAt) {
      await ctx.storage.setGameStatus(game.id, 'delisted');
      return {
        id: game.id,
        deleted: false,
        delisted: true,
        note: 'This game had been published, so it was delisted instead of deleted.',
      };
    }

    await ctx.storage.deleteGame(game.id);
    return { id: game.id, deleted: true, delisted: false, note: 'Draft removed permanently.' };
  },
});
