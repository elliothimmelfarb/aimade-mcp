/**
 * Achievements — the maker defines, the game unlocks.
 *
 * This is the most instructive group in the server, because it is where an
 * authority split is enforced by *the absence of an endpoint*. Definitions are
 * written here, on the owner path authenticated by an API key, and nowhere
 * else. The Arcade SDK running inside a game frame can unlock a badge but can
 * never mint one: an unknown slug is NOT_FOUND, never an implicit insert.
 *
 * There is deliberately no create/update/delete for definitions under the
 * game-facing API, and that absence is the enforcement. It is what stops a
 * copied build from inventing badges on a stranger's playthrough.
 *
 * Every description below leads with that split, because an agent that does not
 * understand it will go looking for an SDK call that will never be added.
 */

import { z } from 'zod';

import { ToolError } from '../errors.js';
import { shapeAchievement, shapeArcadeSettings } from '../shape.js';
import { defineTool, gameRef, requireWriter, resolveGame, resolveOwnedGame } from './kit.js';

export const ACHIEVEMENTS_PER_GAME = 100;
export const ACHIEVEMENT_NAME_MAX = 60;
export const ACHIEVEMENT_DESC_MAX = 240;
export const SCORE_LABEL_MAX = 24;

/** The stable key a shipped build already unlocks against. */
export const achievementSlugSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,47}$/,
    'Lowercase letters, digits and hyphens, starting with a letter or digit, up to 48 characters.',
  )
  .describe(
    'The stable key your game code passes to Arcade.achievements.unlock(). Lowercase letters, digits and hyphens, up to 48 characters — e.g. "first-win", "no-damage-run". Pick it once and keep it: renaming the name or description never breaks a shipped build, changing the slug breaks every call site in it.',
  );

/** The fields of one definition, shared by the single and batch forms. */
const achievementFields = {
  slug: achievementSlugSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(ACHIEVEMENT_NAME_MAX)
    .describe(
      `What players see on the badge, up to ${ACHIEVEMENT_NAME_MAX} characters. Name the deed, not the mechanic: "Untouchable" beats "damage_taken == 0".`,
    ),
  description: z
    .string()
    .trim()
    .max(ACHIEVEMENT_DESC_MAX)
    .default('')
    .describe(
      `How it is earned, in one plain-text line, up to ${ACHIEVEMENT_DESC_MAX} characters. No markdown. For a hidden achievement this is only revealed once a player unlocks it.`,
    ),
  emoji: z.string().trim().max(8).default('🏆').describe('One emoji, drawn as the badge face. Defaults to 🏆.'),
  iconUrl: z
    .string()
    .trim()
    .max(2048)
    .optional()
    .describe('https:// URL of a custom badge image, used instead of the emoji. Optional.'),
  hidden: z
    .boolean()
    .default(false)
    .describe(
      'Secret until earned. A hidden achievement still shows on the game page as a locked mystery tile with its rarity count, but its name and description are redacted server-side until that player unlocks it. Use it for endings and easter eggs, not for everything.',
    ),
  points: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(10)
    .describe(
      'Weight, 0-100, defaults to 10. Spend it like a budget: a whole game worth 10 achievements at 10 points each says everything is equally hard, which is never true.',
    ),
  sortOrder: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .default(0)
    .describe('Display position, ascending. Ties fall back to slug order.'),
} as const;

export const listAchievements = defineTool({
  name: 'list_achievements',
  title: "List a game's achievements",
  summary: 'The achievement definitions on a game, in display order.',
  description:
    "Every achievement defined on a game you can see: slug, name, description, emoji, points, whether it is hidden, and how many players have earned it. Read this before you touch a game's badge set — the slugs are the contract the shipped build already unlocks against, and `unlockCount` is how you find the badge nobody can reach.",
  access: 'key',
  mutates: false,
  input: z.object({ game: gameRef }),
  async run(args, ctx) {
    const game = await resolveGame(ctx, args.game);
    const items = await ctx.storage.listAchievements(game.id);
    return {
      gameId: game.id,
      slug: game.slug,
      url: `${ctx.gameUrl(game.slug)}#achievements`,
      items: items.map(shapeAchievement),
      total: items.length,
      remaining: ACHIEVEMENTS_PER_GAME - items.length,
    };
  },
});

