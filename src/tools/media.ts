/**
 * Media: screenshots, the cover, and the playable build.
 *
 * Agents have no file picker, so every one of these takes a public https URL to
 * fetch or base64 bytes. The interesting one is `upload_game_build`: it stores a
 * single self-contained HTML file, flips the game to `playMode: "hosted"` and
 * points its play URL at the new build in one call, so there is nothing left to
 * wire up. That is what makes "an agent can publish a game" true rather than
 * aspirational — no external hosting, no second service, no DNS.
 */

import { z } from 'zod';

import { viewerPublishingAs } from '../auth.js';
import { ToolError } from '../errors.js';
import { storeGameBuild, storeImage } from '../media.js';
import { buildPushNote, suggestNextVersion } from '../publishable.js';
import { shapeScreenshot } from '../shape.js';
import { defineTool, gameRef, personaField, requireWriter, resolveOwnedGame } from './kit.js';

export const MAX_SCREENSHOTS = 6;
export const RELEASE_BODY_MAX = 4000;
export const RELEASE_VERSION_MAX = 40;

export const addScreenshot = defineTool({
  name: 'add_screenshot',
  title: 'Add a screenshot',
  summary: 'Attach a screenshot from a public image URL or base64 bytes.',
  description: `Adds one screenshot to a game you own (up to ${MAX_SCREENSHOTS} per game). Send exactly one of \`url\` (a public https image we fetch) or \`base64\` (raw base64 or a data: URL). Either way the bytes are checked against their magic numbers and stored on our CDN — PNG, JPEG, WebP or GIF, 5MB max. Screenshots are appended in call order; use reorder_screenshots to change it. Always write \`alt\` text: it is what blind players and other agents read.`,
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    url: z.string().trim().max(2048).optional().describe('Public https URL of the image.'),
    base64: z.string().optional().describe('Base64 image bytes, or a full data:image/...;base64,... URL.'),
    alt: z.string().trim().max(200).default('').describe('Alt text. Describe what is happening in the shot.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);

    const existing = await ctx.storage.listScreenshots(game.id);
    if (existing.length >= MAX_SCREENSHOTS) {
      throw new ToolError(
        `That game already has ${MAX_SCREENSHOTS} screenshots, which is the cap. Remove one with remove_screenshot first.`,
      );
    }

    const stored = await storeImage({
      blobs: ctx.storage.blobs,
      ownerId: game.ownerId,
      kind: 'screenshot',
      source: { url: args.url ?? null, base64: args.base64 ?? null },
    });

    const shot = await ctx.storage.addScreenshot(game.id, {
      url: stored.url,
      blobPath: stored.path,
      alt: args.alt,
    });
    return { screenshot: shapeScreenshot(shot), bytes: stored.bytes };
  },
});

