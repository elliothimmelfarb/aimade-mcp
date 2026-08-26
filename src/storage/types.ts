/**
 * The storage seam.
 *
 * In production (aimade.games) these methods are Drizzle queries against Neon
 * Postgres, and `BlobStore` is Vercel Blob. Nothing above this file knows that.
 * The tool handlers speak only in the vocabulary below, which is why the same
 * ~40 tools run against an in-memory map with zero credentials — that is the
 * whole point of this repository.
 *
 * Two rules the interface encodes, because they are the ones that go wrong:
 *
 *  1. **Two identities, never confused.** `ownerId` / `userId` is the *account*:
 *     it owns things, gets rate-limited, gets banned, and casts the one vote.
 *     `personaId` is the *byline*: it is what every public surface renders.
 *     Rules key off the account; attribution keys off the persona. Rendering an
 *     account id publicly is a bug.
 *  2. **Visibility is a storage concern, not a UI one.** Every read takes a
 *     `Viewer` so a draft or a delisted game can never leak out of a query,
 *     whatever the caller forgets to filter.
 */

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

export interface Account {
  id: string;
  /** The account handle. Not a public byline — personas are. */
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'user' | 'admin';
  /** A banned account keeps every read and loses every write. */
  banned: boolean;
}

/** A public byline. One account may hold several; five is the live cap. */
export interface Persona {
  id: string;
  accountId: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  /** Exactly one persona per account carries this flag. */
  isDefault: boolean;
  createdAt: Date;
}

/** An `amg_` API key, hashed in production; stored plainly here for the demo. */
export interface ApiKey {
  id: string;
  accountId: string;
  key: string;
  name: string;
  enabled: boolean;
}

/**
 * Who is asking. Built once per request from an API key (or anonymously) and
 * threaded through every storage call.
 */
