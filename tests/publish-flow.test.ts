/**
 * The publish flow, and the rules it is built on.
 *
 * These go through `callTool` rather than through a transport: the pipeline
 * (auth → access → rate limit → validate → run → shape → translate) is the
 * thing under test, and a transport would only add spawn time.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { ArcadeMcpServer, parseToolResult, type ToolResult } from '../src/server.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { TOOLS } from '../src/tools/index.js';

const KEY = 'amg_test_key';
const OTHER_KEY = 'amg_other_key';

const GAME_HTML = '<!doctype html><meta charset="utf-8"><title>T</title><script>1</script>';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type Json = Record<string, any>;

let storage: MemoryStorage;
let server: ArcadeMcpServer;

function ok(result: ToolResult): Json {
  const payload = parseToolResult<Json>(result);
  if (result.isError) throw new Error(`expected success, got: ${String(payload.message)}`);
  return payload;
}

function err(result: ToolResult): Json {
  const payload = parseToolResult<Json>(result);
  expect(result.isError, `expected an error, got: ${JSON.stringify(payload)}`).toBe(true);
  return payload;
}

const call = (name: string, args: Json = {}, token: string | null = KEY) =>
  server.callTool(name, args, { token, clientAddress: 'test' });

beforeEach(() => {
  storage = new MemoryStorage({ apiKey: KEY, username: 'maker' });
  storage.seedAccount(OTHER_KEY, 'somebody-else');
  server = new ArcadeMcpServer({ storage, siteUrl: 'https://aimade.games' });
});

/* -------------------------------------------------------------------------- */

describe('the registry', () => {
  it('has unique tool names and a description on every tool', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOLS) {
      expect(tool.description.length, `${tool.name} needs a description`).toBeGreaterThan(40);
      expect(tool.summary.length, `${tool.name} needs a summary`).toBeGreaterThan(10);
    }
  });

  it('marks every mutating tool as such, and no read tool', () => {
    const mutating = TOOLS.filter((t) => t.mutates).map((t) => t.name);
    expect(mutating).toContain('create_game');
    expect(mutating).toContain('publish_game');
    expect(mutating).not.toContain('search_games');
    expect(mutating).not.toContain('whoami');
  });
});

describe('auth', () => {
  it('serves public tools with no key at all', async () => {
    const payload = ok(await call('list_categories', {}, null));
    expect(payload.categories.length).toBeGreaterThan(0);
  });

  it('refuses a keyed tool with no key, and says how to get one', async () => {
    const payload = err(await call('create_game', { title: 'Nope' }, null));
    expect(payload.error).toBe('authentication_required');
    expect(payload.message).toContain('/settings');
  });

  it('refuses a key it does not recognise rather than silently going anonymous', async () => {
    const payload = err(await call('whoami', {}, 'amg_not_a_key'));
    expect(payload.error).toBe('invalid_token');
  });

  it('lets a banned account read and refuses its writes', async () => {
    const banned = storage.seedAccount('amg_banned', 'banned-one', { banned: true });
    expect(banned.account.banned).toBe(true);

    ok(await call('whoami', {}, 'amg_banned'));
    const payload = err(await call('create_game', { title: 'Still Trying' }, 'amg_banned'));
    expect(payload.message).toContain('banned');
  });
});

