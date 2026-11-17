/**
 * Projects and tags (v0.3). A project groups related tickets ("Windows 11 rollout") and gives every
 * agent working on them a shared brief. Tags are free labels on tickets ("network", "urgent").
 *
 * API (under /api/v1):
 *   GET    /projects                 → ProjectSummary[] (archived last)
 *   POST   /projects                 CreateProjectBody → Project (201)
 *   PATCH  /projects/:id             UpdateProjectBody → Project
 *   DELETE /projects/:id             → 204 (its tickets stay, without a project)
 *   GET    /tags                     → TagCount[] (most used first)
 *   GET    /tickets?projectId=<id|none>&tag=<tag>   filters (also "#tag" words inside q)
 * Tickets: CreateTicketBody / UpdateTicketBody accept projectId and tags.
 * WebSocket: { type: 'project.updated', project } and { type: 'project.deleted', projectId }.
 */
import type { Id, IsoDate, TicketStatus } from './types.js';

export interface Project {
  id: Id;
  name: string;
  /** The brief every agent on this project's tickets receives (goal, scope, constraints). */
  description: string;
  /** Hex colour like #0E5A8A, used for the dot on cards. */
  color: string;
  archived: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface ProjectSummary extends Project {
  /** Tickets per status. */
  counts: Partial<Record<TicketStatus, number>>;
  costUsd: number;
}

export interface CreateProjectBody { name: string; description?: string; color?: string }
export interface UpdateProjectBody { name?: string; description?: string; color?: string; archived?: boolean }

export interface TagCount { tag: string; count: number }

/** Palette offered for new projects (Sebeto brand + readable companions). */
export const PROJECT_COLORS: readonly string[] = ['#0E5A8A', '#2E7D5B', '#B5532C', '#7A4FA0', '#C08A1E', '#3B6E8F', '#8A3B5E', '#4F6B2E'] as const;

export const MAX_TAGS_PER_TICKET = 10;
export const MAX_TAG_LENGTH = 32;

/**
 * Normalise one tag: trim, drop a leading '#', lowercase, spaces → '-', keep letters/digits/-_.
 * Returns null when nothing usable remains.
 */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, MAX_TAG_LENGTH);
  return t.replace(/^[-.]+|[-.]+$/g, '') || null;
}

/** Normalise and de-duplicate a list of tags (max MAX_TAGS_PER_TICKET, order kept). */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const t = normalizeTag(r);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS_PER_TICKET) break;
  }
  return out;
}

/** Split "#tag" words out of a search text: { text without them, tags }. */
export function splitTagQuery(q: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const text = q.replace(/(^|\s)#([\p{L}\p{N}_.-]+)/gu, (_m, pre: string, tag: string) => {
    const n = normalizeTag(tag);
    if (n && !tags.includes(n)) tags.push(n);
    return pre;
  }).replace(/\s+/g, ' ').trim();
  return { text, tags };
}
