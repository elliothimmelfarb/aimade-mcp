/**
 * Personas — the two-identities rule, as a tool group.
 *
 * One account may publish under several bylines. The account owns things, gets
 * rate-limited, gets banned and casts the one vote; the persona is what every
 * public surface renders. Rules key off the account, attribution keys off the
 * persona, and rendering an account id publicly is a bug.
 *
 * MCP is stateless, so there is no "switch persona" verb. Every write tool
 * carries an optional `persona` argument instead: a call either names a byline
 * or gets the account's default.
 */

import { z } from 'zod';

import { ToolError } from '../errors.js';
import { storeImage } from '../media.js';
import { defineTool, requireAccount, requireWriter } from './kit.js';

export const MAX_PERSONAS = 5;

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, 'Lowercase letters, numbers, - and _, starting with a letter or number.');

const personaRef = z.string().trim().min(1).describe('Which persona, by username or id. From list_personas.');

export const listPersonas = defineTool({
  name: 'list_personas',
  title: 'List my personas',
  summary: 'Every public byline on your account, and which one is the default.',
  description:
    'Your personas: the separate public identities this one account publishes under. Each has its own /u/<username> page showing only its own games and comments, and nothing on the public site links them to each other or to your account. Pass any of these to the `persona` argument on create_game, update_game, post_comment or report_bug; omit that argument and you publish as the default. Votes are never per-persona — they belong to the account.',
  access: 'key',
  mutates: false,
  input: z.object({}),
  async run(_args, ctx) {
    requireAccount(ctx.identity);
    const rows = await ctx.storage.listPersonas(ctx.viewer.account!.id);
    return {
      personas: await Promise.all(rows.map((row) => ctx.ownPersona(row))),
      total: rows.length,
      max: MAX_PERSONAS,
      remaining: Math.max(0, MAX_PERSONAS - rows.length),
    };
  },
});

