/**
 * The publish flow, end to end, as a real MCP client.
 *
 *   npm run demo
 *
 * This spawns `src/index.ts` over stdio, connects an MCP client to it, and
 * walks the six calls that take a game from nothing to published:
 *
 *   create_game → upload_game_build → define_achievements
 *              → add_screenshot → set_cover → publish_game
 *
 * Everything lands in the in-memory store, so it runs with no credentials and
 * no network. Against the live instance the same six calls, in the same order,
 * put a real game on https://aimade.games — only the transport and the key
 * differ.
 */

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/* -------------------------------------------------------------------------- */
/*  Fixtures — a real (tiny) game and a real (tiny) PNG                        */
/* -------------------------------------------------------------------------- */

const GAME_HTML = `<!doctype html>
<meta charset="utf-8" />
<title>Orbital Drift</title>
<h1>Orbital Drift</h1>
<p id="out">Loading…</p>
<script src="https://aimade.games/arcade.js"></script>
<script>
Arcade.ready().then(async function (arcade) {
  document.getElementById('out').textContent =
    'Hello, ' + (arcade.player.username || 'guest');
  await arcade.scores.submit(1200, { run: 1 });
  await arcade.achievements.unlock('first-orbit');
});
</script>`;

/** A 1×1 transparent PNG. Small enough to inline, real enough to pass sniffing. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

async function main(): Promise<void> {
  const client = new Client({ name: 'publish-flow-demo', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', SERVER],
    stderr: 'inherit',
  });

  await client.connect(transport);

  const { tools } = await client.listTools();
  say(`Connected. The server offers ${tools.length} tools.`);

  /** Call a tool and fail loudly — a demo that swallows an error teaches nothing. */
  const call = async (name: string, args: Json = {}): Promise<Json> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    const payload = JSON.parse(result.content[0]?.text ?? 'null') as Json;
    if (result.isError) {
      throw new Error(`${name} failed — ${String(payload.message ?? 'unknown error')}`);
    }
    return payload;
  };

  /* -- 0. who am I, and what can I file this under? ------------------------ */

  const me = await call('whoami');
  say(`Publishing as "${(me.publishingAs as Json)?.username}".`);

  const categories = (await call('list_categories')).categories as Array<{ slug: string }>;
  const category = categories[0]!.slug;
  say(`Filing under "${category}".`);

  /* -- 1. create_game — always a draft ------------------------------------ */

  const created = await call('create_game', {
    title: 'Orbital Drift',
    tagline: 'Slingshot around a dying star and try not to fall in.',
    description: '# Orbital Drift\n\nOne button. Gravity does the rest.',
    categorySlug: category,
    tags: ['space', 'one-button', 'score-attack'],
    aiTools: ['Claude Code'],
  });
  const game = created.game as Json;
  const slug = game.slug as string;
  say(`1. create_game → "${slug}" (status: ${String(game.status)})`);

  /* -- 2. upload_game_build — one self-contained HTML file ---------------- */

  const built = await call('upload_game_build', {
    game: slug,
    base64: Buffer.from(GAME_HTML, 'utf8').toString('base64'),
  });
  const build = built.build as Json;
  say(`2. upload_game_build → ${String(build.bytes)} bytes, playMode "${String((built.game as Json).playMode)}"`);

  /* -- 3. define_achievements — the slugs the build unlocks --------------- */

  const badges = await call('define_achievements', {
    game: slug,
    achievements: [
      { slug: 'first-orbit', name: 'First Orbit', description: 'Complete one full orbit.', emoji: '🛰️', points: 10 },
      { slug: 'close-pass', name: 'Close Pass', description: 'Graze the star without burning up.', emoji: '☄️', points: 25 },
      { slug: 'event-horizon', name: 'Event Horizon', description: 'Escape after crossing the inner ring.', emoji: '🕳️', points: 50, hidden: true },
    ],
  });
  say(`3. define_achievements → ${String(badges.defined)} badges declared`);

  // Idempotent on (game, slug): running a publish script twice changes nothing.
  const again = await call('define_achievements', {
    game: slug,
    achievements: [{ slug: 'first-orbit', name: 'First Orbit', description: 'Complete one full orbit.', emoji: '🛰️', points: 10 }],
  });
  const total = (await call('list_achievements', { game: slug })).total;
  say(`   re-declared ${String(again.defined)} → still ${String(total)} total (idempotent)`);

  /* -- 4. add_screenshot --------------------------------------------------- */

  const shot = await call('add_screenshot', {
    game: slug,
    base64: PNG_BASE64,
    alt: 'The ship arcing past a red giant, trail glowing.',
  });
  const screenshotId = (shot.screenshot as Json).id as string;
  say(`4. add_screenshot → ${screenshotId}`);

  /* -- 5. set_cover — promote the screenshot we already have -------------- */

  const cover = await call('set_cover', { game: slug, screenshotId });
  say(`5. set_cover → ${String(cover.coverUrl)}`);

  /* -- 6. publish_game — validates the whole stored record ---------------- */

  const published = await call('publish_game', { game: slug });
  say(`6. publish_game → ${String(published.url)} (published ${String(published.publishedAt)})`);

  /* -- and then: it is a public game -------------------------------------- */

  const found = (await call('search_games', { query: 'orbital' })).items as Json[];
  say(`\nsearch_games("orbital") finds ${found.length}: ${found.map((g) => g.title).join(', ')}`);

  const shipped = await call('upload_game_build', {
    game: slug,
    base64: Buffer.from(GAME_HTML.replace('1200', '1500'), 'utf8').toString('base64'),
    changelog: '- Scores now reflect the full slingshot bonus.\n- Fixed the ship clipping through the inner ring.',
  });
  say(`re-push with a changelog → ${String((shipped.release as Json)?.version)}`);

  const stats = await call('game_stats', { game: slug });
  say(`game_stats → ${String(stats.upvotes)} up / ${String(stats.downvotes)} down, status ${String(stats.status)}`);

  say('\nDone. Nothing was written outside this process.');
  await client.close();
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

main().catch((err) => {
  process.stderr.write(`demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
