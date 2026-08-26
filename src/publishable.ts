/**
 * What "ready to publish" means, in one place.
 *
 * The check runs against the **stored** record at publish time, not against the
 * arguments of whatever call last touched the game. That is the whole point: a
 * game assembled over five tool calls is validated as a whole game, once, at
 * the moment it would become public — so it cannot be patched into an invalid
 * state, and the refusal names every missing piece at once rather than making
 * an agent discover them one call at a time.
 */

import type { Game, Storage } from './storage/types.js';

export interface PublishCheck {
  ok: boolean;
  missing: string[];
  message: string;
}

export async function checkPublishable(storage: Storage, game: Game): Promise<PublishCheck> {
  const missing: string[] = [];

  if (!game.tagline.trim()) missing.push('a `tagline` (one line, max 140 characters)');

  if (!game.categorySlug.trim()) {
    missing.push('a `categorySlug` — call list_categories for the valid slugs');
  } else if (!(await storage.findCategory(game.categorySlug))) {
    missing.push(`a valid \`categorySlug\` ("${game.categorySlug}" is not one — call list_categories)`);
  }

  // Which URL counts depends on the play mode, and "hosted" fills playUrl for
  // you, so an agent that used upload_game_build has nothing left to do here.
  const urlForMode =
    game.playMode === 'embed' ? game.embedUrl : game.playUrl;
  if (!urlForMode.trim()) {
    missing.push(
      game.playMode === 'embed'
        ? 'an `embedUrl` (playMode is "embed")'
        : game.playMode === 'hosted'
          ? 'a build — call upload_game_build'
          : 'a `playUrl` (playMode is "external")',
    );
  }

  return {
    ok: missing.length === 0,
    missing,
    message: missing.length
      ? `This game is not ready to publish. It still needs ${missing.join(', ')}. Fix it with update_game and call publish_game again.`
      : 'Ready to publish.',
  };
}

/**
 * The next version label, guessed from the last one.
 *
 * Labels are free text, so this is a convenience and never a rule: it bumps a
 * trailing integer if it can find one and otherwise returns null, which means
 * "unlabelled". An agent that tracks its own versions passes `version` and this
 * never runs.
 */
export async function suggestNextVersion(storage: Storage, gameId: string): Promise<string | null> {
  const releases = await storage.listReleases(gameId);
  const last = releases.find((r) => r.version)?.version;
  if (!last) return 'v1';

  const match = /^(.*?)(\d+)(\D*)$/.exec(last);
  if (!match) return null;
  const [, prefix = '', digits = '0', suffix = ''] = match;
  return `${prefix}${Number(digits) + 1}${suffix}`;
}

/** The note written when a build is pushed with no changelog text of its own. */
export function buildPushNote(version: string | null): string {
  return version ? `Pushed a new build (${version}).` : 'Pushed a new build.';
}
