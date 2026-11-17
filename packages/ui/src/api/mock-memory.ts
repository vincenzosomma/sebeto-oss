/**
 * Mock memory graph (v0.4 §E) for the demo mode: a small IT Ops vault (FS01, VPN gateway, a CVE,
 * runbooks, finished tickets, one agent proposal) with links, backlinks, graph, approve and trash.
 */
import {
  MEMORY_FOLDERS, extractWikiLinks, memoryFileName, memoryKey, normalizeTags, uuidv7,
  type Id, type MemoryBackfillBody, type MemoryBackfillResult, type MemoryGraph, type MemoryGraphNode, type MemoryInfo, type MemoryKind,
  type MemoryNote, type MemoryNoteDetail, type MemoryProvenance, type MemoryRelated, type SaveMemoryNoteBody,
} from '@sebeto/shared';
import { ApiHttpError, type MemoryGraphQuery, type MemoryListQuery } from './types';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

interface DemoNote {
  id: Id; title: string; kind: MemoryKind; provenance: MemoryProvenance; untrusted: boolean; proposed: boolean;
  teamSlug: string | null; ticketId: Id | null; tags: string[]; body: string; updatedAt: string;
}

const excerpt = (body: string) => {
  const t = body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};

function demo(p: Partial<DemoNote> & Pick<DemoNote, 'title' | 'kind' | 'body'>): DemoNote {
  return { id: uuidv7(), provenance: 'owner', untrusted: false, proposed: false, teamSlug: null, ticketId: null, tags: [], updatedAt: ago(3), ...p };
}

export class MockMemory {
  private notes: DemoNote[] = [
    demo({ title: 'FS01', kind: 'system', teamSlug: 'service-desk', tags: ['naples', 'fileserver'], updatedAt: ago(10),
      body: 'Main file server in the Naples office (Windows Server 2022).\n\n- Shares: `\\\\fs01\\finance`, `\\\\fs01\\hr`\n- Backups: nightly, see [[Backups kept 30 days]]\n- When the disk fills up: [[Restore FS01]]\n- Reached from home through the [[VPN gateway]].' }),
    demo({ title: 'VPN gateway', kind: 'system', teamSlug: 'security', tags: ['vpn'], updatedAt: ago(12),
      body: 'Palo Alto GlobalProtect gateway for remote staff.\n\nCertificate renewal: [[Rotate VPN certificate]]. Known issue: [[CVE-2024-3400]].' }),
    demo({ title: 'CVE-2024-3400', kind: 'cve', provenance: 'chief-of-staff', untrusted: true, teamSlug: 'security', updatedAt: ago(6),
      body: '_Created by Sebeto from [[T-107 Patch the VPN gateway]]._\n\nCommand injection in GlobalProtect. Affects the [[VPN gateway]].' }),
    demo({ title: 'Restore FS01', kind: 'runbook', teamSlug: 'service-desk', updatedAt: ago(20),
      body: '1. Check free space on [[FS01]] (`Get-PSDrive D`).\n2. Clear the temp share.\n3. If still full, restore from last night’s backup.' }),
    demo({ title: 'Rotate VPN certificate', kind: 'runbook', teamSlug: 'security', updatedAt: ago(30),
      body: 'Yearly. Request the certificate, install it on the [[VPN gateway]], tell [[Giulia Esposito]].' }),
    demo({ title: 'Backups kept 30 days', kind: 'decision', updatedAt: ago(40), body: 'Decided with finance: file server backups ([[FS01]]) are kept for 30 days.' }),
    demo({ title: 'Outlook', kind: 'app', teamSlug: 'service-desk', updatedAt: ago(15), body: 'Microsoft 365 mail client. Profiles break after password changes.' }),
    demo({ title: 'T-101 FS01 disk full', kind: 'ticket', provenance: 'chief-of-staff', teamSlug: 'service-desk', tags: ['ticket'], updatedAt: ago(8),
      body: '**Ticket:** T-101 · completed\n\n## What happened\nThe D: drive of [[FS01]] was full; users could not save files.\n\n## Fix\nCleared the temp share following [[Restore FS01]].\n<!-- sebeto:auto-end -->\n' }),
    demo({ title: 'T-104 VPN users disconnected', kind: 'ticket', provenance: 'chief-of-staff', teamSlug: 'security', tags: ['ticket'], updatedAt: ago(5),
      body: '**Ticket:** T-104 · completed\n\n## What happened\nRemote users were disconnected from the [[VPN gateway]] every hour.\n\n## Fix\nRenewed the certificate ([[Rotate VPN certificate]]).\n<!-- sebeto:auto-end -->\n' }),
    demo({ title: 'T-107 Patch the VPN gateway', kind: 'ticket', provenance: 'chief-of-staff', untrusted: true, teamSlug: 'security', tags: ['ticket'], updatedAt: ago(2),
      body: '**Ticket:** T-107 · completed · ⚠ made from outside content (untrusted)\n\n## What happened\nAn alert reported [[CVE-2024-3400]] on the [[VPN gateway]].\n\n## Fix\nInstalled the hotfix.\n<!-- sebeto:auto-end -->\n' }),
    demo({ title: 'Print server PRN02', kind: 'system', provenance: 'agent', proposed: true, teamSlug: 'service-desk', updatedAt: ago(1),
      body: 'Print server for the second floor. Queue gets stuck after driver updates; restart the spooler. Related: [[FS01]]' }),
  ];
  constructor(private readonly emitChanged: () => void) {}

