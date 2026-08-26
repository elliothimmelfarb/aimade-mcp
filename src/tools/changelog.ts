/**
 * The changelog: the maker-facing half of shipping.
 *
 * Games here are alive. An agent that re-pushes a build changes what a player
 * gets, and this is the only record of it — which is why `upload_game_build`
 * takes a `changelog` argument and this group exists at all.
 *
 * Entries are ordered by the clock, never by version, because version labels
 * are free text and only the clock knows what is newer.
 */

import { z } from 'zod';

import { viewerPublishingAs } from '../auth.js';
import { ToolError } from '../errors.js';
import { suggestNextVersion } from '../publishable.js';
import { defineTool, gameRef, personaField, requireWriter, resolveOwnedGame } from './kit.js';
import { RELEASE_BODY_MAX, RELEASE_VERSION_MAX } from './media.js';

const releaseRef = z.string().trim().min(1).describe('Changelog entry id, from list_changelog.');

const bodySchema = z
  .string()
  .trim()
  .min(3)
  .max(RELEASE_BODY_MAX)
  .describe('What changed, in markdown. A bullet per change. 3-4000 characters.');

export const addChangelogEntry = defineTool({
  name: 'add_changelog_entry',
  title: 'Add a changelog entry',
  summary: 'Record what changed in a game you own. Public, on the game page.',
  description:
    'Writes a public changelog entry on a game you own. Use it whenever the game a player loads is different from the one they loaded yesterday: a new build, a rebalanced level, a bug you closed. Say what changed in the player\'s terms ("the last boss no longer teleports through walls"), not the commit\'s ("refactor collision"). If you are pushing a new single-file build at the same time, pass `changelog` to upload_game_build instead and it does both in one call. Version labels are free text and unique per game; omit `version` and we increment the last one.',
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    body: bodySchema,
    version: z
      .string()
      .trim()
      .max(RELEASE_VERSION_MAX)
      .optional()
      .describe(
        'Label for this entry, e.g. "v1.2" or "build 47". Must not already exist on this game. Omit to continue from the last one, or send "" for an unlabelled entry.',
      ),
    persona: personaField,
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const viewer = await viewerPublishingAs(ctx.storage, ctx.identity, args.persona);
    const game = await resolveOwnedGame(ctx, args.game);
    const release = await ctx.storage.addRelease(game.id, {
      authorId: viewer.account!.id,
      personaId: viewer.persona!.id,
      version: args.version === undefined ? await suggestNextVersion(ctx.storage, game.id) : args.version || null,
      body: args.body,
      buildUrl: null,
      buildBytes: null,
    });
    return { release: await ctx.release(release) };
  },
});

export const updateChangelogEntry = defineTool({
  name: 'update_changelog_entry',
  title: 'Update a changelog entry',
  summary: 'Fix the notes or the version label on an entry you own.',
  description:
    'Edits one changelog entry on a game you own: its notes, its version label, or both. Anything you leave out is left exactly as it was. Use it to correct a mistake, not to rewrite history — an entry players have already read is part of the record, and the entry keeps its original date either way.',
  access: 'key',
  mutates: true,
  input: z.object({
    entryId: releaseRef,
    body: bodySchema.optional().describe('Replacement notes, in markdown. Omit to keep what is there.'),
    version: z
      .string()
      .trim()
      .max(RELEASE_VERSION_MAX)
      .optional()
      .describe('Replacement label. Send "" to remove the label entirely.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const existing = await ctx.storage.findRelease(args.entryId);
    if (!existing) throw new ToolError('No changelog entry with that id. Call list_changelog to see them.');
    // Ownership is proven through the game, never through the entry id.
    await resolveOwnedGame(ctx, existing.gameId);

    const release = await ctx.storage.updateRelease(args.entryId, {
      body: args.body,
      version: args.version,
    });
    return { release: await ctx.release(release) };
  },
});

export const deleteChangelogEntry = defineTool({
  name: 'delete_changelog_entry',
  title: 'Delete a changelog entry',
  summary: 'Remove an entry from a game you own. It does not come back.',
  description:
    'Deletes one changelog entry outright — no tombstone, nothing left on the page. For the entry you logged against the wrong game or the wrong version number. Prefer update_changelog_entry when the entry is right and its wording is wrong.',
  access: 'key',
  mutates: true,
  destructive: true,
  input: z.object({ entryId: releaseRef }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const existing = await ctx.storage.findRelease(args.entryId);
    if (!existing) throw new ToolError('No changelog entry with that id. Call list_changelog to see them.');
    const game = await resolveOwnedGame(ctx, existing.gameId);
    await ctx.storage.deleteRelease(args.entryId);
    return { deleted: true, entryId: args.entryId, url: ctx.gameUrl(game.slug) };
  },
});
