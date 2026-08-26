/**
 * An in-memory `Storage`, so the server runs with zero credentials.
 *
 * It is not a toy: it enforces the same invariants the Postgres implementation
 * does — visibility on every read, one vote per account, slug uniqueness,
 * idempotent achievement upserts, publish-date stability — because those are
 * the parts of the pattern worth teaching. What it does not do is survive a
 * restart, scale, or hold a transaction. Swap this module for a Drizzle one and
 * nothing above it changes.
 */

import { randomUUID } from 'node:crypto';

import {
  BUG_REPORT_STATUSES,
  type Account,
  type Achievement,
  type AchievementInput,
  type ApiKey,
  type ArcadeSettings,
  type BlobStore,
  type BugReport,
  type BugReportStatus,
  type Category,
  type Comment,
  type Game,
  type GameCreateInput,
  type GameStats,
  type GameStatus,
  type GameUpdateInput,
  type ListGamesOptions,
  type Page,
  type Persona,
  type Release,
  type Screenshot,
  type SiteFeedback,
  type Storage,
  type StoredBlob,
  type Viewer,
  type Vote,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Ranking — the same shape the live site uses                                */
/* -------------------------------------------------------------------------- */

/**
 * Wilson lower bound at 95% confidence. A game with 3 upvotes and 0 downvotes
 * should not outrank one with 300 and 5, and a plain ratio says it does.
 */
export function wilsonScore(up: number, down: number): number {
  const n = up + down;
  if (n === 0) return 0;
  const z = 1.96;
  const p = up / n;
  return (
    (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) /
    (1 + (z * z) / n)
  );
}

/** "hot" is the Wilson score decayed by age, so the front page keeps moving. */
export function hotScore(up: number, down: number, publishedAt: Date | null, now = Date.now()): number {
  const ageHours = publishedAt ? Math.max(0, (now - publishedAt.getTime()) / 3_600_000) : 0;
  return wilsonScore(up, down) / Math.pow(ageHours + 2, 0.4);
}

/* -------------------------------------------------------------------------- */
/*  Slugs                                                                      */
/* -------------------------------------------------------------------------- */

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'game'
  );
}

/* -------------------------------------------------------------------------- */
/*  Blobs                                                                      */
/* -------------------------------------------------------------------------- */

export class MemoryBlobStore implements BlobStore {
  /** Exposed so tests and the demo can assert on what was stored. */
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();

  constructor(private readonly baseUrl = 'https://blob.local') {}

  async put(path: string, data: Uint8Array, contentType: string): Promise<StoredBlob> {
    this.files.set(path, { data, contentType });
    return {
      url: `${this.baseUrl}/${path}`,
      path,
      bytes: data.byteLength,
      contentType,
    };
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}

/* -------------------------------------------------------------------------- */
/*  Seed                                                                       */
/* -------------------------------------------------------------------------- */

export const DEFAULT_CATEGORIES: Category[] = [
  { slug: 'arcade', name: 'Arcade', emoji: '🕹️', description: 'Score attack, one more run.', sortOrder: 0 },
  { slug: 'puzzle', name: 'Puzzle', emoji: '🧩', description: 'Think, then click.', sortOrder: 1 },
  { slug: 'adventure', name: 'Adventure', emoji: '🗺️', description: 'Go somewhere.', sortOrder: 2 },
  { slug: 'strategy', name: 'Strategy', emoji: '♟️', description: 'Plan, commit, regret.', sortOrder: 3 },
  { slug: 'toy', name: 'Toy', emoji: '🪀', description: 'No goal, all play.', sortOrder: 4 },
];

export interface SeedOptions {
  /** The demo account's API key. Any string; the live site issues `amg_...`. */
  apiKey?: string;
  username?: string;
  categories?: Category[];
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                  */
/* -------------------------------------------------------------------------- */

export class MemoryStorage implements Storage {
  readonly blobs = new MemoryBlobStore();

  private readonly accounts = new Map<string, Account>();
  private readonly apiKeys = new Map<string, ApiKey>();
  private readonly personas = new Map<string, Persona>();
  private readonly categories = new Map<string, Category>();
  private readonly games = new Map<string, Game>();
  private readonly screenshots = new Map<string, Screenshot>();
  private readonly releases = new Map<string, Release>();
  private readonly achievements = new Map<string, Achievement>();
  private readonly arcadeSettings = new Map<string, ArcadeSettings>();
  private readonly comments = new Map<string, Comment>();
  private readonly bugReports = new Map<string, BugReport>();
  private readonly votes = new Map<string, Vote>();
  private readonly siteFeedback = new Map<string, SiteFeedback>();

