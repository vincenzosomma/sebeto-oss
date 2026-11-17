import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, isLoopbackHost, loadConfig } from './config.js';

const TOKEN = 'a'.repeat(32);

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    const c = loadConfig({}, []);
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(7600);
    expect(c.workspaceDir).toBe(join(homedir(), '.sebeto', 'workspace'));
    expect(c.apiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(c.tokenProvided).toBe(false);
    expect(c.maxParallelRuns).toBe(3);
    expect(c.runtimes).toEqual(['mock', 'claude-cli', 'codex-cli', 'ollama', 'openai']);
    expect(c.uiDir).toBeUndefined();
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('generates a different token per launch', () => {
    expect(loadConfig({}, []).apiToken).not.toBe(loadConfig({}, []).apiToken);
  });

  it('reads env values', () => {
    const c = loadConfig(
      {
        SEBETO_WORKSPACE: 'ws',
        SEBETO_PORT: '0',
        SEBETO_TOKEN: TOKEN,
        SEBETO_UI_DIR: 'ui/dist',
        SEBETO_MAX_PARALLEL: '5',
        SEBETO_RUNTIMES: ' mock , ollama ,',
        SEBETO_ALLOWED_HOSTS: 'Sebeto.Lan',
      },
      [],
    );
    expect(c.workspaceDir).toBe(resolve('ws'));
    expect(c.port).toBe(0);
    expect(c.apiToken).toBe(TOKEN);
    expect(c.tokenProvided).toBe(true);
    expect(c.uiDir).toBe(resolve('ui/dist'));
    expect(c.maxParallelRuns).toBe(5);
    expect(c.runtimes).toEqual(['mock', 'ollama']);
    expect(c.allowedHosts).toEqual(['sebeto.lan']);
  });

  it('CLI flags override env', () => {
    const c = loadConfig({ SEBETO_PORT: '1234' }, ['--port', '4321', '--workspace=/tmp/x']);
    expect(c.port).toBe(4321);
    expect(c.workspaceDir).toBe(resolve('/tmp/x'));
  });

  it('reads the token from SEBETO_TOKEN_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sebeto-cfg-'));
    const file = join(dir, 'token');
    writeFileSync(file, `${TOKEN}\n`);
    const c = loadConfig({ SEBETO_TOKEN_FILE: file, SEBETO_HOST: '0.0.0.0' }, []);
    expect(c.apiToken).toBe(TOKEN);
    expect(c.tokenProvided).toBe(true);
  });

  it('fails on an unreadable or empty token file', () => {
    expect(() => loadConfig({ SEBETO_TOKEN_FILE: join(tmpdir(), 'nope-sebeto-missing') }, [])).toThrow(ConfigError);
    const dir = mkdtempSync(join(tmpdir(), 'sebeto-cfg-'));
    writeFileSync(join(dir, 't'), '  \n');
    expect(() => loadConfig({ SEBETO_TOKEN_FILE: join(dir, 't') }, [])).toThrow(/empty/);
  });

  it('refuses a non-loopback host without an explicit token', () => {
    expect(() => loadConfig({ SEBETO_HOST: '0.0.0.0' }, [])).toThrow(ConfigError);
    expect(() => loadConfig({ SEBETO_HOST: '192.168.1.10' }, [])).toThrow(/Refusing/);
    expect(() => loadConfig({}, ['--host', '0.0.0.0'])).toThrow(ConfigError);
    expect(loadConfig({ SEBETO_HOST: '0.0.0.0', SEBETO_TOKEN: TOKEN }, []).host).toBe('0.0.0.0');
  });

  it('allows loopback hosts without a token', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.2']) {
      expect(loadConfig({ SEBETO_HOST: host }, []).host).toBe(host);
    }
  });

  it('rejects short tokens and bad numbers', () => {
    expect(() => loadConfig({ SEBETO_TOKEN: 'short' }, [])).toThrow(/at least/);
    expect(() => loadConfig({ SEBETO_PORT: 'abc' }, [])).toThrow(ConfigError);
    expect(() => loadConfig({ SEBETO_PORT: '70000' }, [])).toThrow(ConfigError);
    expect(() => loadConfig({ SEBETO_MAX_PARALLEL: '0' }, [])).toThrow(ConfigError);
    expect(() => loadConfig({ SEBETO_RUNTIMES: ' , ' }, [])).toThrow(ConfigError);
  });
});

describe('isLoopbackHost', () => {
  it('classifies hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
  });
});
