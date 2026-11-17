/**
 * How assigned skills reach the agent: their instructions are added to the system prompt (works for
 * every runtime), with a list of supporting files the agent can open with the read_skill_file tool.
 */
import type { Skill } from '@sebeto/shared';

/** Per-skill and total caps, so a big library cannot crowd out the ticket itself. */
export const SKILL_PROMPT_MAX = 8_000;
export const SKILLS_PROMPT_TOTAL_MAX = 24_000;

export function buildSkillsSection(skills: Skill[]): string {
  if (!skills.length) return '';
  const parts: string[] = ['Your skills (follow them when they apply to this ticket):'];
  let total = 0;
  for (const s of skills) {
    let text = s.instructions.trim();
    if (text.length > SKILL_PROMPT_MAX) text = `${text.slice(0, SKILL_PROMPT_MAX)}\n[skill truncated]`;
    const files = s.files.length ? `\nSupporting files (open with read_skill_file, skill "${s.slug}"): ${s.files.slice(0, 30).join(', ')}` : '';
    const block = `=== Skill: ${s.name} (${s.slug}) ===\n${s.description ? `${s.description}\n` : ''}${text}${files}`;
    if (total + block.length > SKILLS_PROMPT_TOTAL_MAX) {
      parts.push(`[${skills.length - (parts.length - 1)} more skill(s) not included: too long]`);
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join('\n\n');
}