  constructor(options: SeedOptions = {}) {
    for (const category of options.categories ?? DEFAULT_CATEGORIES) {
      this.categories.set(category.slug, { ...category });
    }
    if (options.apiKey) this.seedAccount(options.apiKey, options.username ?? 'demo');
  }

  /** Create an account, its default persona and an API key. Returns all three. */
  seedAccount(
    key: string,
    username: string,
    overrides: Partial<Account> = {},
  ): { account: Account; persona: Persona; apiKey: ApiKey } {
    const account: Account = {
      id: randomUUID(),
      username,
      displayName: username,
      avatarUrl: null,
      role: 'user',
      banned: false,
      ...overrides,
    };
    this.accounts.set(account.id, account);

    const persona: Persona = {
      id: randomUUID(),
      accountId: account.id,
      username,
      displayName: username,
      bio: '',
      avatarUrl: null,
      isDefault: true,
      createdAt: new Date(),
    };
    this.personas.set(persona.id, persona);

    const apiKey: ApiKey = {
      id: randomUUID(),
      accountId: account.id,
      key,
      name: 'demo key',
      enabled: true,
    };
    this.apiKeys.set(apiKey.id, apiKey);

    return { account, persona, apiKey };
  }

  /* ------------------------------------------------------------------ */
  /*  Visibility — the one rule every read shares                        */
  /* ------------------------------------------------------------------ */

  /**
   * Can this viewer see this game at all? Drafts and delisted games are visible
   * only to their owner and to admins. Deliberately not a UI concern: a caller
   * that forgets to filter still cannot leak a draft.
   */
  private visible(viewer: Viewer, game: Game): boolean {
    if (game.status === 'published') return true;
    if (!viewer.account) return false;
    return viewer.isAdmin || game.ownerId === viewer.account.id;
  }

  /* ------------------------------------------------------------------ */
  /*  Identity                                                           */
  /* ------------------------------------------------------------------ */

  async findApiKey(token: string): Promise<ApiKey | null> {
    for (const key of this.apiKeys.values()) if (key.key === token) return { ...key };
    return null;
  }

  async findAccount(id: string): Promise<Account | null> {
    const row = this.accounts.get(id);
    return row ? { ...row } : null;
  }

  async updateAccount(
    id: string,
    patch: Partial<Pick<Account, 'displayName' | 'avatarUrl'>>,
  ): Promise<Account> {
    const row = this.accounts.get(id);
    if (!row) throw new Error('NOT_FOUND');
    Object.assign(row, patch);
    return { ...row };
  }

  /* ------------------------------------------------------------------ */
  /*  Personas                                                           */
  /* ------------------------------------------------------------------ */

  async listPersonas(accountId: string): Promise<Persona[]> {
    return [...this.personas.values()]
      .filter((p) => p.accountId === accountId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => ({ ...p }));
  }

  async findPersona(id: string): Promise<Persona | null> {
    const row = this.personas.get(id);
    return row ? { ...row } : null;
  }

  async findOwnPersona(accountId: string, ref: string): Promise<Persona | null> {
    const needle = ref.trim().toLowerCase();
    for (const p of this.personas.values()) {
      if (p.accountId !== accountId) continue;
      if (p.id === ref || p.username.toLowerCase() === needle) return { ...p };
    }
    return null;
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    const needle = username.trim().toLowerCase();
    for (const p of this.personas.values()) if (p.username.toLowerCase() === needle) return true;
    for (const a of this.accounts.values()) if (a.username.toLowerCase() === needle) return true;
    return false;
  }

  async createPersona(
    accountId: string,
    input: Pick<Persona, 'username' | 'displayName' | 'bio' | 'avatarUrl'>,
  ): Promise<Persona> {
    const persona: Persona = {
      id: randomUUID(),
      accountId,
      username: input.username,
      displayName: input.displayName || input.username,
      bio: input.bio,
      avatarUrl: input.avatarUrl,
      // The first byline on an account is its default; later ones are not.
      isDefault: (await this.listPersonas(accountId)).length === 0,
      createdAt: new Date(),
    };
    this.personas.set(persona.id, persona);
    return { ...persona };
  }

