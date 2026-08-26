/**
 * Who is calling.
 *
 * The server is deliberately open to anonymous callers: an agent that has never
 * heard of the site should be able to search it and read a game page before
 * deciding whether it is worth signing up for. Everything that *changes*
 * something needs a bearer API key.
 *
 * Two decisions worth copying:
 *
 *  - **The account row is re-read on every call**, never cached in the token.
 *    That is one extra query, and it buys the invariant that a ban bites on the
 *    very next request.
 *  - **A bad key is a 401 with a sentence, not a silent demotion to anonymous.**
 *    Someone who typed their key wrong deserves to be told, rather than getting
 *    a confusing "log in first" on every write for the rest of the session.
 */

import { ToolError, NEEDS_KEY, BANNED } from './errors.js';
import type { Persona, Storage, Viewer } from './storage/types.js';

export class ApiKeyError extends Error {}

export const ANONYMOUS_VIEWER: Viewer = {
  account: null,
  persona: null,
  isAdmin: false,
  canWrite: false,
};

export interface Identity {
  viewer: Viewer;
  /** The API key id, used as the rate-limit bucket. Null for anonymous callers. */
  keyId: string | null;
}

export const ANONYMOUS_IDENTITY: Identity = { viewer: ANONYMOUS_VIEWER, keyId: null };

/** Pull the token out of an `Authorization: Bearer …` header. */
export function bearerFrom(header: string | null | undefined): string | null {
  const [scheme, ...rest] = (header ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  return rest.join(' ').trim() || null;
}

/**
 * Resolve a bearer token to an identity.
 *
 * The byline attached here is the account's *default* persona, because an API
 * key has no browser and therefore no active-persona cookie. A tool that wants
 * to publish under a different one says so per call — see `viewerPublishingAs`.
 */
export async function identityFromToken(storage: Storage, token: string): Promise<Identity> {
  const key = await storage.findApiKey(token.trim());
  if (!key) throw new ApiKeyError('That API key is not valid. Check it at https://aimade.games/settings.');
  if (!key.enabled) {
    throw new ApiKeyError('That API key has been disabled. Create a fresh one at https://aimade.games/settings.');
  }

  const account = await storage.findAccount(key.accountId);
  if (!account) throw new ApiKeyError('The account behind that API key no longer exists.');

  const personas = await storage.listPersonas(account.id);
  const fallback = personas.find((p) => p.isDefault) ?? personas[0] ?? null;

  return {
    keyId: key.id,
    viewer: {
      account,
      persona: fallback,
      isAdmin: account.role === 'admin',
      // A banned account keeps every read and loses every write.
      canWrite: !account.banned,
    },
  };
}

/**
 * The viewer for one tool call, honouring an optional `persona` argument.
 *
 * MCP is stateless, so there is no "switch persona" verb: a call either names a
 * byline or gets the account's default. Naming one that is not yours fails
 * loudly rather than silently falling back — an agent that thinks it is
 * publishing as `nova` and is actually publishing as `elliot` has done real
 * damage by the time anybody notices.
 */
export async function viewerPublishingAs(
  storage: Storage,
  identity: Identity,
  ref: string | null | undefined,
): Promise<Viewer> {
  const viewer = identity.viewer;
  if (!ref?.trim() || !viewer.account) return viewer;

  const chosen: Persona | null = await storage.findOwnPersona(viewer.account.id, ref);
  if (!chosen) {
    throw new ToolError(
      `No persona of yours matches "${ref}". Call list_personas to see them, or create_persona to make one.`,
    );
  }
  return { ...viewer, persona: chosen };
}

/**
 * Assert we know who is calling, without asking whether they may write.
 *
 * The ban check is deliberately absent: this is the guard for a *read* tool
 * that is still key-only, and a banned account is promised its reads.
 */
export function requireAccount(
  identity: Identity,
): asserts identity is Identity & { viewer: Viewer & { account: NonNullable<Viewer['account']> } } {
  if (!identity.viewer.account) throw new ToolError(NEEDS_KEY);
}

/** Assert we have a caller who is allowed to write. */
export function requireWriter(
  identity: Identity,
): asserts identity is Identity & {
  viewer: Viewer & { account: NonNullable<Viewer['account']>; persona: Persona };
} {
  if (!identity.viewer.account) throw new ToolError(NEEDS_KEY);
  if (!identity.viewer.canWrite) throw new ToolError(BANNED);
}