describe('the publish flow', () => {
  /** create_game → upload_game_build → define_achievements → add_screenshot → set_cover → publish_game */
  async function publishOne(title = 'Orbital Drift') {
    const category = (ok(await call('list_categories')).categories as Json[])[0]!.slug as string;

    const created = ok(
      await call('create_game', {
        title,
        tagline: 'Slingshot around a dying star.',
        categorySlug: category,
        tags: ['space', 'one-button'],
        aiTools: ['Claude Code'],
      }),
    );
    const slug = created.game.slug as string;

    await call('upload_game_build', {
      game: slug,
      base64: Buffer.from(GAME_HTML, 'utf8').toString('base64'),
    });
    await call('define_achievements', {
      game: slug,
      achievements: [
        { slug: 'first-orbit', name: 'First Orbit' },
        { slug: 'close-pass', name: 'Close Pass', points: 25 },
      ],
    });
    const shot = ok(await call('add_screenshot', { game: slug, base64: PNG_BASE64, alt: 'The ship.' }));
    await call('set_cover', { game: slug, screenshotId: shot.screenshot.id });
    const published = ok(await call('publish_game', { game: slug }));
    return { slug, published, created };
  }

  it('walks the six calls and puts a game in public search', async () => {
    const { slug, published } = await publishOne();

    expect(published.game.status).toBe('published');
    expect(published.url).toBe(`https://aimade.games/g/${slug}`);
    expect(published.publishedAt).toBeTruthy();

    const found = ok(await call('search_games', { query: 'orbital' }, null));
    expect(found.items.map((g: Json) => g.slug)).toContain(slug);
  });

  it('lands as a draft, invisible to the public, until publish_game', async () => {
    const category = (ok(await call('list_categories')).categories as Json[])[0]!.slug as string;
    const created = ok(await call('create_game', { title: 'Secret Thing', categorySlug: category }));
    expect(created.game.status).toBe('draft');

    // Its owner can read it…
    ok(await call('get_game', { game: created.game.slug }));
    // …and nobody else can, not even by exact slug.
    err(await call('get_game', { game: created.game.slug }, null));
    expect(ok(await call('search_games', { query: 'secret' }, null)).items).toHaveLength(0);
  });

  it('refuses to publish an incomplete game and names everything missing', async () => {
    const created = ok(await call('create_game', { title: 'Half A Game' }));
    const refusal = err(await call('publish_game', { game: created.game.slug }));

    expect(refusal.message).toContain('tagline');
    expect(refusal.message).toContain('categorySlug');
    expect(refusal.message).toContain('playUrl');
    // And it stayed a draft.
    expect(ok(await call('get_game', { game: created.game.slug })).status).toBe('draft');
  });

  it('wires playMode "hosted" and the play URL from one upload_game_build call', async () => {
    const created = ok(await call('create_game', { title: 'Hosted Thing' }));
    const built = ok(
      await call('upload_game_build', {
        game: created.game.slug,
        base64: Buffer.from(GAME_HTML, 'utf8').toString('base64'),
      }),
    );

    expect(built.game.playMode).toBe('hosted');
    expect(built.game.playUrl).toBe(built.build.url);
    expect(built.build.bytes).toBe(Buffer.byteLength(GAME_HTML));
    // No changelog was asked for, so none was written.
    expect(built.release).toBeNull();
    expect(built.nextSteps).toContain('publish_game');
  });

  it('writes a changelog entry only when the caller asks for one', async () => {
    const { slug } = await publishOne();

    const shipped = ok(
      await call('upload_game_build', {
        game: slug,
        base64: Buffer.from(`${GAME_HTML}<!-- v2 -->`, 'utf8').toString('base64'),
        changelog: '- Fixed the inner ring clipping.',
      }),
    );
    expect(shipped.release.body).toContain('inner ring');
    expect(shipped.release.version).toBe('v1');
    expect(shipped.release.build.url).toBe(shipped.build.url);

    const log = ok(await call('list_changelog', { game: slug }, null));
    expect(log.total).toBe(1);
    expect(log.latestVersion).toBe('v1');
  });

  it('keeps the original publish date when a delisted game is re-published', async () => {
    const { slug, published } = await publishOne();
    const first = published.publishedAt;

    ok(await call('delist_game', { game: slug }));
    const again = ok(await call('publish_game', { game: slug }));
    expect(again.publishedAt).toBe(first);
  });

  it('mints a distinct slug for a second game with the same title', async () => {
    const a = await publishOne('Orbital Drift');
    const b = await publishOne('Orbital Drift');
    expect(b.slug).not.toBe(a.slug);
    expect(b.slug.startsWith('orbital-drift')).toBe(true);
  });
});

describe('achievements — makers define, games unlock', () => {
  async function draft() {
    return (ok(await call('create_game', { title: 'Badge Test' })).game as Json).slug as string;
  }

  it('is idempotent on (game, slug) so a publish script can run twice', async () => {
    const slug = await draft();
    const set = [
      { slug: 'first-orbit', name: 'First Orbit', points: 10 },
      { slug: 'close-pass', name: 'Close Pass', points: 25 },
    ];

    ok(await call('define_achievements', { game: slug, achievements: set }));
    ok(await call('define_achievements', { game: slug, achievements: set }));

    expect(ok(await call('list_achievements', { game: slug })).total).toBe(2);
  });

  it('honours array position as display order when sortOrder is left alone', async () => {
    const slug = await draft();
    ok(
      await call('define_achievements', {
        game: slug,
        achievements: [
          { slug: 'zebra', name: 'Zebra' },
          { slug: 'apple', name: 'Apple' },
        ],
      }),
    );
    const items = ok(await call('list_achievements', { game: slug })).items as Json[];
    expect(items.map((a) => a.slug)).toEqual(['zebra', 'apple']);
  });

  it('refuses to patch a slug, because a shipped build unlocks against it', async () => {
    const slug = await draft();
    ok(await call('define_achievement', { game: slug, slug: 'first-orbit', name: 'First Orbit' }));

    const updated = ok(
      await call('update_achievement', { game: slug, slug: 'first-orbit', name: 'One Lap', slugName: 'nope' }),
    );
    expect(updated.achievement.slug).toBe('first-orbit');
    expect(updated.achievement.name).toBe('One Lap');
  });

  it('rejects an unknown slug on update and delete rather than inventing one', async () => {
    const slug = await draft();
    expect(err(await call('update_achievement', { game: slug, slug: 'ghost', name: 'Ghost' })).message).toContain(
      'not an achievement',
    );
    expect(err(await call('delete_achievement', { game: slug, slug: 'ghost' })).message).toContain(
      'not an achievement',
    );
  });

  it('validates the slug format at the boundary', async () => {
    const slug = await draft();
    const refusal = err(await call('define_achievement', { game: slug, slug: 'Not A Slug', name: 'Nope' }));
    expect(refusal.message).toContain('Invalid input');
  });
});

