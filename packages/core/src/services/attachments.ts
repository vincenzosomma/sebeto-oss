/**
 * Chat attachments (2026-11-16): the owner pastes, drops or picks files in a ticket's chat. Each file is
 * saved in the ticket folder under attachments/, so the agent (which works in that folder) can open it;
 * Claude Code agents can also look at images. The message that goes with them names the files and
 * says their content is data, not instructions.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Id } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { badRequest, notFound } from './errors.js';
import { requireTicket } from './tickets.js';

export const ATTACHMENTS_DIR = 'attachments';
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Types the chat accepts (by extension) and the Content-Type they are served with. */
export const ATTACHMENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8', html: 'text/plain; charset=utf-8',
  eml: 'text/plain; charset=utf-8', conf: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8', sh: 'text/plain; charset=utf-8', ps1: 'text/plain; charset=utf-8',
  docx: 'application/octet-stream', xlsx: 'application/octet-stream', pptx: 'application/octet-stream',
  zip: 'application/octet-stream',
};

export interface Attachment { name: string; path: string; size: number; type: string }

const extOf = (name: string) => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? '').toLowerCase();

/** A safe file name: letters, digits, dot, dash, underscore; keeps the extension. Exported for tests. */
export function safeAttachmentName(raw: string): string {
  const base = path.basename(String(raw).replace(/\\/g, '/')).normalize('NFKD');
  const ext = extOf(base);
  let stem = (ext ? base.slice(0, -(ext.length + 1)) : base).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80);
  if (!stem) stem = 'file';
  return ext ? `${stem}.${ext}` : stem;
}

function dirOf(ctx: AppContext, ticketId: Id): string {
  const t = requireTicket(ctx, ticketId);
  return path.join(t.folder, ATTACHMENTS_DIR);
}

export function saveAttachment(ctx: AppContext, ticketId: Id, rawName: string, dataBase64: string): Attachment {
  const name0 = safeAttachmentName(rawName);
  const ext = extOf(name0);
  if (!ATTACHMENT_TYPES[ext]) throw badRequest(`Files of this type can't be attached (${ext ? `.${ext}` : 'no extension'}). Use an image, PDF, text, log or Office file.`, 'attachment_type');
  const data = Buffer.from(dataBase64, 'base64');
  if (!data.length) throw badRequest('The file is empty.', 'attachment_empty');
  if (data.length > MAX_ATTACHMENT_BYTES) throw badRequest(`The file is too big (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB).`, 'attachment_too_big');
  const dir = dirOf(ctx, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  // Never overwrite: screenshot.png, screenshot-2.png, …
  let name = name0;
  const stem = ext ? name0.slice(0, -(ext.length + 1)) : name0;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem}-${i}${ext ? `.${ext}` : ''}`;
  fs.writeFileSync(path.join(dir, name), data, { flag: 'wx' });
  return { name, path: `${ATTACHMENTS_DIR}/${name}`, size: data.length, type: ATTACHMENT_TYPES[ext]! };
}

/** One attachment's bytes, for the chat preview / download. Only files directly in attachments/. */
export function readAttachment(ctx: AppContext, ticketId: Id, rawName: string): { data: Buffer; type: string; name: string } {
  const name = path.basename(String(rawName));
  if (name !== rawName || name.startsWith('.')) throw notFound('attachment', rawName);
  const file = path.join(dirOf(ctx, ticketId), name);
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { throw notFound('attachment', rawName); }
  if (!st.isFile()) throw notFound('attachment', rawName);
  return { data: fs.readFileSync(file), type: ATTACHMENT_TYPES[extOf(name)] ?? 'application/octet-stream', name };
}

export { attachmentNote } from '@sebeto/shared';

/** Names that exist in the ticket's attachments/ folder, in the order given; unknown ones are refused. */
export function checkAttachmentNames(ctx: AppContext, ticketId: Id, names: string[]): string[] {
  const dir = dirOf(ctx, ticketId);
  const out: string[] = [];
  for (const n of names) {
    const name = path.basename(n);
    if (name !== n || !fs.existsSync(path.join(dir, name))) throw badRequest(`Attachment not found: ${n}`, 'attachment_missing');
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
