import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, type Skill } from '@sebeto/shared';
import { openDatabase } from '../storage/index.js';
import type { Repos } from '../contracts.js';
import { STARTER_SKILLS, createSkillStore, parseSkillMd, slugify } from './store.js';
import { SKILLS_PROMPT_TOTAL_MAX, buildSkillsSection } from './prompt.js';
import { buildSystemPrompt } from '../executor/prompts.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-skills-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('skill store', () => {
  it('slugifies names', () => {
    expect(slugify('Incident summary (v2)!')).toBe('incident-summary-v2');
    expect(slugify('Città più bella')).toBe('citta-piu-bella');
    expect(slugify('!!!')).toBe('skill');
  });

  it('creates, reads, updates (keeping unknown frontmatter) and removes skills', () => {
    const store = createSkillStore(dir, (slug) => (slug === 'cert-renewal' ? ['agent-1'] : []));
    const s = store.create({ name: 'Cert renewal', description: 'Renew TLS certs', instructions: '# Steps\n1. Check expiry', needs: ['fs.read', 'prod.change'], connectors: ['folder'] });
    expect(s).toMatchObject({ slug: 'cert-renewal', name: 'Cert renewal', needs: ['fs.read', 'prod.change'], connectors: ['folder'], version: 1, usedBy: ['agent-1'], files: [] });
    expect(store.create({ name: 'Cert renewal', description: '', instructions: 'x' }).slug).toBe('cert-renewal-2');

    // A file edited by hand with extra keys and a supporting file.
    const file = path.join(dir, 'skills', 'cert-renewal', 'SKILL.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('name: Cert renewal', 'name: Cert renewal\nlicense: MIT'), 'utf8');
    fs.writeFileSync(path.join(dir, 'skills', 'cert-renewal', 'checklist.md'), '- [ ] backup', 'utf8');

    const u = store.update('cert-renewal', { name: 'Cert renewal', description: 'Renew TLS certificates', instructions: '# Steps\n1. Check expiry\n2. Renew', needs: ['fs.read'] });
    expect(u.version).toBe(2);
    expect(u.connectors).toEqual(['folder']); // left out of the body: kept
    expect(u.files).toEqual(['checklist.md']);
    expect(parseSkillMd(fs.readFileSync(file, 'utf8')).meta).toMatchObject({ license: 'MIT', name: 'Cert renewal' });
    expect(store.list().map((x) => x.slug)).toEqual(['cert-renewal', 'cert-renewal-2']);

    store.remove('cert-renewal-2');
    expect(store.get('cert-renewal-2')).toBeUndefined();
    expect(() => store.update('nope', { name: 'x', description: '', instructions: 'y' })).toThrow(/Unknown skill/);
    expect(() => store.create({ name: ' ', description: '', instructions: 'y' })).toThrow(/name/);
    expect(() => store.create({ name: 'x', description: '', instructions: '  ' })).toThrow(/instructions/);
  });

  it('reads a SKILL.md written for other tools (no sebeto keys, no frontmatter)', () => {
    fs.mkdirSync(path.join(dir, 'skills', 'plain'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'plain', 'SKILL.md'), 'Just instructions.\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'skills', 'claude-style'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'claude-style', 'SKILL.md'), '---\nname: pdf-tools\ndescription: Work with PDFs\n---\n\nUse pdftotext.\n', 'utf8');
    const store = createSkillStore(dir);
    expect(store.get('plain')).toMatchObject({ name: 'plain', instructions: 'Just instructions.', needs: [] });
    expect(store.get('claude-style')).toMatchObject({ name: 'pdf-tools', description: 'Work with PDFs', instructions: 'Use pdftotext.' });
  });

  it('seeds starter skills once and resolves files safely', async () => {
    const store = createSkillStore(dir);
    store.seedIfEmpty();
    expect(store.list()).toHaveLength(STARTER_SKILLS.length);
    store.remove('cve-triage');
    store.seedIfEmpty(); // the folder exists: no re-seeding
    expect(store.list()).toHaveLength(STARTER_SKILLS.length - 1);
    fs.writeFileSync(path.join(dir, 'skills', 'incident-summary', 'template.md'), 'T', 'utf8');
    // Compare real paths: Windows temp folders can have short 8.3 names (RUNNER~1).
    expect(fs.realpathSync.native(await store.resolveFile('incident-summary', 'template.md'))).toBe(fs.realpathSync.native(path.join(dir, 'skills', 'incident-summary', 'template.md')));
    await expect(store.resolveFile('incident-summary', '../maintenance-notice/SKILL.md')).rejects.toThrow();
    await expect(store.resolveFile('nope', 'x')).rejects.toThrow(/Unknown skill/);
  });
});

describe('agent skill assignment (DB v3)', () => {
  let repos: Repos;
  beforeEach(() => { ({ repos } = openDatabase({ file: path.join(dir, `db-${uuidv7()}.db`), workspaceDir: dir })); });
  afterEach(() => repos.close());

  it('sets, orders, lists and removes skills everywhere', () => {
    const a = repos.agents.create({ name: 'Analyst' });
    const b = repos.agents.create({ name: 'Writer' });
    expect(a.skills).toEqual([]);
    expect(repos.agents.setSkills(a.id, ['cve-triage', 'incident-summary', 'cve-triage']).skills).toEqual(['cve-triage', 'incident-summary']);
    repos.agents.setSkills(b.id, ['incident-summary']);
    expect(repos.agents.list().map((x) => x.skills)).toEqual([['cve-triage', 'incident-summary'], ['incident-summary']]);
    expect(repos.agents.removeSkillEverywhere('incident-summary')).toBe(2);
    expect(repos.agents.get(a.id)!.skills).toEqual(['cve-triage']);
    // Updating other fields keeps skills.
    expect(repos.agents.update(a.id, { name: 'Analyst 2' }).skills).toEqual(['cve-triage']);
    expect(() => repos.agents.setSkills('missing', [])).toThrow(/not found/);
  });
});

describe('skills in the system prompt', () => {
  const skill = (slug: string, instructions: string, files: string[] = []): Skill => ({
    slug, name: slug, description: `${slug} desc`, instructions, needs: [], connectors: [], files, version: 1, updatedAt: '', usedBy: [],
  });

  it('adds instructions and files, before the ticket line', () => {
    const ticket = { number: 7, title: 'Check certs' } as Parameters<typeof buildSystemPrompt>[1];
    const sys = buildSystemPrompt(null, ticket, [skill('cert-renewal', '1. Check expiry', ['checklist.md'])]);
    expect(sys).toContain('=== Skill: cert-renewal (cert-renewal) ===\ncert-renewal desc\n1. Check expiry');
    expect(sys).toContain('read_skill_file, skill "cert-renewal"): checklist.md');
    expect(sys.indexOf('=== Skill')).toBeLessThan(sys.indexOf('You are working on ticket T-7'));
    expect(buildSystemPrompt(null, ticket, [])).not.toContain('Your skills');
  });

  it('caps very long skills', () => {
    const text = buildSkillsSection([skill('a', 'x'.repeat(9000)), skill('b', 'y'.repeat(9000)), skill('c', 'z'.repeat(9000)), skill('d', 'w'.repeat(9000))]);
    expect(text).toContain('[skill truncated]');
    expect(text).toMatch(/more skill\(s\) not included/);
    expect(text.length).toBeLessThan(SKILLS_PROMPT_TOTAL_MAX + 2000);
  });
});
