/**
 * Automatic ticket tags (2026-11-16): a free, deterministic keyword match on the ticket's title and
 * goal, so tickets arriving from #help-desk, Jira, mail… are sorted into IT categories without a model
 * call. Added to whatever tags the ticket already has; never removes one. Off with the workspace
 * setting `autoTags: false`.
 */

/** Category → words or phrases (lower case). Words match whole words; phrases match as written. */
export const AUTO_TAG_RULES: ReadonlyArray<{ tag: string; words: string[] }> = [
  { tag: 'access', words: ['access', 'permission', 'permissions', 'password', 'login', 'log in', 'sign in', 'mfa', '2fa', 'sso', 'locked out', 'unlock', 'reset', 'account', 'admin rights'] },
  { tag: 'software', words: ['install', 'installer', 'download', 'software', 'licence', 'license', 'application', 'app', 'update', 'upgrade', 'plugin'] },
  { tag: 'hardware', words: ['laptop', 'macbook', 'monitor', 'screen', 'keyboard', 'mouse', 'dock', 'docking', 'charger', 'headset', 'webcam', 'hardware', 'serial number', 'battery'] },
  { tag: 'network', words: ['dhcp', 'reservation', 'static ip', 'wifi', 'wi-fi', 'network', 'internet', 'ethernet', 'vpn', 'dns', 'firewall', 'quarantine', 'mac address', 'ip address', 'access point'] },
  { tag: 'email', words: ['email', 'e-mail', 'gmail', 'mailbox', 'calendar', 'distribution list', 'google group', 'mailing list'] },
  { tag: 'security', words: ['phishing', 'malware', 'virus', 'suspicious', 'security', 'breach', 'vulnerability', 'cve', 'edr', 'spam', 'scam'] },
  { tag: 'onboarding', words: ['onboarding', 'new starter', 'new joiner', 'joiner', 'starting on'] },
  { tag: 'offboarding', words: ['offboarding', 'leaver', 'leaving', 'return laptop', 'returning', 'last day'] },
  { tag: 'printer', words: ['printer', 'printing', 'print', 'scanner', 'ricoh'] },
  { tag: 'infrastructure', words: ['server', 'vm', 'virtual machine', 'proxmox', 'aws', 'gcp', 'nas', 'backup', 'storage'] },
];

/** At most this many category tags per ticket, strongest first. */
export const AUTO_TAG_MAX = 3;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = AUTO_TAG_RULES.map((r) => ({
  tag: r.tag,
  patterns: r.words.map((w) => new RegExp(`(?:^|[^a-z0-9])${escape(w)}(?:$|[^a-z0-9])`, 'i')),
}));

/** Category tags for this text, by number of matching words (title words count double). */
export function autoTags(input: { title: string; goal?: string }): string[] {
  const title = input.title.toLowerCase();
  const goal = (input.goal ?? '').toLowerCase().slice(0, 5000);
  const scored = compiled
    .map((r, i) => ({ tag: r.tag, i, score: r.patterns.reduce((n, p) => n + (p.test(title) ? 2 : 0) + (p.test(goal) ? 1 : 0), 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, AUTO_TAG_MAX).map((r) => r.tag);
}

/** The ticket's own tags first, then new automatic ones (no duplicates). */
export function withAutoTags(tags: string[], input: { title: string; goal?: string }): string[] {
  const out = [...tags];
  for (const t of autoTags(input)) if (!out.includes(t)) out.push(t);
  return out;
}