export const defineAchievement = defineTool({
  name: 'define_achievement',
  title: 'Define an achievement',
  summary: 'Create or replace one achievement on a game you own.',
  description:
    'Adds one achievement to a game you own, or overwrites the one that already has this slug. Achievements are maker data: only the owner defines them, and the game itself can never mint one — a build calls `Arcade.achievements.unlock("<slug>")` and we refuse any slug that is not already defined here. This tool is idempotent on (game, slug), so a publish script can run twice without making a mess, and re-declaring a badge never resets how many players have earned it. Use define_achievements when you are declaring a whole set at once. Max 100 per game.',
  access: 'key',
  mutates: true,
  input: z.object({ game: gameRef, ...achievementFields }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    const saved = await upsertOne(ctx.storage, game.id, args);
    return { achievement: shapeAchievement(saved) };
  },
});

export const defineAchievements = defineTool({
  name: 'define_achievements',
  title: 'Define a set of achievements',
  summary: "Declare a game's whole badge set in one idempotent call.",
  description:
    'The batch form of define_achievement, and the one to reach for when you publish: hand it the full list your build unlocks against and it upserts every entry on (game, slug), so re-running your publish script changes nothing. Slot it into the chain right after upload_game_build — create_game → upload_game_build → define_achievements → add_screenshot → set_cover → publish_game. The slugs you send here are exactly the strings your game passes to `Arcade.achievements.unlock()`; anything else the build asks for is refused. Entries are applied in order and a game may hold 100, so an oversized set fails on the first entry that will not fit — the ones before it are already saved, and re-sending the trimmed list is safe. Nothing is deleted: a slug you leave out stays defined, so use delete_achievement to retire one.',
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    achievements: z
      .array(z.object(achievementFields))
      .min(1)
      .max(ACHIEVEMENTS_PER_GAME)
      .describe(
        'The definitions, in the order you want them displayed. Each needs at least `slug` and `name`; `description`, `emoji`, `hidden` and `points` are optional and have sane defaults.',
      ),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);

    const saved = [];
    for (const [index, entry] of args.achievements.entries()) {
      // Sort order defaults to 0 on every entry, so a caller that simply listed
      // them in order would get slug-alphabetical display. Their position in
      // the array is the intent, and it is honoured unless they said otherwise.
      saved.push(await upsertOne(ctx.storage, game.id, { ...entry, sortOrder: entry.sortOrder || index }));
    }

    return { gameId: game.id, achievements: saved.map(shapeAchievement), defined: saved.length };
  },
});

/** The one place the per-game ceiling is enforced, for both forms. */
async function upsertOne(
  storage: import('../storage/types.js').Storage,
  gameId: string,
  entry: {
    slug: string;
    name: string;
    description: string;
    emoji: string;
    iconUrl?: string | undefined;
    hidden: boolean;
    points: number;
    sortOrder: number;
  },
) {
  const existing = await storage.listAchievements(gameId);
  const isNew = !existing.some((a) => a.slug === entry.slug);
  if (isNew && existing.length >= ACHIEVEMENTS_PER_GAME) {
    throw new ToolError(
      `"${entry.slug}" would be achievement ${existing.length + 1} on this game, and ${ACHIEVEMENTS_PER_GAME} is the cap. Everything before it is already saved; re-send the trimmed list.`,
    );
  }
  return storage.upsertAchievement(gameId, {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    emoji: entry.emoji,
    iconUrl: entry.iconUrl ?? null,
    hidden: entry.hidden,
    points: entry.points,
    sortOrder: entry.sortOrder,
  });
}

export const updateAchievement = defineTool({
  name: 'update_achievement',
  title: 'Update an achievement',
  summary: 'Patch the wording, emoji, points or secrecy of one badge.',
  description:
    'Edits one achievement on a game you own. Anything you leave out is left exactly as it was, and `slug` is deliberately not patchable — the slug is the key a shipped build already unlocks against, so changing it would silently break the game. Rewrite the name and description as freely as you like: those are display only.',
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    slug: achievementSlugSchema,
    name: z.string().trim().min(1).max(ACHIEVEMENT_NAME_MAX).optional().describe('Replacement name. Omit to keep it.'),
    description: z
      .string()
      .trim()
      .max(ACHIEVEMENT_DESC_MAX)
      .optional()
      .describe('Replacement one-liner. Send "" to clear it.'),
    emoji: z.string().trim().max(8).optional().describe('Replacement badge emoji.'),
    iconUrl: z.string().trim().max(2048).optional().describe('Replacement https:// badge image.'),
    hidden: z
      .boolean()
      .optional()
      .describe(
        'Make it secret, or reveal it. Revealing one is safe; hiding a badge players have already seen is not.',
      ),
    points: z.number().int().min(0).max(100).optional().describe('Replacement weight, 0-100.'),
    sortOrder: z.number().int().min(0).max(9999).optional().describe('Replacement display position, ascending.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    const updated = await ctx.storage.updateAchievement(game.id, args.slug, {
      name: args.name,
      description: args.description,
      emoji: args.emoji,
      iconUrl: args.iconUrl,
      hidden: args.hidden,
      points: args.points,
      sortOrder: args.sortOrder,
    });
    if (!updated) {
      throw new ToolError(
        `"${args.slug}" is not an achievement on this game. Call list_achievements to see the slugs.`,
      );
    }
    return { achievement: shapeAchievement(updated) };
  },
});

