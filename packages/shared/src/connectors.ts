/**
 * Connectors catalog and custom MCP servers (docs/25 Connectors & Custom MCP.md).
 * Agents never talk to an outside MCP server directly: Sebeto connects to it and re-exposes each
 * reviewed tool through its own tool server, behind the permission gate.
 */
import type { Id, IsoDate } from './types.js';

/**
 * How much a tool can do, decided by the owner when reviewing it:
 * read = looks things up (asks once per ticket); change = changes something (asks every time);
 * production = changes production systems (always asks); off = never offered to agents.
 */
export type ToolLevel = 'read' | 'change' | 'production' | 'off';
export const TOOL_LEVELS: readonly ToolLevel[] = ['read', 'change', 'production', 'off'] as const;

export interface ConnectorTool {
  /** The tool's name on the outside server. */
  name: string;
  description: string;
  level: ToolLevel;
  /** False for new tools, and for tools whose name/description/inputs changed since the last review. */
  reviewed: boolean;
  /** Level suggested by Sebeto (from the tool's hints and name), shown during review. */
  suggested: ToolLevel;
  /** JSON Schema of the inputs, as the server describes them. */
  inputSchema: Record<string, unknown>;
  /** Hash of name + description + inputs; a change means the tool must be reviewed again. */
  fingerprint: string;
}

export type ConnectorTransport =
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'http'; url: string }
  /** A server that ships inside Sebeto and runs in-process (no download, no child process). */
  | { type: 'builtin'; server: BuiltinServerId };

/** MCP servers that ship inside Sebeto (packages/core/src/connectors/builtin). */
export type BuiltinServerId = 'slack';
export const BUILTIN_SERVERS: readonly BuiltinServerId[] = ['slack'] as const;

/** An environment variable (stdio) or header (http) for the server; secret values are stored encrypted and never returned. */
export interface ConnectorSetting { name: string; secret: boolean; value?: string }

export type ConnectorStatus = 'connected' | 'error' | 'disabled' | 'not_started';

export interface ConnectorInfo {
  id: Id;
  name: string;
  /** Catalog entry this was created from ("custom" for your own server). */
  catalogId: string;
  transport: ConnectorTransport;
  /** Non-secret values are shown; secret ones only by name. */
  settings: ConnectorSetting[];
  enabled: boolean;
  /** null = every agent may use it; otherwise only these agents. */
  allowedAgents: Id[] | null;
  tools: ConnectorTool[];
  status: ConnectorStatus;
  error: string | null;
  createdAt: IsoDate;
}

export type CatalogAvailability = 'builtin' | 'preset' | 'custom' | 'planned';

export interface CatalogField {
  key: string;
  label: string;
  /** "path" = a folder on this computer; "secret" = stored encrypted. */
  kind: 'text' | 'path' | 'secret' | 'url';
  placeholder?: string;
  help?: string;
  /** The form does not require it. */
  optional?: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: 'Email & calendar' | 'Files' | 'Tickets & projects' | 'Code' | 'Chat' | 'Custom';
  description: string;
  /** What agents can do with it, in plain words. */
  capabilities: string;
  availability: CatalogAvailability;
  fields: CatalogField[];
}

export interface ConnectorsResponse { catalog: CatalogEntry[]; installed: ConnectorInfo[] }

/** POST /connectors: add from a preset (catalogId + values) or your own server (transport + settings). */
export interface AddConnectorBody {
  name: string;
  catalogId: string;
  /** Preset fields (e.g. { path: "D:\\Shares\\Runbooks" }). */
  values?: Record<string, string>;
  /** For catalogId "custom". */
  transport?: ConnectorTransport;
  settings?: ConnectorSetting[];
  allowedAgents?: Id[] | null;
}

/** PATCH /connectors/:id. Tool levels sent here count as reviewed. */
export interface UpdateConnectorBody {
  name?: string;
  enabled?: boolean;
  allowedAgents?: Id[] | null;
  tools?: Array<{ name: string; level: ToolLevel }>;
}
