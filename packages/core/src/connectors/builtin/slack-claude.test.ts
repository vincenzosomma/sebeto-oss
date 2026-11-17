import { describe, expect, it } from 'vitest';
import { claudeReadArgs, claudeSlackCall, parseConnectorMessages, toolResultFromStream, type ClaudeExec } from './slack-claude.js';
import { slackMessageText } from './slack.js';

const CHANNEL = JSON.stringify({ messages: 'Channel: #security-alerts (C0SECALRT1)\n\n=== Message from EDR_Alert_Bot (B0EDRBOT01) at 2026-11-16 15:34:10 GMT === \nMessage TS: 1794843250.163159\n:large_yellow_circle: *EDR Alert – eBPF Program Loaded into Kernel*\n*Endpoint:* lab-01 (LINUX)\n\n> Detects eBPF\n\n=== Message from Sam <sam@example.com> (U0USER0001) at 2026-11-16 17:38:53 GMT ===\nMessage TS: 1794850733.982079\nBYOD HDMI cable in meeting room 2 doesnt seem to allow sharing to screen?\nThread: 3 replies (latest: 2026-11-16 17:41:35 GMT)\nReactions: ticket (1)', pagination_info: 'more' });

const THREAD = JSON.stringify({ messages: '=== THREAD PARENT MESSAGE ===\nFrom: Sam <sam@example.com> (U0USER0001)\nTime: 2026-11-16 17:38:53 GMT\nMessage TS: 1794850733.982079\nBYOD HDMI cable?\nReactions: ticket (1)\n\n=== THREAD REPLIES (2 total) ===\n\n--- Reply 1 of 2 ---\nFrom: Assist <botuser-T-B09@slack-bots.com> (U0ASSIST01)\nTime: 2026-11-16 17:38:55 GMT\nMessage TS: 1794850735.010939\n*[<https://x.atlassian.net/servicedesk/customer/portal/72/HELP-589|HELP-589>] BYOD HDMI*\n\n--- Reply 2 of 2 ---\nFrom: Alex <alex@example.com> (U0OWNER001)\nTime: 2026-11-16 17:41:35 GMT\nMessage TS: 1794850895.719009\nThanks for flagging this.\n' });

describe('Claude Slack connector output', () => {
  it('parses channel history: bots, people, multi-line text, thread counts; drops metadata lines', () => {
    const m = parseConnectorMessages(CHANNEL);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ ts: '1794843250.163159', bot_id: 'B0EDRBOT01', username: 'EDR_Alert_Bot' });
    expect(slackMessageText(m[0]!)).toContain('*Endpoint:* lab-01 (LINUX)');
    expect(m[0]!.text).toContain('> Detects eBPF');
    expect(m[1]).toMatchObject({ ts: '1794850733.982079', user: 'U0USER0001', username: 'Sam', reply_count: 3, text: 'BYOD HDMI cable in meeting room 2 doesnt seem to allow sharing to screen?' });
  });

  it('parses a thread; app bot users count as bots', () => {
    const m = parseConnectorMessages(THREAD);
    expect(m.map((x) => x.ts)).toEqual(['1794850733.982079', '1794850735.010939', '1794850895.719009']);
    expect(m[0]!.text).toBe('BYOD HDMI cable?');
    expect(m[1]!.bot_id).toBe('U0ASSIST01');
    expect(m[2]).toMatchObject({ user: 'U0OWNER001', username: 'Alex' });
  });

  it('takes the raw tool result from the stream, not the model text', () => {
    const tool = 'mcp__claude_ai_Slack__slack_read_channel';
    const stream = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: tool, input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: CHANNEL }] }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
    ].map((e) => JSON.stringify(e)).join('\n');
    expect(toolResultFromStream(stream, tool)).toEqual({ text: CHANNEL, isError: false });
    expect(toolResultFromStream(stream, 'mcp__other__x')).toBeNull();
  });

  it('locked-down arguments: only ToolSearch built in, one allowed tool, other servers disallowed', () => {
    const args = claudeReadArgs('mcp__claude_ai_Slack__slack_read_channel', ['mdm', 'claude.ai Gmail'], 'haiku');
    expect(args[args.indexOf('--tools') + 1]).toBe('ToolSearch');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__claude_ai_Slack__slack_read_channel');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('mcp__mdm,mcp__claude_ai_Gmail');
    expect(args).toContain('--no-session-persistence');
  });

  it('maps conversations.history / replies / users.info onto the connector', async () => {
    const prompts: string[] = [];
    const exec: ClaudeExec = async (args, stdin) => {
      prompts.push(stdin);
      const tool = args[args.indexOf('--allowedTools') + 1]!;
      const body = tool.endsWith('read_thread') ? THREAD : CHANNEL;
      const stream = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: tool, input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: body }] } },
      ].map((e) => JSON.stringify(e)).join('\n');
      return { code: 0, stdout: stream, timedOut: false };
    };
    const call = claudeSlackCall({ exec, otherServers: async () => ['claude.ai Slack', 'mdm'] });
    const h = await call<{ messages: Array<{ ts: string }> }>('conversations.history', { channel: 'C0SECALRT1', oldest: '1794843000.000000', limit: 100 });
    expect(h.messages).toHaveLength(2);
    expect(prompts[0]).toContain('{"channel_id":"C0SECALRT1","limit":100,"oldest":"1794843000.000000"}');
    const r = await call<{ messages: unknown[] }>('conversations.replies', { channel: 'C0HELPDSK1', ts: '1794850733.982079', limit: 20 });
    expect(r.messages).toHaveLength(3);
    expect((await call<{ user: { real_name: string } }>('users.info', { user: 'U0USER0001' })).user.real_name).toBe('Sam');
    await expect(call('chat.postMessage', {})).rejects.toThrow(/not available/);
  });

  it('retries a read once when it timed out (e.g. the computer slept), then gives up', async () => {
    let calls = 0;
    const ok: ClaudeExec = async (args) => {
      calls++;
      if (calls === 1) return { code: null, stdout: '', timedOut: true };
      const tool = args[args.indexOf('--allowedTools') + 1]!;
      const stream = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: tool, input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: CHANNEL }] } },
      ].map((e) => JSON.stringify(e)).join('\n');
      return { code: 0, stdout: stream, timedOut: false };
    };
    const h = await claudeSlackCall({ exec: ok })<{ messages: unknown[] }>('conversations.history', { channel: 'C0SECALRT1' });
    expect(h.messages).toHaveLength(2);
    expect(calls).toBe(2);
    let slow = 0;
    const never: ClaudeExec = async () => { slow++; return { code: null, stdout: '', timedOut: true }; };
    await expect(claudeSlackCall({ exec: never })('conversations.history', { channel: 'C0SECALRT1' })).rejects.toThrow(/too long/);
    expect(slow).toBe(2);
  });
});