describe('ownership and identity', () => {
  it('refuses to let one account change another account\'s game', async () => {
    const created = ok(await call('create_game', { title: 'Mine' }));

    // Another account cannot even see the draft…
    err(await call('update_game', { game: created.game.slug, title: 'Yours' }, OTHER_KEY));

    // …and cannot change it once it is public either.
    ok(await call('update_game', { game: created.game.slug, tagline: 'A tagline.', categorySlug: 'arcade', playUrl: 'https://example.com/g' }));
    ok(await call('publish_game', { game: created.game.slug }));
    const refusal = err(await call('update_game', { game: created.game.slug, title: 'Yours' }, OTHER_KEY));
    expect(refusal.message).toContain('not your game');
  });

  it('shapes the byline as a persona and never as an account id', async () => {
    const created = ok(await call('create_game', { title: 'Byline Test' }));
    const me = ok(await call('whoami'));

    expect(created.game.persona.username).toBe('maker');
    expect(created.game.personaId).not.toBe(me.userId);
    expect(JSON.stringify(created.game)).not.toContain(me.userId);
  });

  it('publishes under a named persona, and refuses one that is not yours', async () => {
    ok(await call('create_persona', { username: 'nova', displayName: 'Nova' }));
    const created = ok(await call('create_game', { title: 'Nova Game', persona: 'nova' }));
    expect(created.game.persona.username).toBe('nova');

    const refusal = err(await call('create_game', { title: 'Nope', persona: 'somebody-else' }));
    expect(refusal.message).toContain('No persona of yours');
  });

  it('gives one account one vote however many personas it holds', async () => {
    const created = ok(await call('create_game', { title: 'Vote Me', tagline: 'x', categorySlug: 'arcade', playUrl: 'https://example.com/g' }));
    ok(await call('publish_game', { game: created.game.slug }));

    ok(await call('create_persona', { username: 'alt' }));
    ok(await call('vote_game', { game: created.game.slug, value: 1 }, OTHER_KEY));
    ok(await call('vote_game', { game: created.game.slug, value: 1 }, OTHER_KEY));

    const after = ok(await call('vote_game', { game: created.game.slug, value: 1 }, OTHER_KEY));
    expect(after.votes.up).toBe(1);

    const retracted = ok(await call('vote_game', { game: created.game.slug, value: 0 }, OTHER_KEY));
    expect(retracted.votes.up).toBe(0);
  });
});

describe('destructive calls', () => {
  it('deletes a draft but delists anything that was ever published', async () => {
    const draft = ok(await call('create_game', { title: 'Just A Draft' }));
    const gone = ok(await call('delete_game', { game: draft.game.slug }));
    expect(gone.deleted).toBe(true);
    err(await call('get_game', { game: draft.game.slug }));

    const live = ok(
      await call('create_game', { title: 'Was Live', tagline: 'x', categorySlug: 'arcade', playUrl: 'https://example.com/g' }),
    );
    ok(await call('publish_game', { game: live.game.slug }));
    const kept = ok(await call('delete_game', { game: live.game.slug }));
    expect(kept.deleted).toBe(false);
    expect(kept.delisted).toBe(true);
    // Still readable by its owner.
    ok(await call('get_game', { game: live.game.slug }));
  });
});

describe('media validation', () => {
  it('refuses bytes that are not really an image, whatever they were called', async () => {
    const created = ok(await call('create_game', { title: 'Bad Image' }));
    const refusal = err(
      await call('add_screenshot', {
        game: created.game.slug,
        base64: Buffer.from('this is not a png', 'utf8').toString('base64'),
      }),
    );
    expect(refusal.message).toContain('not a PNG');
  });

  it('refuses both sources at once, and neither', async () => {
    const created = ok(await call('create_game', { title: 'Sources' }));
    expect(
      err(await call('add_screenshot', { game: created.game.slug, url: 'https://x.test/a.png', base64: PNG_BASE64 }))
        .message,
    ).toContain('exactly one');
    expect(err(await call('add_screenshot', { game: created.game.slug })).message).toContain('exactly one');
  });

  it('refuses a URL pointing inside a private network', async () => {
    const created = ok(await call('create_game', { title: 'SSRF' }));
    const refusal = err(await call('add_screenshot', { game: created.game.slug, url: 'https://127.0.0.1/a.png' }));
    expect(refusal.message).toContain('private network');
  });
});

describe('rate limiting', () => {
  it('refuses once the write window is spent, with an actionable message', async () => {
    // 60 writes an hour per key; the 61st is refused.
    for (let i = 0; i < 60; i += 1) {
      await call('create_game', { title: `Game ${i}` });
    }
    const refusal = err(await call('create_game', { title: 'One Too Many' }));
    expect(refusal.error).toBe('rate_limited');
    expect(refusal.message).toContain('per hour');

    // Reads are a separate, much larger budget.
    ok(await call('whoami'));
  });
});
