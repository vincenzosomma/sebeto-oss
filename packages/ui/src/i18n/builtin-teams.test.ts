import { describe, expect, it } from 'vitest';
import { MOCK_TEMPLATES } from '../api/mock-templates';
import { BUILTIN_TEAMS_IT, localizeTemplate } from './builtin-teams';

describe('v0.5 M: Italian texts for the built-in teams', () => {
  it('cover every built-in template and every agent role', () => {
    expect(Object.keys(BUILTIN_TEAMS_IT).sort()).toEqual(MOCK_TEMPLATES.map((t) => t.id).sort());
    for (const tpl of MOCK_TEMPLATES) {
      const it = localizeTemplate(tpl, 'it');
      expect(it.name, tpl.id).not.toBe('');
      expect(it.description).not.toBe(tpl.description);
      for (const a of it.agents) {
        const tx = BUILTIN_TEAMS_IT[tpl.id]!.agents[a.key];
        expect(tx, `${tpl.id}/${a.key}`).toBeTruthy();
        expect(a.role).toBe(tx!.role);
        expect(a.job).toBe(tx!.job);
      }
    }
    expect(localizeTemplate(MOCK_TEMPLATES.find((t) => t.id === 'infrastructure')!, 'it').name).toBe('Team Infrastruttura');
  });

  it('change only what is shown: English, saved templates, ids, keys, names and skills stay as they are', () => {
    const tpl = MOCK_TEMPLATES.find((t) => t.id === 'security')!;
    const before = JSON.stringify(tpl);
    const it = localizeTemplate(tpl, 'it');
    expect(JSON.stringify(tpl)).toBe(before); // not mutated
    expect(it).toMatchObject({ id: tpl.id, builtin: true, team: tpl.team, skills: tpl.skills });
    expect(it.agents.map((a) => [a.key, a.name, a.reportsTo, a.skills])).toEqual(tpl.agents.map((a) => [a.key, a.name, a.reportsTo, a.skills]));
    expect(localizeTemplate(tpl, 'en')).toBe(tpl);
    const saved = { ...tpl, builtin: false };
    expect(localizeTemplate(saved, 'it')).toBe(saved);
  });
});
