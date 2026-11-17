---
tags: [sebeto, agents, skills]
created: 2026-11-08
---

# Agents & skills

A page where the user sees the **agent hierarchy**, **creates agents**, and **assigns skills** to them.

## Status (2026-11-10): v1 built
- **Built:**
  - skills as `SKILL.md` folders, with 3 starter skills;
  - assignment to agents (DB v3 `agent_skills`);
  - instructions added to the agent's prompt for **every runtime**: Sebeto injects them, it does not rely on a runtime's native skill loading;
  - `read_skill_file` for supporting files;
  - the **Agents & skills page**: hierarchy, agent editor with the permissions grid, skill library with assign, and "What these skills need" with warnings.
- **Decided:**
  - a skill's `needs` are **informational**: a skill never loosens an agent's permissions, and the page warns when the agent has *Never* for something the skill needs;
  - skills can name the connectors they expect (`sebeto.connectors`).
- **Later (v0.3):** uploading supporting files from the UI, team templates (Presepi), delete agent, moving agents by drag and drop.

## Concepts
- **Agent:** a role in the org chart: name, reports to, runtime + model, job description, check-in schedule, budget, and **skills**.
- **Skill:** a reusable capability that can be attached to any agent. It holds:
  - **instructions** (how to do the task well, in plain language),
  - optional **files** (templates, examples, scripts, checklists),
  - the **permissions it needs** (Read only, Web read, Edit files, Send email (Ask), Run scripts (Ask), Change production (always Ask)),
  - optional **tools** it requires (e.g. `email.send`, `script.run`).
- **An agent's effective permissions** are derived from its skills and capped by the agent's own Allow/Ask/Never settings. **The stricter rule always wins.**

## Storage format: portable skills
Each skill is a folder in the workspace:
```
skills/
  incident-summary/
    SKILL.md        # YAML frontmatter + instructions
    template.xlsx   # optional supporting files
```
```markdown
---
name: incident-summary
description: Groups incident exports by root cause, with examples.
sebeto:
  permissions: [read]
  tools: [fs.read]
  version: 1
---
# Incident summary
1. Load the export from the ticket folder…
```
- The format follows the **Agent Skills / `SKILL.md` convention** that Claude Code uses, so **Claude agents can load skills natively**. Other runtimes (Codex, Gemini, Ollama) get the skill's instructions **injected** into their system prompt by Sebeto, and its files are made available through Sebeto tools. (Verify the exact native loading mechanism per runtime when implementing.)
- Skills are plain files: **shareable** (zip, git), **reviewable**, and versioned by the workspace's git snapshots.
- **Team templates ("Presepi")** = a set of agents plus their skills, exported and imported as one bundle.
  - v0.9 (2026-11-16): exporting agents from **several teams** (e.g. the whole workspace) writes a `teams` list (name, slug, colour, routing hints, AI + lock + written-scope policy, `leadKey`, `memberKeys`); importing recreates every team with its lead and members. Before, such a file had no team data and the import put everyone into one team called "My team". Files with a single `team`, or none, work as before.

## Page behaviour (from the mockup)
- **Left, Hierarchy:** an indented tree under "You", with each agent's runtime and skill count. Click to select. **+ New agent** opens the creation form (name, reports to, runtime, check-in, job description), with the parent preset to the selected agent.
- **Centre, Agent:** reports-to, direct reports, runtime/model, job description, **assigned skills** (remove with ×), and **"What these skills need"**: the permissions implied by the skills.
- **Right, Skill library:** search, **+ New skill** (name, what it does, permission needed), and per-skill **Assign / Assigned ✓** for the selected agent plus a "Used by N agents" count.

## Data model additions
- `skill(id, slug, name, description, permissions_json, tools_json, path, version, created_at)`
- `agent_skill(agent_id, skill_id, assigned_at)`
- The org-chart edge is still `agent.reports_to`; cycles are rejected by the core.

## Roadmap
- v0.2: skills stored as `SKILL.md`, assign to agents, instructions passed to the Claude runtime, permission derivation.
- v0.3: hierarchy editor (create, move and reassign agents), the skill editor in the UI, team-template import/export, injection for other runtimes.
