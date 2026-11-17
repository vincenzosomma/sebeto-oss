import { cpSync, existsSync } from 'node:fs';
if (existsSync('drizzle')) cpSync('drizzle', 'dist/drizzle', { recursive: true });
