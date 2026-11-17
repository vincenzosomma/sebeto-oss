/** Minimal message catalogues (en, it). Keys are added by the UI as it grows. */
export type Locale = 'en' | 'it';

export const STATUS_LABELS: Record<Locale, Record<'backlog' | 'in_progress' | 'needs_you' | 'blocked' | 'done', string>> = {
  en: { backlog: 'Backlog', in_progress: 'In progress', needs_you: 'Needs you', blocked: 'Blocked', done: 'Completed' },
  it: { backlog: 'Da fare', in_progress: 'In corso', needs_you: 'Serve te', blocked: 'Bloccato', done: 'Completato' },
};

export const PERMISSION_LABELS: Record<Locale, Record<'fs.read' | 'fs.write' | 'web.read' | 'email.read' | 'email.send' | 'tool.read' | 'tool.change' | 'script.run' | 'prod.change' | 'memory.read' | 'memory.write' | 'ticket.create', string>> = {
  en: {
    'fs.read': 'Read files in its ticket folder',
    'fs.write': 'Edit files (snapshot first)',
    'web.read': 'Read web pages',
    'email.read': 'Read your mailbox',
    'email.send': 'Send emails',
    'tool.read': 'Use connector tools that look things up',
    'tool.change': 'Use connector tools that change things',
    'script.run': 'Run scripts',
    'prod.change': 'Change production systems',
    'memory.read': 'Search past sessions (team memory)',
    'memory.write': 'Propose memory notes (you approve them)',
    'ticket.create': 'Delegate work to teammates (create tickets)',
  },
  it: {
    'fs.read': 'Leggere i file della cartella del ticket',
    'fs.write': 'Modificare file (con snapshot)',
    'web.read': 'Leggere pagine web',
    'email.read': 'Leggere la tua casella email',
    'email.send': 'Inviare email',
    'tool.read': 'Usare strumenti dei connettori che consultano',
    'tool.change': 'Usare strumenti dei connettori che modificano',
    'script.run': 'Eseguire script',
    'prod.change': 'Modificare i sistemi di produzione',
    'memory.read': 'Cercare nelle sessioni passate (memoria del team)',
    'memory.write': 'Proporre note di memoria (le approvi tu)',
    'ticket.create': 'Delegare lavoro ai colleghi (creare ticket)',
  },
};
