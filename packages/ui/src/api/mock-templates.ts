/**
 * Demo-mode team templates: the five built-in teams of the core (packages/core/src/templates/builtins.ts)
 * in a simplified form (shorter skill instructions), so the "Add a team" dialog works with ?mock=1.
 */
import { TEMPLATE_FORMAT, type TeamTemplate, type TemplateSkill } from '@sebeto/shared';

const skill = (slug: string, name: string, description: string, instructions: string, needs: TemplateSkill['needs'] = ['fs.read', 'fs.write'], connectors: string[] = []): TemplateSkill =>
  ({ slug, name, description, instructions, needs, connectors });

const INCIDENT = skill('incident-summary', 'Incident summary', 'Groups incident exports by root cause, with examples.', '# Incident summary\n1. Group incidents by root cause.\n2. Top 5 causes with counts and examples.', ['fs.read']);
const NOTICE = skill('maintenance-notice', 'Maintenance notice', 'Writes short maintenance and change notices for staff.', '# Maintenance notice\n- Max 150 words. Never send without approval.', ['fs.write', 'email.send'], ['gmail']);
const CVE = skill('cve-triage', 'CVE triage', 'Matches new CVEs to our models and firmware and rates priority.', '# CVE triage\n1. Affected now / not affected / unknown.\n2. Propose the fix and a deadline.', ['web.read', 'fs.read']);
const TRIAGE = skill('ticket-triage', 'Ticket triage', 'Sort incoming requests by urgency and impact, and route each one.', '# Ticket triage\n- P1 to P4 with the impact x urgency rule.\n- Route to the right person.');
const KB = skill('knowledge-article', 'Knowledge-base article', 'Turn a solved ticket into a short how-to article.', '# Knowledge-base article\n- Title in the user\'s words, numbered steps, no secrets.');
const RUNBOOK = skill('runbook-writer', 'Runbook writer', 'Turns notes and command history into clear step-by-step runbooks.', '# Runbook writer\n- Numbered steps, a rollback, production steps marked.');
const CHANGE = skill('change-plan', 'Change plan', 'Prepare a safe change: risk, test, rollback, and the script to review first.', '# Change plan\n- Script in a file first, dry run, rollback. Production always asks.', ['fs.read', 'fs.write', 'script.run', 'prod.change']);
const CAPACITY = skill('capacity-report', 'Capacity report', 'Read usage exports and warn before something runs out.', '# Capacity report\n- Date each resource reaches 80% and 100%.');
const ACCESS = skill('access-review', 'Access review', 'Compare who has access with who should have it.', '# Access review\n- Leavers, unused accounts, admin rights without a reason. Never change access yourself.');

const NO_SEND = { 'email.send': 'never', 'script.run': 'never', 'prod.change': 'never' } as const;
const PIPELINE = skill('pipeline-review', 'Pipeline review', 'Find why a CI/CD pipeline fails and propose the fix.', '# Pipeline review\n- First real error, smallest fix as a diff, no secrets in logs.');
const RELEASE = skill('release-checklist', 'Release checklist', 'Steps, checks, approvals and rollback for a release.', '# Release checklist\n- Production steps marked; rollback and health checks.');
const POSTMORTEM = skill('incident-postmortem', 'Incident postmortem', 'Blameless postmortem: timeline, impact, cause, actions.', '# Incident postmortem\n- Blameless; actions with owners and dates.');
const SCOPE = skill('engagement-scope', 'Engagement scope check', 'Stop unless a written authorisation, scope and rules of engagement exist.', '# Engagement scope check\n- No written scope = no test. Out-of-scope targets are refused.');
const REPORT = skill('pentest-report', 'Security test report', 'Report findings of an authorised test for remediation.', '# Security test report\n- Risk, evidence (redacted), fix for each finding.');
const RED = { 'script.run': 'ask', 'web.read': 'ask', 'email.send': 'ask', 'tool.change': 'ask', 'prod.change': 'ask' } as const;

