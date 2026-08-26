/**
 * The registry.
 *
 * One array is the single source of truth for what the server serves — the MCP
 * tool list, any generated documentation, and the tests. A tool that is not in
 * here does not exist, and documentation generated from anywhere else can go
 * stale relative to the server; this one cannot.
 */

import * as achievements from './achievements.js';
import * as changelog from './changelog.js';
import * as games from './games.js';
import * as media from './media.js';
import * as personas from './personas.js';
import * as publicTools from './public.js';
import * as social from './social.js';

import type { ToolDefinition } from './kit.js';

export const TOOLS: ToolDefinition[] = [
  // Public — no key required.
  publicTools.searchGames,
  publicTools.topGames,
  publicTools.getGame,
  publicTools.listCategories,
  publicTools.listChangelog,

  // Identity.
  publicTools.whoami,
  personas.listPersonas,
  personas.createPersona,
  personas.updatePersona,
  personas.setDefaultPersona,
  personas.updateProfile,

  // Owning games — the publish flow.
  games.listMyGames,
  games.createGame,
  games.updateGame,
  games.publishGame,
  games.unpublishGame,
  games.delistGame,
  games.deleteGame,

  // Media.
  media.addScreenshot,
  media.removeScreenshot,
  media.reorderScreenshots,
  media.setCover,
  media.uploadGameBuild,

  // Changelog.
  changelog.addChangelogEntry,
  changelog.updateChangelogEntry,
  changelog.deleteChangelogEntry,

  // Arcade — makers define, games unlock.
  achievements.listAchievements,
  achievements.defineAchievement,
  achievements.defineAchievements,
  achievements.updateAchievement,
  achievements.deleteAchievement,
  achievements.reorderAchievements,
  achievements.setArcadeSettings,

  // The maker's inbox, and being a citizen.
  social.gameStats,
  social.listComments,
  social.listBugReports,
  social.updateBugStatus,
  social.voteGame,
  social.postComment,
  social.reportBug,
  social.reportSiteBug,
];

export const PUBLIC_TOOLS = TOOLS.filter((tool) => tool.access === 'public');
export const KEYED_TOOLS = TOOLS.filter((tool) => tool.access === 'key');

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

export { ToolContext, defineTool } from './kit.js';
export type { ToolAccess, ToolDefinition } from './kit.js';
