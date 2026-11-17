/** Public entry of @sebeto/core for embedding and tests. The process entry point is main.ts. */
export * from './contracts.js';
export { loadConfig, isLoopbackHost, ConfigError, DEFAULT_PORT, type SebetoConfig } from './config.js';
export { createLogger, redactUrl, type SebetoLogger, type LoggerOptions } from './logger.js';
export { createServer, openApiSpec, tokenMatches, type ServerOptions, type HttpToolServer } from './api/index.js';
export * from './services/index.js';

// Module factories (implemented in parallel modules; re-exported for embedding).
export { openDatabase } from './storage/index.js';
export { createJobQueue } from './queue/index.js';
export { createEventBus } from './bus/index.js';
export { createStateMachine } from './state/index.js';
export { createPermissionGate } from './gate/index.js';
export { createSnapshots } from './snapshots/index.js';
export { createRuntimeRegistry, createMockAdapter, createClaudeCliAdapter } from './runtimes/index.js';
export { createToolServer } from './tools/index.js';
export { createExecutor } from './executor/index.js';
export { createScheduler } from './scheduler/index.js';
export * from './connectors/index.js';
export * from './settings.js';
export * from './skills/index.js';
export { createTemplateStore, BUILTIN_TEMPLATES, parseTemplate, type TemplateStore } from './templates/index.js';
export { createSecurityLog, instrumentContext, runWithActor, emergencyStop, releaseLockdown, type SecurityLog } from './security/index.js';