export const MOCK_TEMPLATES: TeamTemplate[] = [
  {
    format: TEMPLATE_FORMAT, id: 'service-desk', name: 'Service Desk team', builtin: true, suggestedConnectors: ['microsoft', 'gmail'],
    team: { name: 'Service Desk', color: '#0E5A8A', routingHints: 'password resets, account unlock, printers, laptops, Outlook, Microsoft Teams, email, access requests' },
    description: 'A lead who sorts and routes requests, plus an analyst for incidents, a writer for announcements and a writer for how-to articles.',
    agents: [
      { key: 'lead', name: 'Service Desk Lead', role: 'Service desk lead', reportsTo: null, job: 'Sort new requests and route them to the team.', skills: ['ticket-triage'] },
      { key: 'analyst', name: 'Incident Analyst', role: 'Incident analyst', reportsTo: 'lead', job: 'Find the real cause of incidents.', permissions: { ...NO_SEND }, skills: ['incident-summary'] },
      { key: 'comms', name: 'Comms Writer', role: 'Communications writer', reportsTo: 'lead', job: 'Write clear messages for staff.', permissions: { 'script.run': 'never' }, skills: ['maintenance-notice'] },
      { key: 'kb', name: 'Knowledge-base Writer', role: 'Knowledge-base writer', reportsTo: 'lead', job: 'Turn solved tickets into how-to articles.', permissions: { ...NO_SEND }, skills: ['knowledge-article'] },
    ],
    skills: [TRIAGE, INCIDENT, NOTICE, KB],
  },
  {
    format: TEMPLATE_FORMAT, id: 'infrastructure', name: 'Infrastructure team', builtin: true, suggestedConnectors: ['folder'],
    team: { name: 'Infrastructure', color: '#2E7D5B', routingHints: 'servers, VMware, Hyper-V, storage, backup, network, VPN, firewall, DNS, certificates' },
    description: 'A lead for servers and changes, a sysadmin assistant for checks and runbooks, an automation engineer for scripts (production changes always ask), and a capacity planner.',
    agents: [
      { key: 'lead', name: 'Infrastructure Lead', role: 'Infrastructure lead', reportsTo: null, job: 'Plan and review changes.', skills: ['change-plan'] },
      { key: 'sysadmin', name: 'Sysadmin Assistant', role: 'Systems administrator assistant', reportsTo: 'lead', job: 'Everyday checks and runbooks.', skills: ['runbook-writer', 'incident-summary'] },
      { key: 'automation', name: 'Automation Engineer', role: 'Automation engineer', reportsTo: 'lead', job: 'Scripts, reviewed first; production always asks.', permissions: { 'email.send': 'never', 'prod.change': 'ask' }, skills: ['change-plan', 'runbook-writer'] },
      { key: 'capacity', name: 'Capacity Planner', role: 'Capacity planner', reportsTo: 'lead', job: 'Warn before something runs out.', permissions: { ...NO_SEND }, skills: ['capacity-report'] },
    ],
    skills: [CHANGE, RUNBOOK, INCIDENT, CAPACITY],
  },
  {
    format: TEMPLATE_FORMAT, id: 'security', name: 'Security team', builtin: true, suggestedConnectors: ['folder'],
    team: { name: 'Security', color: '#B5532C', routingHints: 'CVE, vulnerabilities, patching, phishing, malware, security incidents, access reviews, hardening, SIEM' },
    description: 'A lead who sets priorities, a researcher who checks new vulnerabilities (asks before reading the web) and a reviewer who checks who has access to what.',
    agents: [
      { key: 'lead', name: 'Security Lead', role: 'Security lead', reportsTo: null, job: 'Keep the list of the biggest risks.', permissions: { ...NO_SEND }, skills: ['cve-triage'] },
      { key: 'cve', name: 'CVE Researcher', role: 'Vulnerability researcher', reportsTo: 'lead', job: 'Check new CVEs against our systems.', permissions: { ...NO_SEND, 'web.read': 'ask' }, skills: ['cve-triage'] },
      { key: 'access', name: 'Access Reviewer', role: 'Access reviewer', reportsTo: 'lead', job: 'Review who has access to what.', permissions: { ...NO_SEND, 'web.read': 'never' }, skills: ['access-review'] },
    ],
    skills: [CVE, ACCESS],
  },
  {
    format: TEMPLATE_FORMAT, id: 'devops', name: 'DevOps team', builtin: true, suggestedConnectors: ['folder'],
    team: { name: 'DevOps', color: '#7A4FA0', routingHints: 'CI/CD, pipelines, builds, deployments, releases, containers, Docker, Kubernetes, Terraform, monitoring, alerts' },
    description: 'A lead for delivery and reliability, a CI/CD engineer who fixes and improves pipelines, and a release and observability specialist (production changes always ask).',
    agents: [
      { key: 'lead', name: 'DevOps Lead', role: 'DevOps lead', reportsTo: null, job: 'Keep delivery fast and safe; review every production change.', permissions: { 'email.send': 'never' }, skills: ['release-checklist'] },
      { key: 'cicd', name: 'CI/CD Engineer', role: 'CI/CD pipeline engineer', reportsTo: 'lead', job: 'Fix failing pipelines; propose fixes as diffs.', permissions: { 'email.send': 'never' }, skills: ['pipeline-review'] },
      { key: 'release', name: 'Release & Observability Specialist', role: 'Release and observability specialist', reportsTo: 'lead', job: 'Releases with a rollback, alerts, postmortems.', permissions: { 'email.send': 'never' }, skills: ['release-checklist', 'incident-postmortem'] },
    ],
    skills: [PIPELINE, RELEASE, POSTMORTEM],
  },
  {
    format: TEMPLATE_FORMAT, id: 'red-team', name: 'Red Team', builtin: true, suggestedConnectors: ['folder'],
    team: { name: 'Red Team', color: '#8A3B5E', requireScope: true, routingHints: 'penetration test, pentest, red team exercise, attack simulation, phishing simulation, purple team' },
    description: 'Authorised security testing only: a written scope and rules of engagement first. Every command, web request, email, tool change and production change asks.',
    agents: [
      { key: 'lead', name: 'Red Team Lead', role: 'Red team lead', reportsTo: null, job: 'Only authorised tests: written scope and rules of engagement first; refuse targets outside the scope.', permissions: { ...RED }, skills: ['engagement-scope'] },
      { key: 'tester', name: 'Offensive Security Tester', role: 'Offensive security tester', reportsTo: 'lead', job: 'Test only inside the written scope; no denial of service, nothing destructive.', permissions: { ...RED }, skills: ['engagement-scope'] },
      { key: 'report', name: 'Security Reporting Specialist', role: 'Security test reporting specialist', reportsTo: 'lead', job: 'Report findings for remediation; never send the report yourself.', permissions: { ...RED }, skills: ['pentest-report'] },
    ],
    skills: [SCOPE, REPORT],
  },
];