export interface Viewer {
  account: Account | null;
  /** The byline this call publishes under. Null for anonymous callers. */
  persona: Persona | null;
  isAdmin: boolean;
  /** False for anonymous and for banned accounts. */
  canWrite: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

export interface Category {
  slug: string;
  name: string;
  emoji: string;
  description: string;
  sortOrder: number;
}

export type PlayMode = 'external' | 'embed' | 'hosted';
export type GameStatus = 'draft' | 'published' | 'delisted';

export interface Game {
  id: string;
  /** Minted from the title on create and never changed: links outlive titles. */
  slug: string;
  title: string;
  tagline: string;
  description: string;
  ownerId: string;
  personaId: string;
  categorySlug: string;
  tags: string[];
  aiTools: string[];
  playMode: PlayMode;
  playUrl: string;
  embedUrl: string;
  /** Storage path of the hosted single-file build, when there is one. */
  hostedPath: string | null;
  coverUrl: string | null;
  status: GameStatus;
  upvotes: number;
  downvotes: number;
  playCount: number;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** Set by the first publish and never moved, so a re-publish cannot fake "new". */
  publishedAt: Date | null;
}

export interface Screenshot {
  id: string;
  gameId: string;
  url: string;
  blobPath: string | null;
  alt: string;
  sortOrder: number;
}

/** A changelog entry. Ordered by the clock — version labels are free text. */
export interface Release {
  id: string;
  gameId: string;
  authorId: string;
  personaId: string;
  version: string | null;
  body: string;
  buildUrl: string | null;
  buildBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A maker-owned achievement definition. Games unlock these slugs; they can
 * never mint one — an unknown slug is NOT_FOUND, never an implicit insert.
 */
export interface Achievement {
  id: string;
  gameId: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  iconUrl: string | null;
  hidden: boolean;
  points: number;
  sortOrder: number;
  unlockCount: number;
}

/**
 * Leaderboard direction lives here rather than in a score payload, so a game
 * cannot redefine what its own board means halfway through a season.
 */
export interface ArcadeSettings {
  gameId: string;
  scoreSort: 'desc' | 'asc';
  scoreLabel: string;
}

/* -------------------------------------------------------------------------- */
/*  Social                                                                     */
/* -------------------------------------------------------------------------- */

export interface Comment {
  id: string;
  gameId: string;
  /** The account — one comment, one author, for moderation and rate limits. */
  userId: string;
  /** The byline the comment is signed with. */
  personaId: string;
  /** Threading is one level deep: a reply to a reply attaches to the same root. */
  parentId: string | null;
  body: string;
  hidden: boolean;
  createdAt: Date;
  editedAt: Date | null;
}

export const BUG_REPORT_STATUSES = ['open', 'acknowledged', 'fixed', 'wontfix'] as const;
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number];

export interface BugReport {
  id: string;
  gameId: string;
  reporterId: string;
  personaId: string;
  title: string;
  body: string;
  status: BugReportStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** One vote per **account** per game, no matter how many personas it holds. */
export interface Vote {
  userId: string;
  gameId: string;
  value: -1 | 0 | 1;
}

export type SiteFeedbackKind = 'bug' | 'idea' | 'other';

export interface SiteFeedback {
  id: string;
  reporterId: string;
  title: string;
  body: string;
  kind: SiteFeedbackKind;
  pageUrl: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: Date;
}

/* -------------------------------------------------------------------------- */
/*  Query options                                                              */
/* -------------------------------------------------------------------------- */

export type GameSort = 'hot' | 'top' | 'new';

export interface ListGamesOptions {
  search?: string;
  category?: string;
  tag?: string;
  sort?: GameSort;
  page?: number;
  perPage?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}

export interface GameCreateInput {
  title: string;
  tagline: string;
  description: string;
  categorySlug: string;
  tags: string[];
  aiTools: string[];
  playMode: PlayMode;
  playUrl: string;
  embedUrl: string;
  coverUrl: string;
}

/** A genuine partial update: an omitted key keeps its stored value. */
export type GameUpdateInput = Partial<
  GameCreateInput & { hostedPath: string | null; personaId: string }
>;

export type AchievementInput = Omit<Achievement, 'id' | 'gameId' | 'unlockCount'>;

export interface GameStats {
  gameId: string;
  slug: string;
  title: string;
  upvotes: number;
  downvotes: number;
  score: number;
  playCount: number;
  viewCount: number;
  comments: { visible: number; hidden: number };
  bugs: Record<BugReportStatus, number>;
  status: GameStatus;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/*  Blobs                                                                      */
/* -------------------------------------------------------------------------- */

export interface StoredBlob {
  url: string;
  path: string;
  bytes: number;
  contentType: string;
}

/**
 * Where uploaded bytes go. Vercel Blob in production; a Map here.
 *
 * Validation (magic bytes, size caps, https-only remote fetches) happens *above*
 * this interface, in `src/media.ts`, so a different backend cannot accidentally
 * ship without it.
 */
export interface BlobStore {
  put(path: string, data: Uint8Array, contentType: string): Promise<StoredBlob>;
  delete(path: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  The storage interface                                                      */
/* -------------------------------------------------------------------------- */

export interface Storage {
  readonly blobs: BlobStore;

  /* -- identity -- */
  /** Resolve a bearer token to a key row. Null means "no such key". */
  findApiKey(token: string): Promise<ApiKey | null>;
  findAccount(id: string): Promise<Account | null>;
  updateAccount(id: string, patch: Partial<Pick<Account, 'displayName' | 'avatarUrl'>>): Promise<Account>;

  /* -- personas -- */
  listPersonas(accountId: string): Promise<Persona[]>;
  findPersona(id: string): Promise<Persona | null>;
  /** By id or username, scoped to one account. */
  findOwnPersona(accountId: string, ref: string): Promise<Persona | null>;
  /** Usernames share one namespace with every persona and account on the site. */
  isUsernameTaken(username: string): Promise<boolean>;
  createPersona(
    accountId: string,
    input: Pick<Persona, 'username' | 'displayName' | 'bio' | 'avatarUrl'>,
  ): Promise<Persona>;
  updatePersona(
    id: string,
    patch: Partial<Pick<Persona, 'username' | 'displayName' | 'bio' | 'avatarUrl'>>,
  ): Promise<Persona>;
  setDefaultPersona(accountId: string, personaId: string): Promise<Persona>;

  /* -- categories -- */
  listCategories(): Promise<Category[]>;
  findCategory(slug: string): Promise<Category | null>;

  /* -- games -- */
  listGames(viewer: Viewer, options: ListGamesOptions): Promise<Page<Game>>;
  listByOwner(
    viewer: Viewer,
    accountId: string,
    options: { includeUnpublished: boolean; limit: number },
  ): Promise<Game[]>;
  findGameById(viewer: Viewer, id: string): Promise<Game | null>;
  findGameBySlug(viewer: Viewer, slug: string): Promise<Game | null>;
  createGame(viewer: Viewer, input: GameCreateInput): Promise<Game>;
  updateGame(id: string, patch: GameUpdateInput): Promise<Game>;
  setGameStatus(id: string, status: GameStatus, publishedAt?: Date | null): Promise<Game>;
  setCover(id: string, coverUrl: string | null): Promise<Game>;
  deleteGame(id: string): Promise<void>;
  gameStats(id: string): Promise<GameStats>;

  /* -- screenshots -- */
  listScreenshots(gameId: string): Promise<Screenshot[]>;
  addScreenshot(
    gameId: string,
    input: Pick<Screenshot, 'url' | 'blobPath' | 'alt'>,
  ): Promise<Screenshot>;
  findScreenshot(id: string): Promise<Screenshot | null>;
  removeScreenshot(id: string): Promise<void>;
  reorderScreenshots(gameId: string, ids: string[]): Promise<Screenshot[]>;

  /* -- changelog -- */
  listReleases(gameId: string, limit?: number): Promise<Release[]>;
  findRelease(id: string): Promise<Release | null>;
  addRelease(
    gameId: string,
    input: Pick<Release, 'authorId' | 'personaId' | 'version' | 'body' | 'buildUrl' | 'buildBytes'>,
  ): Promise<Release>;
  updateRelease(id: string, patch: Partial<Pick<Release, 'version' | 'body'>>): Promise<Release>;
  deleteRelease(id: string): Promise<void>;

  /* -- achievements -- */
  listAchievements(gameId: string): Promise<Achievement[]>;
  /** Idempotent on (gameId, slug): a re-declare never resets `unlockCount`. */
  upsertAchievement(gameId: string, input: AchievementInput): Promise<Achievement>;
  updateAchievement(
    gameId: string,
    slug: string,
    patch: Partial<Omit<AchievementInput, 'slug'>>,
  ): Promise<Achievement | null>;
  /** Cascades every unlock anyone earned for it. */
  deleteAchievement(gameId: string, slug: string): Promise<boolean>;
  reorderAchievements(gameId: string, slugs: string[]): Promise<void>;
  getArcadeSettings(gameId: string): Promise<ArcadeSettings>;
  setArcadeSettings(gameId: string, patch: Omit<ArcadeSettings, 'gameId'>): Promise<ArcadeSettings>;

  /* -- social -- */
  castVote(userId: string, gameId: string, value: -1 | 0 | 1): Promise<Game>;
  findVote(userId: string, gameId: string): Promise<Vote | null>;
  listComments(
    gameId: string,
    options: { page: number; perPage: number; includeHidden: boolean },
  ): Promise<Page<Comment>>;
  addComment(
    input: Pick<Comment, 'gameId' | 'userId' | 'personaId' | 'parentId' | 'body'>,
  ): Promise<Comment>;
  findComment(id: string): Promise<Comment | null>;
  listBugReports(
    gameId: string,
    options: { page: number; perPage: number; status?: BugReportStatus },
  ): Promise<Page<BugReport>>;
  addBugReport(
    input: Pick<BugReport, 'gameId' | 'reporterId' | 'personaId' | 'title' | 'body'>,
  ): Promise<BugReport>;
  setBugReportStatus(id: string, status: BugReportStatus): Promise<BugReport | null>;
  addSiteFeedback(
    input: Pick<SiteFeedback, 'reporterId' | 'title' | 'body' | 'kind' | 'pageUrl'>,
  ): Promise<SiteFeedback>;
}
