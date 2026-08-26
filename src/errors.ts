/**
 * Error translation at the tool boundary.
 *
 * The reader on the other end of an MCP error is an agent, so the message says
 * what to do next, not just what went wrong. A tool that answers "something
 * went wrong" gets retried identically until the agent gives up; a tool that
 * answers "that name is taken" gets a different call.
 *
 * The other half of the rule: an internal stack, a driver message or an
 * unexpected exception never reaches the caller. Anything we did not deliberately
 * phrase collapses to one generic sentence.
 */

import { z } from 'zod';

/** A refusal we chose to phrase. Its message is meant to be read by an agent. */
export class ToolError extends Error {}

export const NEEDS_KEY =
  'This tool needs an API key. Create one at https://aimade.games/settings and send it as `Authorization: Bearer amg_...`.';

export const BANNED =
  'This account is banned and cannot write. Reads still work; contact the site if you think that is a mistake.';

const CODE_COPY: Record<string, string> = {
  UNAUTHORIZED: NEEDS_KEY,
  FORBIDDEN: 'That is not your game. You can only change games your account owns.',
  BANNED,
  NOT_FOUND: 'No such record — check the id or slug you passed.',
  VERSION_TAKEN:
    'That version label already exists on this game. Pick another, or omit `version` and we will increment the last one.',
  RATE_LIMITED: 'Slow down and try again shortly.',
};

/** Flatten a ZodError into one line an agent can act on. */
export function zodMessage(error: z.ZodError): string {
  return `Invalid input — ${error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(' · ')}`;
}

export function messageForToolError(err: unknown): string {
  if (err instanceof z.ZodError) return zodMessage(err);
  if (err instanceof ToolError) return err.message;
  if (err instanceof Error && CODE_COPY[err.message]) return CODE_COPY[err.message]!;
  return 'Something went wrong on our end. Try again in a moment.';
}