  async updatePersona(
    id: string,
    patch: Partial<Pick<Persona, 'username' | 'displayName' | 'bio' | 'avatarUrl'>>,
  ): Promise<Persona> {
    const row = this.personas.get(id);
    if (!row) throw new Error('NOT_FOUND');
    Object.assign(row, patch);
    return { ...row };
  }

  async setDefaultPersona(accountId: string, personaId: string): Promise<Persona> {
    // Exactly one default at a time: this moves the flag rather than adding one.
    for (const p of this.personas.values()) {
      if (p.accountId === accountId) p.isDefault = p.id === personaId;
    }
    const row = this.personas.get(personaId);
    if (!row) throw new Error('NOT_FOUND');
    return { ...row };
  }

  /* ------------------------------------------------------------------ */
  /*  Categories                                                         */
  /* ------------------------------------------------------------------ */

  async listCategories(): Promise<Category[]> {
    return [...this.categories.values()].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => ({ ...c }));
  }

  async findCategory(slug: string): Promise<Category | null> {
    const row = this.categories.get(slug.trim().toLowerCase());
    return row ? { ...row } : null;
  }

  /* ------------------------------------------------------------------ */
  /*  Games                                                              */
  /* ------------------------------------------------------------------ */

  async listGames(viewer: Viewer, options: ListGamesOptions): Promise<Page<Game>> {
    const search = (options.search ?? '').trim().toLowerCase();
    const page = Math.max(1, options.page ?? 1);
    const perPage = Math.min(50, Math.max(1, options.perPage ?? 20));
    const sort = options.sort ?? 'hot';

    // Search is deliberately the public arcade only: a draft must never surface
    // in a list, not even for its owner, or "published" would mean nothing.
    let rows = [...this.games.values()].filter((g) => g.status === 'published');
    if (search) {
      rows = rows.filter(
        (g) =>
          g.title.toLowerCase().includes(search) ||
          g.tagline.toLowerCase().includes(search) ||
          g.tags.some((t) => t.toLowerCase().includes(search)),
      );
    }
    if (options.category) rows = rows.filter((g) => g.categorySlug === options.category);
    if (options.tag) rows = rows.filter((g) => g.tags.includes(options.tag!));

    rows.sort((a, b) => {
      if (sort === 'new') return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
      if (sort === 'top') return wilsonScore(b.upvotes, b.downvotes) - wilsonScore(a.upvotes, a.downvotes);
      return hotScore(b.upvotes, b.downvotes, b.publishedAt) - hotScore(a.upvotes, a.downvotes, a.publishedAt);
    });

    const total = rows.length;
    const start = (page - 1) * perPage;
    return {
      items: rows.slice(start, start + perPage).map((g) => ({ ...g })),
      total,
      page,
      perPage,
      pages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  async listByOwner(
    viewer: Viewer,
    accountId: string,
    options: { includeUnpublished: boolean; limit: number },
  ): Promise<Game[]> {
    return [...this.games.values()]
      .filter((g) => g.ownerId === accountId)
      .filter((g) => options.includeUnpublished || g.status === 'published')
      .filter((g) => this.visible(viewer, g))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, options.limit)
      .map((g) => ({ ...g }));
  }

  async findGameById(viewer: Viewer, id: string): Promise<Game | null> {
    const row = this.games.get(id);
    if (!row || !this.visible(viewer, row)) return null;
    return { ...row };
  }

  async findGameBySlug(viewer: Viewer, slug: string): Promise<Game | null> {
    for (const row of this.games.values()) {
      if (row.slug === slug) return this.visible(viewer, row) ? { ...row } : null;
    }
    return null;
  }

  async createGame(viewer: Viewer, input: GameCreateInput): Promise<Game> {
    if (!viewer.account || !viewer.persona) throw new Error('UNAUTHORIZED');
    const now = new Date();
    const game: Game = {
      id: randomUUID(),
      slug: this.mintSlug(input.title),
      title: input.title,
      tagline: input.tagline,
      description: input.description,
      ownerId: viewer.account.id,
      personaId: viewer.persona.id,
      categorySlug: input.categorySlug,
      tags: [...input.tags],
      aiTools: [...input.aiTools],
      playMode: input.playMode,
      playUrl: input.playUrl,
      embedUrl: input.embedUrl,
      hostedPath: null,
      coverUrl: input.coverUrl || null,
      // Always a draft. Publishing is a separate, deliberate act.
      status: 'draft',
      upvotes: 0,
      downvotes: 0,
      playCount: 0,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };
    this.games.set(game.id, game);
    return { ...game };
  }

  /** Collision-suffixed, and minted once: the slug never changes afterwards. */
  private mintSlug(title: string): string {
    const base = slugify(title);
    const taken = new Set([...this.games.values()].map((g) => g.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async updateGame(id: string, patch: GameUpdateInput): Promise<Game> {
    const row = this.games.get(id);
    if (!row) throw new Error('NOT_FOUND');
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (row as unknown as Record<string, unknown>)[key] = value;
    }
    row.updatedAt = new Date();
    return { ...row };
  }

  async setGameStatus(id: string, status: GameStatus, publishedAt?: Date | null): Promise<Game> {
    const row = this.games.get(id);
    if (!row) throw new Error('NOT_FOUND');
    row.status = status;
    // The first publish stamps the date; a re-publish keeps the original, so a
    // delisted game cannot fake its way back to the top of "new".
    if (publishedAt !== undefined) row.publishedAt = publishedAt;
    row.updatedAt = new Date();
    return { ...row };
  }

  async setCover(id: string, coverUrl: string | null): Promise<Game> {
    const row = this.games.get(id);
    if (!row) throw new Error('NOT_FOUND');
    row.coverUrl = coverUrl;
    row.updatedAt = new Date();
    return { ...row };
  }

  async deleteGame(id: string): Promise<void> {
    this.games.delete(id);
    for (const [key, s] of this.screenshots) if (s.gameId === id) this.screenshots.delete(key);
    for (const [key, r] of this.releases) if (r.gameId === id) this.releases.delete(key);
    for (const [key, a] of this.achievements) if (a.gameId === id) this.achievements.delete(key);
    for (const [key, c] of this.comments) if (c.gameId === id) this.comments.delete(key);
    for (const [key, b] of this.bugReports) if (b.gameId === id) this.bugReports.delete(key);
  }

  async gameStats(id: string): Promise<GameStats> {
    const row = this.games.get(id);
    if (!row) throw new Error('NOT_FOUND');
    const comments = [...this.comments.values()].filter((c) => c.gameId === id);
    const bugs = Object.fromEntries(
      BUG_REPORT_STATUSES.map((status) => [
        status,
        [...this.bugReports.values()].filter((b) => b.gameId === id && b.status === status).length,
      ]),
    ) as Record<BugReportStatus, number>;

    return {
      gameId: row.id,
      slug: row.slug,
      title: row.title,
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      score: row.upvotes - row.downvotes,
      playCount: row.playCount,
      viewCount: row.viewCount,
      comments: {
        visible: comments.filter((c) => !c.hidden).length,
        hidden: comments.filter((c) => c.hidden).length,
      },
      bugs,
      status: row.status,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Screenshots                                                        */
  /* ------------------------------------------------------------------ */

  async listScreenshots(gameId: string): Promise<Screenshot[]> {
    return [...this.screenshots.values()]
      .filter((s) => s.gameId === gameId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({ ...s }));
  }

  async addScreenshot(
    gameId: string,
    input: Pick<Screenshot, 'url' | 'blobPath' | 'alt'>,
  ): Promise<Screenshot> {
    const existing = await this.listScreenshots(gameId);
    const shot: Screenshot = {
      id: randomUUID(),
      gameId,
      url: input.url,
      blobPath: input.blobPath,
      alt: input.alt,
      sortOrder: existing.length,
    };
    this.screenshots.set(shot.id, shot);
    return { ...shot };
  }

  async findScreenshot(id: string): Promise<Screenshot | null> {
    const row = this.screenshots.get(id);
    return row ? { ...row } : null;
  }

  async removeScreenshot(id: string): Promise<void> {
    this.screenshots.delete(id);
  }

  async reorderScreenshots(gameId: string, ids: string[]): Promise<Screenshot[]> {
    const current = await this.listScreenshots(gameId);
    // Named ids come first in the order given; the rest keep their relative
    // order at the end, and unknown ids are ignored.
    const named = ids
      .map((id) => current.find((s) => s.id === id))
      .filter((s): s is Screenshot => Boolean(s));
    const rest = current.filter((s) => !named.some((n) => n.id === s.id));
    [...named, ...rest].forEach((shot, index) => {
      const row = this.screenshots.get(shot.id);
      if (row) row.sortOrder = index;
    });
    return this.listScreenshots(gameId);
  }

  /* ------------------------------------------------------------------ */
  /*  Changelog                                                          */
  /* ------------------------------------------------------------------ */

  async listReleases(gameId: string, limit?: number): Promise<Release[]> {
    // Ordered by the clock, never by version: version labels are free text, so
    // only the clock knows what is newer.
    const rows = [...this.releases.values()]
      .filter((r) => r.gameId === gameId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return (limit ? rows.slice(0, limit) : rows).map((r) => ({ ...r }));
  }

  async findRelease(id: string): Promise<Release | null> {
    const row = this.releases.get(id);
    return row ? { ...row } : null;
  }

  async addRelease(
    gameId: string,
    input: Pick<Release, 'authorId' | 'personaId' | 'version' | 'body' | 'buildUrl' | 'buildBytes'>,
  ): Promise<Release> {
    if (input.version) {
      const clash = [...this.releases.values()].some(
        (r) => r.gameId === gameId && r.version?.toLowerCase() === input.version!.toLowerCase(),
      );
      if (clash) throw new Error('VERSION_TAKEN');
    }
    const now = new Date();
    const release: Release = { id: randomUUID(), gameId, ...input, createdAt: now, updatedAt: now };
    this.releases.set(release.id, release);
    return { ...release };
  }

  async updateRelease(id: string, patch: Partial<Pick<Release, 'version' | 'body'>>): Promise<Release> {
    const row = this.releases.get(id);
    if (!row) throw new Error('NOT_FOUND');
    if (patch.version !== undefined) row.version = patch.version || null;
    if (patch.body !== undefined) row.body = patch.body;
    row.updatedAt = new Date();
    return { ...row };
  }

  async deleteRelease(id: string): Promise<void> {
    this.releases.delete(id);
  }

  /* ------------------------------------------------------------------ */
  /*  Achievements                                                       */
  /* ------------------------------------------------------------------ */

  async listAchievements(gameId: string): Promise<Achievement[]> {
    return [...this.achievements.values()]
      .filter((a) => a.gameId === gameId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug))
      .map((a) => ({ ...a }));
  }

  async upsertAchievement(gameId: string, input: AchievementInput): Promise<Achievement> {
    const existing = [...this.achievements.values()].find(
      (a) => a.gameId === gameId && a.slug === input.slug,
    );
    if (existing) {
      // Re-declaring a badge never resets how many players have earned it —
      // that is what makes a publish script safe to run twice.
      Object.assign(existing, input);
      return { ...existing };
    }
    const row: Achievement = { id: randomUUID(), gameId, unlockCount: 0, ...input };
    this.achievements.set(row.id, row);
    return { ...row };
  }

  async updateAchievement(
    gameId: string,
    slug: string,
    patch: Partial<Omit<AchievementInput, 'slug'>>,
  ): Promise<Achievement | null> {
    const row = [...this.achievements.values()].find((a) => a.gameId === gameId && a.slug === slug);
    if (!row) return null;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (row as unknown as Record<string, unknown>)[key] = value;
    }
    return { ...row };
  }

  async deleteAchievement(gameId: string, slug: string): Promise<boolean> {
    const row = [...this.achievements.values()].find((a) => a.gameId === gameId && a.slug === slug);
    if (!row) return false;
    // In Postgres this cascade deletes every unlock anyone earned for the badge.
    this.achievements.delete(row.id);
    return true;
  }

  async reorderAchievements(gameId: string, slugs: string[]): Promise<void> {
    const current = await this.listAchievements(gameId);
    const named = slugs
      .map((slug) => current.find((a) => a.slug === slug))
      .filter((a): a is Achievement => Boolean(a));
    const rest = current.filter((a) => !named.some((n) => n.slug === a.slug));
    [...named, ...rest].forEach((item, index) => {
      const row = this.achievements.get(item.id);
      if (row) row.sortOrder = index;
    });
  }

  async getArcadeSettings(gameId: string): Promise<ArcadeSettings> {
    // Created lazily and coalesced against the defaults on read.
    return this.arcadeSettings.get(gameId) ?? { gameId, scoreSort: 'desc', scoreLabel: 'Score' };
  }

  async setArcadeSettings(
    gameId: string,
    patch: Omit<ArcadeSettings, 'gameId'>,
  ): Promise<ArcadeSettings> {
    const next: ArcadeSettings = { gameId, ...patch };
    this.arcadeSettings.set(gameId, next);
    return { ...next };
  }

  /* ------------------------------------------------------------------ */
  /*  Social                                                             */
  /* ------------------------------------------------------------------ */

  async castVote(userId: string, gameId: string, value: -1 | 0 | 1): Promise<Game> {
    const game = this.games.get(gameId);
    if (!game) throw new Error('NOT_FOUND');
    const key = `${userId}:${gameId}`;
    const previous = this.votes.get(key)?.value ?? 0;

    // Keyed on the account, so switching a vote moves it rather than adding one.
    if (previous === 1) game.upvotes -= 1;
    if (previous === -1) game.downvotes -= 1;
    if (value === 1) game.upvotes += 1;
    if (value === -1) game.downvotes += 1;

    if (value === 0) this.votes.delete(key);
    else this.votes.set(key, { userId, gameId, value });

    return { ...game };
  }

  async findVote(userId: string, gameId: string): Promise<Vote | null> {
    return this.votes.get(`${userId}:${gameId}`) ?? null;
  }

  async listComments(
    gameId: string,
    options: { page: number; perPage: number; includeHidden: boolean },
  ): Promise<Page<Comment>> {
    const rows = [...this.comments.values()]
      .filter((c) => c.gameId === gameId)
      .filter((c) => options.includeHidden || !c.hidden)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const start = (options.page - 1) * options.perPage;
    return {
      items: rows.slice(start, start + options.perPage).map((c) => ({ ...c })),
      total: rows.length,
      page: options.page,
      perPage: options.perPage,
      pages: Math.max(1, Math.ceil(rows.length / options.perPage)),
    };
  }

  async addComment(
    input: Pick<Comment, 'gameId' | 'userId' | 'personaId' | 'parentId' | 'body'>,
  ): Promise<Comment> {
    // Threading is one level deep: a reply to a reply attaches to the same root.
    let parentId = input.parentId;
    if (parentId) {
      const parent = this.comments.get(parentId);
      parentId = parent?.parentId ?? parentId;
    }
    const row: Comment = {
      id: randomUUID(),
      ...input,
      parentId,
      hidden: false,
      createdAt: new Date(),
      editedAt: null,
    };
    this.comments.set(row.id, row);
    return { ...row };
  }

  async findComment(id: string): Promise<Comment | null> {
    const row = this.comments.get(id);
    return row ? { ...row } : null;
  }

  async listBugReports(
    gameId: string,
    options: { page: number; perPage: number; status?: BugReportStatus },
  ): Promise<Page<BugReport>> {
    const rank: Record<BugReportStatus, number> = { open: 0, acknowledged: 1, fixed: 2, wontfix: 3 };
    const rows = [...this.bugReports.values()]
      .filter((b) => b.gameId === gameId)
      .filter((b) => !options.status || b.status === options.status)
      .sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt.getTime() - a.createdAt.getTime());
    const start = (options.page - 1) * options.perPage;
    return {
      items: rows.slice(start, start + options.perPage).map((b) => ({ ...b })),
      total: rows.length,
      page: options.page,
      perPage: options.perPage,
      pages: Math.max(1, Math.ceil(rows.length / options.perPage)),
    };
  }

  async addBugReport(
    input: Pick<BugReport, 'gameId' | 'reporterId' | 'personaId' | 'title' | 'body'>,
  ): Promise<BugReport> {
    const now = new Date();
    const row: BugReport = { id: randomUUID(), ...input, status: 'open', createdAt: now, updatedAt: now };
    this.bugReports.set(row.id, row);
    return { ...row };
  }

  async setBugReportStatus(id: string, status: BugReportStatus): Promise<BugReport | null> {
    const row = this.bugReports.get(id);
    if (!row) return null;
    row.status = status;
    row.updatedAt = new Date();
    return { ...row };
  }

  async addSiteFeedback(
    input: Pick<SiteFeedback, 'reporterId' | 'title' | 'body' | 'kind' | 'pageUrl'>,
  ): Promise<SiteFeedback> {
    const row: SiteFeedback = {
      id: randomUUID(),
      ...input,
      status: 'open',
      createdAt: new Date(),
    };
    this.siteFeedback.set(row.id, row);
    return { ...row };
  }
}