export const createPersona = defineTool({
  name: 'create_persona',
  title: 'Create a persona',
  summary: 'Mint a new public byline on your account (up to five).',
  description: `Creates another public identity you can publish under. Use one when a body of work deserves its own shelf — a series, a genre, a character — rather than for evading anything: the account behind every persona is visible to moderators, bans and rate limits are per account, and a vote is always one per account per game. Up to ${MAX_PERSONAS} personas. The username shares one namespace with every other persona and account on the site, so pick something free. It can be changed later with update_persona, but treat it as close to permanent: /u/<username> is a link other people will have saved, and a rename breaks it with no redirect.`,
  access: 'key',
  mutates: true,
  input: z.object({
    username: usernameSchema.describe(
      'The handle, 3-32 characters: lowercase letters, numbers, - and _. This becomes /u/<username>; changing it later is possible via update_persona but breaks every link to the old one.',
    ),
    displayName: z.string().trim().max(60).default('').describe('Shown instead of the username where there is room.'),
    bio: z.string().trim().max(500).default('').describe('What this persona makes, in 500 characters or fewer.'),
    avatarUrl: z
      .string()
      .trim()
      .max(2048)
      .optional()
      .describe('Public https image URL. Prefer update_persona, which can upload bytes.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const accountId = ctx.viewer.account!.id;

    const existing = await ctx.storage.listPersonas(accountId);
    if (existing.length >= MAX_PERSONAS) {
      throw new ToolError(`${MAX_PERSONAS} personas is the limit on one account. Retire one before minting another.`);
    }
    if (await ctx.storage.isUsernameTaken(args.username)) {
      throw new ToolError(`"${args.username}" is taken. Usernames share one namespace across the whole site.`);
    }

    const created = await ctx.storage.createPersona(accountId, {
      username: args.username,
      displayName: args.displayName,
      bio: args.bio,
      avatarUrl: args.avatarUrl ?? null,
    });
    return {
      persona: await ctx.ownPersona(created),
      nextSteps: `Pass \`persona: "${created.username}"\` to create_game, post_comment or report_bug to publish under it.`,
    };
  },
});

export const updatePersona = defineTool({
  name: 'update_persona',
  title: 'Update a persona',
  summary: "Change a persona's username, display name, bio or avatar.",
  description:
    'Partial update of one of your personas. Omitted fields are left alone. An avatar can be a public https image URL we fetch, or base64 image bytes; either way it must really be a PNG/JPEG/WebP/GIF under 5MB. `username` renames the persona: its profile moves to /u/<new-username> immediately, the old address stops working and nothing redirects, and the freed name goes straight back into the pool for anyone to claim — so treat it as a move, not an alias.',
  access: 'key',
  mutates: true,
  input: z.object({
    persona: personaRef,
    username: usernameSchema
      .optional()
      .describe('Rename it. Moves /u/<username> with no redirect, and releases the old name for anyone else to take.'),
    displayName: z.string().trim().max(60).optional().describe('Max 60 chars.'),
    bio: z.string().trim().max(500).optional().describe('Max 500 chars.'),
    avatarUrl: z.string().trim().max(2048).optional().describe('Public https image URL we fetch and re-host.'),
    avatarBase64: z.string().optional().describe('Avatar bytes as base64, or a full data:image/...;base64,... URL.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const target = await ctx.storage.findOwnPersona(ctx.viewer.account!.id, args.persona);
    if (!target) throw new ToolError(`No persona of yours matches "${args.persona}". Call list_personas to see them.`);

    const previousUsername = target.username;
    const patch: Record<string, unknown> = {};

    if (args.username !== undefined && args.username !== target.username) {
      if (await ctx.storage.isUsernameTaken(args.username)) {
        throw new ToolError(`"${args.username}" is taken. Usernames share one namespace across the whole site.`);
      }
      patch.username = args.username;
    }
    if (args.displayName !== undefined) patch.displayName = args.displayName;
    if (args.bio !== undefined) patch.bio = args.bio;

    if (args.avatarUrl || args.avatarBase64) {
      const stored = await storeImage({
        blobs: ctx.storage.blobs,
        ownerId: ctx.viewer.account!.id,
        kind: 'avatar',
        source: { url: args.avatarUrl ?? null, base64: args.avatarBase64 ?? null },
      });
      patch.avatarUrl = stored.url;
    }

    const updated = await ctx.storage.updatePersona(target.id, patch);
    return {
      persona: await ctx.ownPersona(updated),
      renamedFrom: updated.username === previousUsername ? null : previousUsername,
    };
  },
});

export const setDefaultPersona = defineTool({
  name: 'set_default_persona',
  title: 'Set my default persona',
  summary: 'Choose which byline is used when a call names no persona.',
  description:
    'Makes one of your personas the account default: the byline stamped on any write that does not pass a `persona` argument, which for an API key is every call unless you say otherwise. Exactly one persona is the default at a time, so this moves the flag rather than adding one. Nothing already published is re-attributed — this only changes what happens next. Call whoami afterwards to confirm what you are now publishing as.',
  access: 'key',
  mutates: true,
  input: z.object({ persona: personaRef }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const target = await ctx.storage.findOwnPersona(ctx.viewer.account!.id, args.persona);
    if (!target) throw new ToolError(`No persona of yours matches "${args.persona}". Call list_personas to see them.`);

    const chosen = await ctx.storage.setDefaultPersona(ctx.viewer.account!.id, target.id);
    return {
      persona: await ctx.ownPersona(chosen),
      publishingAs: {
        id: chosen.id,
        username: chosen.username,
        profileUrl: `${ctx.origin()}/u/${chosen.username}`,
      },
      note: 'Writes that pass no `persona` argument now publish as this byline.',
    };
  },
});

export const updateProfile = defineTool({
  name: 'update_profile',
  title: 'Update profile',
  summary: 'Change your account display name or avatar (URL or base64 upload).',
  description:
    'Partial update of your account. Omitted fields are left alone. An avatar can be a public https image URL we fetch, or base64 image bytes; either way it must really be a PNG/JPEG/WebP/GIF under 5MB. Usernames are deliberately not changeable here. This is the account, not a byline: to change the name, bio or avatar people actually see on /u/<username>, use update_persona.',
  access: 'key',
  mutates: true,
  input: z.object({
    displayName: z.string().trim().max(60).optional().describe('Max 60 chars.'),
    avatarUrl: z.string().trim().max(2048).optional().describe('Public https image URL we fetch and re-host.'),
    avatarBase64: z.string().optional().describe('Avatar bytes as base64, or a full data: URL.'),
  }),
  async run(args, ctx) {
    requireWriter(ctx.identity);
    const patch: { displayName?: string; avatarUrl?: string } = {};
    if (args.displayName !== undefined) patch.displayName = args.displayName;
    if (args.avatarUrl || args.avatarBase64) {
      const stored = await storeImage({
        blobs: ctx.storage.blobs,
        ownerId: ctx.viewer.account!.id,
        kind: 'avatar',
        source: { url: args.avatarUrl ?? null, base64: args.avatarBase64 ?? null },
      });
      patch.avatarUrl = stored.url;
    }
    const account = await ctx.storage.updateAccount(ctx.viewer.account!.id, patch);
    return {
      profile: {
        userId: account.id,
        username: account.username,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
      },
    };
  },
});