export const deleteAchievement = defineTool({
  name: 'delete_achievement',
  title: 'Delete an achievement',
  summary: 'Retire a badge — and every unlock anyone earned for it.',
  description:
    "Removes one achievement from a game you own. Read this part twice: **every unlock of that badge is deleted with it**, so it vanishes from the trophy case of every player who earned it, and the count does not come back if you re-declare the slug later. That cascade is on purpose — a badge whose meaning was removed should not linger on somebody's profile pointing at nothing — but it makes this the one call in the set worth pausing on. If the badge is right and its wording is wrong, use update_achievement. If your build still unlocks this slug, remove that call too, or players will hit a NOT_FOUND every run.",
  access: 'key',
  mutates: true,
  destructive: true,
  input: z.object({ game: gameRef, slug: achievementSlugSchema }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    const deleted = await ctx.storage.deleteAchievement(game.id, args.slug);
    if (!deleted) {
      throw new ToolError(
        `"${args.slug}" is not an achievement on this game. Call list_achievements to see the slugs.`,
      );
    }
    return { deleted: true, slug: args.slug, url: ctx.gameUrl(game.slug) };
  },
});

export const reorderAchievements = defineTool({
  name: 'reorder_achievements',
  title: 'Reorder achievements',
  summary: "Set the display order of a game's badges by listing the slugs.",
  description:
    "Rewrites the display order on the game page and in the SDK's `achievements.list()`. Send the slugs in the order you want them; any slug you leave out keeps whatever position it had and generally sinks below the ones you named. Order is presentation only — but it is worth getting right: the first few badges are the ones a player reads as \"here is what this game is about\", so lead with the early, earnable ones and put the completionist grind at the bottom.",
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    slugs: z
      .array(achievementSlugSchema)
      .min(1)
      .max(ACHIEVEMENTS_PER_GAME)
      .describe('Achievement slugs, first to last. Get them from list_achievements.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    await ctx.storage.reorderAchievements(game.id, args.slugs);
    const items = await ctx.storage.listAchievements(game.id);
    return { gameId: game.id, items: items.map(shapeAchievement) };
  },
});

export const setArcadeSettings = defineTool({
  name: 'set_arcade_settings',
  title: 'Set arcade settings',
  summary: 'Say whether a high score wins, and what to call the score.',
  description:
    'Configures the Arcade SDK leaderboard for a game you own. `scoreSort` is the one that matters: "desc" means a higher number is better (points, distance, kills) and is the default everybody gets; "asc" means lower is better, which is what a speedrun or a stroke count needs — set it once, before anyone plays, because it changes which run counts as a player\'s personal best. `scoreLabel` is display only, the word above the column ("Time", "Depth", "Strokes"). This lives on the owner path rather than in the SDK on purpose: a game must not be able to redefine what its own leaderboard means halfway through a season.',
  access: 'key',
  mutates: true,
  input: z.object({
    game: gameRef,
    scoreSort: z
      .enum(['desc', 'asc'])
      .default('desc')
      .describe('"desc" = higher is better (default). "asc" = lower is better.'),
    scoreLabel: z
      .string()
      .trim()
      .min(1)
      .max(SCORE_LABEL_MAX)
      .default('Score')
      .describe(`What the number is called on the board, up to ${SCORE_LABEL_MAX} characters. Defaults to "Score".`),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const game = await resolveOwnedGame(ctx, args.game);
    const settings = await ctx.storage.setArcadeSettings(game.id, {
      scoreSort: args.scoreSort,
      scoreLabel: args.scoreLabel,
    });
    return { gameId: game.id, arcade: shapeArcadeSettings(settings) };
  },
});