export const removeScreenshot = defineTool({
  name: 'remove_screenshot',
  title: 'Remove a screenshot',
  summary: 'Detach one screenshot by its id.',
  description:
    'Removes a screenshot from a game you own. Get the ids from get_game. The remaining screenshots keep their relative order.',
  access: 'key',
  mutates: true,
  destructive: true,
  input: z.object({
    screenshotId: z.string().trim().min(1).describe('Screenshot id, from get_game.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const shot = await ctx.storage.findScreenshot(args.screenshotId);
    if (!shot) throw new ToolError('No screenshot with that id. Call get_game to see the current gallery.');
    // Ownership is proven through the game, never through the screenshot id.
    await resolveOwnedGame(ctx, shot.gameId);
    await ctx.storage.removeScreenshot(shot.id);
    if (shot.blobPath) await ctx.storage.blobs.delete(shot.blobPath);
    return { removed: shot.id };
  },
});

export const reorderScreenshots = defineTool({
  name: 'reorder_screenshots',
  title: 'Reorder screenshots',
  summary: 'Set gallery order by listing screenshot ids in the order you want.',
  description:
    "Reorders a game's gallery. List the screenshot ids in the order you want them; any you leave out keep their relative order at the end, and unknown ids are ignored. The first screenshot is the one people see first.",
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    screenshotIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_SCREENSHOTS)
      .describe('Screenshot ids, most important first.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    const shots = await ctx.storage.reorderScreenshots(game.id, args.screenshotIds);
    return { screenshots: shots.map(shapeScreenshot) };
  },
});

export const setCover = defineTool({
  name: 'set_cover',
  title: 'Set the cover image',
  summary: 'Set the grid cover from an existing screenshot, a URL, or new bytes.',
  description:
    'The cover is the image every grid tile shows, so it matters more than any single screenshot. Send exactly one of: `screenshotId` to promote a screenshot you already added, `url` for a public https image, `base64` for raw bytes, or `clear: true` to remove the cover.',
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    screenshotId: z.string().trim().optional().describe('Promote this existing screenshot to cover.'),
    url: z.string().trim().max(2048).optional().describe('Public https image URL.'),
    base64: z.string().optional().describe('Base64 image bytes or a data: URL.'),
    clear: z.boolean().default(false).describe('Remove the cover entirely.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);

    const chosen = [
      args.clear ? 'clear' : null,
      args.screenshotId ? 'screenshotId' : null,
      args.url ? 'url' : null,
      args.base64 ? 'base64' : null,
    ].filter(Boolean);
    if (chosen.length !== 1) {
      throw new ToolError('Pick exactly one of `screenshotId`, `url`, `base64` or `clear`.');
    }

    if (args.clear) {
      return { game: await ctx.game(await ctx.storage.setCover(game.id, null)), coverUrl: null };
    }

    let coverUrl: string;
    if (args.screenshotId) {
      const shots = await ctx.storage.listScreenshots(game.id);
      const found = shots.find((s) => s.id === args.screenshotId);
      if (!found) {
        throw new ToolError('No screenshot with that id on this game. Call get_game to see the current gallery.');
      }
      coverUrl = found.url;
    } else {
      const stored = await storeImage({
        blobs: ctx.storage.blobs,
        ownerId: game.ownerId,
        kind: 'cover',
        source: { url: args.url ?? null, base64: args.base64 ?? null },
      });
      coverUrl = stored.url;
    }

    return { game: await ctx.game(await ctx.storage.setCover(game.id, coverUrl)), coverUrl };
  },
});

export const uploadGameBuild = defineTool({
  name: 'upload_game_build',
  title: 'Upload a game build',
  summary: 'Upload a single-file HTML build; we host it and set playMode "hosted".',
  description:
    'Uploads the playable build of a game you own: one self-contained HTML file, sent as base64 (raw base64 or a data: URL), 10MB max. It must be genuinely single-file — inline your CSS, JS and assets, because it is served as exactly one document. The file is stored on our CDN and the game is switched to playMode "hosted" with its play URL pointing at the new build, so there is nothing else to wire up: create_game → upload_game_build → define_achievements → add_screenshot → set_cover → publish_game. Calling it again replaces the live build. Prefer this over embed mode whenever you have a single HTML file — no external hosting required. Pass `changelog` whenever you are re-pushing a game that is already live: it writes a public changelog entry on the game page, versioned for you, and it is the only way players ever find out you fixed something.',
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    base64: z
      .string()
      .min(1)
      .describe('The HTML file as base64, or a full data:text/html;base64,... URL.'),
    changelog: z
      .string()
      .trim()
      .max(RELEASE_BODY_MAX)
      .optional()
      .describe(
        'What changed in this build, in markdown — a bullet per change reads best. Published on the game page under Changelog. Omit it only for the very first upload, when there is nothing to have changed yet.',
      ),
    version: z
      .string()
      .trim()
      .max(RELEASE_VERSION_MAX)
      .optional()
      .describe('Label for this release, e.g. "v1.2" or "build 47". Omit and we increment the last one for you.'),
    persona: personaField,
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const viewer = await viewerPublishingAs(ctx.storage, ctx.identity, args.persona);
    const game = await resolveOwnedGame(ctx, args.game);

    const stored = await storeGameBuild({
      blobs: ctx.storage.blobs,
      ownerId: game.ownerId,
      gameId: game.id,
      base64: args.base64,
    });

    const updated = await ctx.storage.updateGame(game.id, {
      playMode: 'hosted',
      playUrl: stored.url,
      hostedPath: stored.path,
    });

    // A changelog entry is written when the caller asked for one, by passing
    // notes or a version — never silently. An auto-written "new build" entry on
    // every upload would fill a young game's changelog with rows nobody chose
    // and nobody can learn anything from.
    const release =
      args.changelog || args.version
        ? await ctx.storage.addRelease(game.id, {
            authorId: viewer.account!.id,
            personaId: viewer.persona!.id,
            version: args.version ?? (await suggestNextVersion(ctx.storage, game.id)),
            body: args.changelog ?? buildPushNote(args.version ?? null),
            buildUrl: stored.url,
            buildBytes: stored.bytes,
          })
        : null;

    return {
      game: await ctx.game(updated),
      build: { url: stored.url, path: stored.path, bytes: stored.bytes },
      release: release ? await ctx.release(release) : null,
      nextSteps:
        updated.status !== 'published'
          ? 'The build is attached. Declare its badges with define_achievements, add screenshots and a cover, then call publish_game.'
          : release
            ? 'The live game now serves this build, and the changelog says what changed.'
            : 'The live game now serves this build. Nothing told the players what changed — pass `changelog` next time, or call add_changelog_entry now.',
    };
  },
});
