/**
 * What a tool hands back.
 *
 * Agents get ids *and* URLs for everything, because the two are used for
 * different jobs: the id is what you pass to the next tool call, the URL is
 * what you paste to a human. Dates are ISO strings — a `Date` does not survive
 * JSON, and "2026-08-08T12:00:00.000Z" is unambiguous in every locale.
 *
 * The other rule this file enforces: a public shape carries the **persona**,
 * never the account. Rendering an account id publicly is a bug, and the easiest
 * place to prevent it is the one function every response goes through.
 */

import type {
  Achievement,
  ArcadeSettings,
  BugReport,
  Comment,
  Game,
  GameStats,
  Persona,
  Release,
  Screenshot,
  SiteFeedback,
} from './storage/types.js';

/** The live production instance of this pattern. */
export const DEFAULT_SITE_URL = 'https://aimade.games';

export interface ShapeContext {
  siteUrl: string;
  /** The byline a game is published under, resolved by the caller. */
  personaFor(personaId: string): Persona | null;
}

export function origin(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, '');
}

export function gameUrl(siteUrl: string, slug: string): string {
  return `${origin(siteUrl)}/g/${slug}`;
}

export function playUrlFor(siteUrl: string, slug: string): string {
  return `${origin(siteUrl)}/g/${slug}/play`;
}

export function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/* -------------------------------------------------------------------------- */

/** The byline, in the shape every tool reports an identity. */
export function shapePersona(ctx: ShapeContext, persona: Persona) {
  return {
    id: persona.id,
    username: persona.username,
    displayName: persona.displayName,
    avatarUrl: persona.avatarUrl,
    profileUrl: `${origin(ctx.siteUrl)}/u/${persona.username}`,
  };
}

/** A persona as its own owner sees it, including whether it is the default. */
export function shapeOwnPersona(ctx: ShapeContext, persona: Persona, activeId: string | null) {
  return {
    ...shapePersona(ctx, persona),
    bio: persona.bio,
    isDefault: persona.isDefault,
    isActive: persona.id === activeId,
    createdAt: iso(persona.createdAt),
  };
}

export function shapeCard(ctx: ShapeContext, game: Game) {
  const persona = ctx.personaFor(game.personaId);
  const byline = persona
    ? shapePersona(ctx, persona)
    : { id: game.personaId, username: null, displayName: null, avatarUrl: null, profileUrl: null };

  return {
    id: game.id,
    slug: game.slug,
    url: gameUrl(ctx.siteUrl, game.slug),
    title: game.title,
    tagline: game.tagline,
    status: game.status,
    coverUrl: game.coverUrl,
    playMode: game.playMode,
    tags: game.tags,
    category: game.categorySlug || null,
    /** The byline this game is published under. Never an account. */
    persona: byline,
    personaId: game.personaId,
    /** Kept as an alias of `persona` — agents already read `owner.username`. */
    owner: {
      username: byline.username,
      displayName: byline.displayName,
      profileUrl: byline.profileUrl,
    },
    votes: { up: game.upvotes, down: game.downvotes, score: game.upvotes - game.downvotes },
    playCount: game.playCount,
    publishedAt: iso(game.publishedAt),
    createdAt: iso(game.createdAt),
  };
}

export function shapeScreenshot(shot: Screenshot) {
  return { id: shot.id, url: shot.url, alt: shot.alt, sortOrder: shot.sortOrder };
}

export function shapeGame(ctx: ShapeContext, game: Game, screenshots: Screenshot[] = []) {
  return {
    ...shapeCard(ctx, game),
    description: game.description,
    aiTools: game.aiTools,
    playUrl: game.playUrl,
    embedUrl: game.embedUrl,
    playPageUrl: playUrlFor(ctx.siteUrl, game.slug),
    viewCount: game.viewCount,
    updatedAt: iso(game.updatedAt),
    screenshots: screenshots.map(shapeScreenshot),
    screenshotCount: screenshots.length,
  };
}

export function shapeRelease(ctx: ShapeContext, release: Release) {
  const persona = ctx.personaFor(release.personaId);
  return {
    id: release.id,
    version: release.version,
    body: release.body,
    /** Present only when the entry actually shipped a build. */
    build: release.buildUrl ? { url: release.buildUrl, bytes: release.buildBytes } : null,
    author: persona ? shapePersona(ctx, persona) : null,
    createdAt: iso(release.createdAt),
    updatedAt: iso(release.updatedAt),
  };
}

export function shapeAchievement(achievement: Achievement) {
  return {
    slug: achievement.slug,
    name: achievement.name,
    description: achievement.description,
    emoji: achievement.emoji,
    iconUrl: achievement.iconUrl,
    hidden: achievement.hidden,
    points: achievement.points,
    sortOrder: achievement.sortOrder,
    /** How many players have earned it — how you find the badge nobody reaches. */
    unlockCount: achievement.unlockCount,
  };
}

export function shapeArcadeSettings(settings: ArcadeSettings) {
  return { scoreSort: settings.scoreSort, scoreLabel: settings.scoreLabel };
}

export function shapeComment(ctx: ShapeContext, comment: Comment) {
  const persona = ctx.personaFor(comment.personaId);
  return {
    id: comment.id,
    /** Threading rides on `parentId` rather than a nested array: one level deep. */
    parentId: comment.parentId,
    body: comment.body,
    hidden: comment.hidden,
    author: persona ? shapePersona(ctx, persona) : null,
    createdAt: iso(comment.createdAt),
    editedAt: iso(comment.editedAt),
  };
}

export function shapeBugReport(ctx: ShapeContext, report: BugReport) {
  const persona = ctx.personaFor(report.personaId);
  return {
    id: report.id,
    title: report.title,
    body: report.body,
    status: report.status,
    reporter: persona ? persona.username : null,
    createdAt: iso(report.createdAt),
    updatedAt: iso(report.updatedAt),
  };
}

export function shapeSiteFeedback(report: SiteFeedback) {
  return {
    id: report.id,
    title: report.title,
    kind: report.kind,
    status: report.status,
    pageUrl: report.pageUrl,
    createdAt: iso(report.createdAt),
  };
}

export function shapeStats(ctx: ShapeContext, stats: GameStats) {
  return {
    ...stats,
    url: gameUrl(ctx.siteUrl, stats.slug),
    publishedAt: iso(stats.publishedAt),
    createdAt: iso(stats.createdAt),
    updatedAt: iso(stats.updatedAt),
  };
}

/** Wrap a page of rows in the pagination envelope every list tool returns. */
export function shapeList<T, U>(
  page: { items: T[]; total: number; page: number; perPage: number; pages: number },
  map: (row: T) => U,
) {
  return {
    items: page.items.map(map),
    total: page.total,
    page: page.page,
    perPage: page.perPage,
    pages: page.pages,
    hasMore: page.page < page.pages,
  };
}