  private path(n: DemoNote): string {
    return `${n.proposed ? 'proposed' : MEMORY_FOLDERS[n.kind]}/${memoryFileName(n.title)}`;
  }
  private approved(): DemoNote[] { return this.notes.filter((n) => !n.proposed); }
  private byKey(key: string, all = false): DemoNote | undefined {
    return (all ? this.notes : this.approved()).find((n) => memoryKey(n.title) === key);
  }
  private backlinks(n: DemoNote, includeProposed: boolean): DemoNote[] {
    const k = memoryKey(n.title);
    return this.notes.filter((x) => x.id !== n.id && (includeProposed || !x.proposed) && extractWikiLinks(x.body).includes(k));
  }
  private toNote(n: DemoNote): MemoryNote {
    return {
      id: n.id, title: n.title, kind: n.kind, path: this.path(n), provenance: n.provenance, untrusted: n.untrusted,
      status: n.proposed ? 'proposed' : 'approved', teamSlug: n.teamSlug, ticketId: n.ticketId, tags: n.tags, excerpt: excerpt(n.body),
      linkCount: extractWikiLinks(n.body).length, backlinkCount: this.backlinks(n, false).length, updatedAt: n.updatedAt,
    };
  }
  private find(id: Id): DemoNote {
    const n = this.notes.find((x) => x.id === id);
    if (!n) throw new ApiHttpError(404, 'not_found', `Memory note ${id} not found`);
    return n;
  }

