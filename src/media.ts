/**
 * How bytes from an agent reach storage.
 *
 * Agents do not have a file picker, so `add_screenshot`, `set_cover` and
 * `upload_game_build` take either a public https URL to fetch or base64 bytes.
 * Either way the result runs through the same checks a browser upload is held
 * to — an agent must not be able to smuggle anything past validation a human
 * cannot.
 *
 * The rules are pure functions on purpose: they are the part worth testing, and
 * they must not need a network or a storage credential to run.
 */

import { ToolError } from './errors.js';
import type { BlobStore, StoredBlob } from './storage/types.js';

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const HTML_MAX_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

export const ALLOWED_IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type UploadKind = 'screenshot' | 'cover' | 'avatar' | 'build';

export type MediaCheck = { ok: true; contentType: string } | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/*  Sniffing                                                                   */
/* -------------------------------------------------------------------------- */

/** `image/png; charset=binary` -> `image/png`. */
export function normalizeContentType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Identify an image by its magic bytes, not by what the caller claimed.
 *
 * A declared content type is a hint from an untrusted party. The bytes are the
 * fact, and this is the only check that decides whether something is stored.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Validate image bytes: real format, and inside the size cap. */
export function checkImageBytes(bytes: Uint8Array): MediaCheck {
  if (bytes.byteLength === 0) return { ok: false, error: 'That upload was empty.' };
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    return { ok: false, error: 'Images max out at 5MB. That one is bigger.' };
  }
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    return {
      ok: false,
      error: 'Those bytes are not a PNG, JPEG, WebP or GIF, whatever they were labelled.',
    };
  }
  return { ok: true, contentType: sniffed };
}

/**
 * A build must be genuinely one self-contained HTML document: it is served as
 * exactly one file, so an external `<script src>` would simply not load.
 */
export function checkHtmlBytes(bytes: Uint8Array): MediaCheck {
  if (bytes.byteLength === 0) return { ok: false, error: 'That upload was empty.' };
  if (bytes.byteLength > HTML_MAX_BYTES) {
    return { ok: false, error: 'Game builds max out at 10MB. Inline fewer assets, or compress them.' };
  }
  const head = new TextDecoder().decode(bytes.slice(0, 2048)).toLowerCase();
  if (!head.includes('<html') && !head.includes('<!doctype html') && !head.includes('<script') && !head.includes('<meta')) {
    return { ok: false, error: 'That does not look like an HTML document. Builds are a single self-contained .html file.' };
  }
  return { ok: true, contentType: 'text/html; charset=utf-8' };
}

/**
 * Only public https URLs, and never a private range.
 *
 * This server fetches whatever an API key tells it to, which is exactly the
 * shape of an SSRF probe against the deployment's own network. In production
 * the hostname is also resolved and the resolved address re-checked, because
 * DNS can point a public name at 127.0.0.1.
 */
export function checkRemoteImageUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a URL.' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'Image URLs must be https://.' };

  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === '::1' ||
    host === '0.0.0.0';
  if (isPrivate) {
    return { ok: false, error: 'That URL points inside a private network. Public https images only.' };
  }
  return { ok: true, url };
}

/** Gate a remote response on its headers, before reading a single byte. */
export function checkRemoteImageHeaders(
  contentType: string | null | undefined,
  contentLength: string | number | null | undefined,
): MediaCheck {
  const type = normalizeContentType(contentType);
  if (!type) return { ok: false, error: 'That URL did not say what it was serving. Images only, please.' };
  if (!(ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `That URL served "${type}". Images must be PNG, JPEG, WebP or GIF.` };
  }
  const declared = typeof contentLength === 'number' ? contentLength : Number(contentLength ?? NaN);
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
    return { ok: false, error: 'Images max out at 5MB. That one is bigger.' };
  }
  return { ok: true, contentType: type };
}

/* -------------------------------------------------------------------------- */
/*  Decoding                                                                   */
/* -------------------------------------------------------------------------- */

/** Accepts raw base64 or a full `data:image/png;base64,…` URL. */
export function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(',');
  const payload = input.startsWith('data:') && comma > -1 ? input.slice(comma + 1) : input;
  try {
    return new Uint8Array(Buffer.from(payload.replace(/\s+/g, ''), 'base64'));
  } catch {
    throw new ToolError('That base64 payload could not be decoded.');
  }
}

/* -------------------------------------------------------------------------- */
/*  Storing                                                                    */
/* -------------------------------------------------------------------------- */

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Paths are namespaced by owner and kind so a sweep can find orphans later. */
export function blobPathFor(kind: UploadKind, ownerId: string, extension: string): string {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${kind}s/${ownerId}/${stamp}-${noise}.${extension}`;
}

export interface StoreImageOptions {
  blobs: BlobStore;
  ownerId: string;
  kind: Extract<UploadKind, 'screenshot' | 'cover' | 'avatar'>;
  source: { url?: string | null; base64?: string | null };
  /** Injected so tests never touch the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Fetch or decode, validate, then store. Exactly one source, or it refuses. */
export async function storeImage(options: StoreImageOptions): Promise<StoredBlob> {
  const { url, base64 } = options.source;
  if (Boolean(url) === Boolean(base64)) {
    throw new ToolError('Send exactly one of `url` or `base64`.');
  }

  const bytes = url ? await fetchImageBytes(url, options.fetchImpl ?? fetch) : decodeBase64(base64!);

  const check = checkImageBytes(bytes);
  if (!check.ok) throw new ToolError(check.error);

  const path = blobPathFor(options.kind, options.ownerId, EXTENSIONS[check.contentType] ?? 'bin');
  return options.blobs.put(path, bytes, check.contentType);
}

async function fetchImageBytes(raw: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const checked = checkRemoteImageUrl(raw);
  if (!checked.ok) throw new ToolError(checked.error);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(checked.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new ToolError(`That URL answered ${response.status}.`);

    const headers = checkRemoteImageHeaders(
      response.headers.get('content-type'),
      response.headers.get('content-length'),
    );
    if (!headers.ok) throw new ToolError(headers.error);

    return new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError('That image URL could not be fetched.');
  } finally {
    clearTimeout(timer);
  }
}

/** Store a single-file HTML build. Same validation, different cap and shape. */
export async function storeGameBuild(options: {
  blobs: BlobStore;
  ownerId: string;
  gameId: string;
  base64: string;
}): Promise<StoredBlob> {
  const bytes = decodeBase64(options.base64);
  const check = checkHtmlBytes(bytes);
  if (!check.ok) throw new ToolError(check.error);

  // A stable path per game means re-uploading replaces the live build rather
  // than leaving the old one orphaned and still reachable.
  const path = `builds/${options.ownerId}/${options.gameId}/index.html`;
  return options.blobs.put(path, bytes, check.contentType);
}
