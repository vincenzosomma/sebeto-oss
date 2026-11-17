/** Projects and tags API (v0.3). */
import { PROJECT_COLORS, type CreateProjectBody, type Id, type Project, type ProjectSummary, type TagCount, type UpdateProjectBody } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { badRequest, conflict, notFound } from './errors.js';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function checkName(ctx: AppContext, name: string, selfId?: Id): string {
  const n = name.trim();
  if (!n) throw badRequest('Give the project a name.', 'project_name');
  const other = ctx.repos.projects.findByName(n);
  if (other && other.id !== selfId) throw conflict(`A project called "${other.name}" already exists.`, 'project_exists');
  return n;
}

function checkColor(color: string | undefined, fallback: string): string {
  if (color === undefined) return fallback;
  if (!COLOR_RE.test(color)) throw badRequest('Colour must look like #0E5A8A.', 'project_color');
  return color.toUpperCase();
}

const publish = (ctx: AppContext, project: Project) => ctx.bus.publish({ type: 'project.updated', project });

export function listProjects(ctx: AppContext): ProjectSummary[] {
  return ctx.repos.projects.list();
}

export function createProject(ctx: AppContext, body: CreateProjectBody): Project {
  const name = checkName(ctx, body.name);
  // Next palette colour, so new projects are easy to tell apart.
  const fallback = PROJECT_COLORS[ctx.repos.projects.list().length % PROJECT_COLORS.length]!;
  const project = ctx.repos.projects.create({ name, description: (body.description ?? '').trim(), color: checkColor(body.color, fallback) });
  publish(ctx, project);
  return project;
}

export function updateProject(ctx: AppContext, id: Id, body: UpdateProjectBody): Project {
  const cur = ctx.repos.projects.get(id);
  if (!cur) throw notFound('Project', id);
  const project = ctx.repos.projects.update(id, {
    ...(body.name !== undefined ? { name: checkName(ctx, body.name, id) } : {}),
    ...(body.description !== undefined ? { description: body.description.trim() } : {}),
    ...(body.color !== undefined ? { color: checkColor(body.color, cur.color) } : {}),
    ...(body.archived !== undefined ? { archived: body.archived } : {}),
  });
  publish(ctx, project);
  return project;
}

export function deleteProject(ctx: AppContext, id: Id): void {
  const tickets = ctx.repos.tickets.list({ projectId: id, limit: 200 }).items;
  if (!ctx.repos.projects.remove(id)) throw notFound('Project', id);
  ctx.bus.publish({ type: 'project.deleted', projectId: id });
  // Its tickets stay, without a project (ON DELETE SET NULL): refresh them on the board.
  for (const t of tickets) {
    const fresh = ctx.repos.tickets.get(t.id);
    if (fresh) ctx.bus.publish({ type: 'ticket.updated', ticket: fresh });
  }
}

export function listTags(ctx: AppContext): TagCount[] {
  return ctx.repos.projects.tags();
}

/** For ticket create/update: the project must exist (null clears it). */
export function requireProjectIfSet(ctx: AppContext, projectId: Id | null | undefined): void {
  if (projectId != null && !ctx.repos.projects.get(projectId)) throw badRequest(`Project ${projectId} does not exist`, 'unknown_project');
}