  list(q: MemoryListQuery = {}): MemoryNote[] {
    const words = (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return this.notes
      .filter((n) => (!q.status || (q.status === 'proposed') === n.proposed) && (!q.kind || n.kind === q.kind) && (!q.team || n.teamSlug === q.team))
      .filter((n) => words.every((w) => `${n.title} ${n.body}`.toLowerCase().includes(w)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, q.limit ?? 200)
      .map((n) => this.toNote(n));
  }

  get(id: Id): MemoryNoteDetail {
    const n = this.find(id);
    const links = extractWikiLinks(n.body).map((k) => this.byKey(k)?.title ?? k);
    return {
      ...this.toNote(n), body: n.body, links,
      backlinks: this.backlinks(n, true).map((b) => ({ id: b.id, title: b.title })),
      obsidianUrl: `obsidian://open?path=${encodeURIComponent(`C:\\Users\\demo\\.sebeto\\workspace\\memory\\${this.path(n).replace(/\//g, '\\')}`)}`,
    };
  }

  create(body: SaveMemoryNoteBody): MemoryNoteDetail {
    const title = memoryFileName(body.title).replace(/\.md$/, '');
    if (this.byKey(memoryKey(title))) throw new ApiHttpError(409, 'memory_exists', `A note called "${title}" already exists. Open it and edit it instead.`);
    const n = demo({ title, kind: body.kind, body: body.body, tags: normalizeTags(body.tags ?? []), teamSlug: body.teamSlug ?? null, untrusted: body.untrusted === true, updatedAt: new Date().toISOString() });
    this.notes.push(n);
    this.emitChanged();
    return this.get(n.id);
  }

  update(id: Id, body: SaveMemoryNoteBody): MemoryNoteDetail {
    const n = this.find(id);
    Object.assign(n, {
      title: memoryFileName(body.title).replace(/\.md$/, ''), kind: body.kind, body: body.body, updatedAt: new Date().toISOString(),
      ...(body.tags ? { tags: normalizeTags(body.tags) } : {}), ...(body.teamSlug !== undefined ? { teamSlug: body.teamSlug } : {}),
      ...(body.untrusted !== undefined ? { untrusted: body.untrusted } : {}),
    });
    this.emitChanged();
    return this.get(id);
  }

  remove(id: Id): void {
    this.find(id);
    this.notes = this.notes.filter((n) => n.id !== id);
    this.emitChanged();
  }

  approve(id: Id): MemoryNoteDetail {
    const n = this.find(id);
    if (!n.proposed) throw new ApiHttpError(409, 'memory_not_proposed', 'This note is already approved.');
    if (this.byKey(memoryKey(n.title))) n.title = `${n.title} 2`;
    n.proposed = false;
    this.emitChanged();
    return this.get(id);
  }

  graph(q: MemoryGraphQuery = {}): MemoryGraph {
    const notes = this.notes.filter((n) => q.proposed || !n.proposed);
    const ids = new Map(notes.filter((n) => !n.proposed).map((n) => [memoryKey(n.title), n.id]));
    const edges: MemoryGraph['edges'] = [];
    const missing = new Map<string, string>();
    for (const n of notes) {
      for (const k of extractWikiLinks(n.body)) {
        const to = ids.get(k) ?? `missing:${k}`;
        if (!ids.has(k)) missing.set(to, k);
        if (to !== n.id) edges.push({ from: n.id, to });
      }
    }
    const degree = new Map<string, number>();
    for (const e of edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
    let keep = new Set<string>([...notes.map((n) => n.id), ...missing.keys()]);
    const words = (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (q.team || q.kind || words.length) {
      keep = new Set(notes.filter((n) => (!q.team || n.teamSlug === q.team) && (!q.kind || n.kind === q.kind)
        && words.every((w) => `${n.title} ${n.body}`.toLowerCase().includes(w))).map((n) => n.id));
      for (const e of edges) if (keep.has(e.from) && e.to.startsWith('missing:')) keep.add(e.to);
    }
    if (q.center) {
      const within = new Set([q.center]);
      let frontier = [q.center];
      for (let d = 0; d < (q.depth ?? 1); d++) {
        const next: string[] = [];
        for (const e of edges) {
          for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) if (frontier.includes(a) && !within.has(b)) { within.add(b); next.push(b); }
        }
        frontier = next;
      }
      keep = new Set([...within].filter((id) => keep.has(id) || id === q.center || id.startsWith('missing:')));
    }
    const nodes: MemoryGraphNode[] = [...keep].map((id) => {
      const n = notes.find((x) => x.id === id);
      return n
        ? { id, title: n.title, kind: n.kind, untrusted: n.untrusted, status: n.proposed ? 'proposed' : 'approved', teamSlug: n.teamSlug, degree: degree.get(id) ?? 0 }
        : { id, title: missing.get(id) ?? id, kind: 'missing', untrusted: false, status: null, teamSlug: null, degree: degree.get(id) ?? 0 };
    });
    return { nodes, edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)), truncated: false };
  }

  related(name: string): MemoryRelated {
    const n = this.byKey(memoryKey(name));
    if (!n) return { note: null, neighbours: [] };
    const out = extractWikiLinks(n.body).map((k) => this.byKey(k)).filter((x): x is DemoNote => !!x);
    return {
      note: this.toNote(n),
      neighbours: [...out.map((x) => ({ note: this.toNote(x), via: 'out' as const })), ...this.backlinks(n, false).map((x) => ({ note: this.toNote(x), via: 'in' as const }))],
    };
  }

  backfill(body: MemoryBackfillBody = {}): MemoryBackfillResult {
    return { considered: 3, written: 0, skipped: 3, modelCalls: 0, costUsd: 0, dryRun: body.dryRun === true };
  }

  info(): MemoryInfo {
    const links = this.notes.reduce((s, n) => s + extractWikiLinks(n.body).length, 0);
    return { folder: 'C:\\Users\\demo\\.sebeto\\workspace\\memory', notes: this.approved().length, proposed: this.notes.length - this.approved().length, links, lastIndexedAt: new Date().toISOString() };
  }
}
