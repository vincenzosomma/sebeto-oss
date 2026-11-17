/**
 * Contracts for the OAuth mail + calendar connectors (Microsoft 365 / Outlook.com and Google
 * Workspace / Gmail): see docs/26 Microsoft & Google Connectors.md.
 *
 * Provider clients are plain HTTP clients built on these interfaces:
 *  - they get an access token from a TokenSource (the OAuth module refreshes it; clients never see
 *    refresh tokens, client secrets or passwords),
 *  - they implement MailClient (same interface as the IMAP/SMTP Gmail connector, so the existing
 *    search_email / read_email / send_email tools work unchanged) and CalendarClient,
 *  - they throw MailError with a friendly message ('auth' when the token is rejected, 'network'
 *    when the service cannot be reached, 'invalid' for bad input, 'other' otherwise),
 *  - ids returned by search() are opaque strings the same client accepts in read().
 */
import type { MailClient } from './mail.js';

export type { MailClient, MailMessage, MailSummary } from './mail.js';
export { MailError, MAIL_SEARCH_MAX, MAIL_TEXT_MAX } from './mail.js';

export interface TokenSource {
  /** A valid access token (refreshed when needed). Throws MailError('auth') when sign-in is needed again. */
  getAccessToken(): Promise<string>;
  /** Called by clients after a 401 so the next getAccessToken() refreshes. */
  invalidate(): void;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  /** ISO 8601 with offset, or a date (YYYY-MM-DD) for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  organizer: string;
  /** Attendee display strings, max 50. */
  attendees: string[];
  /** Plain-text description, capped at 2,000 characters. */
  notes: string;
  /** Online meeting link if any (Teams / Meet). */
  joinUrl: string | null;
}

export interface CalendarClient {
  /** Events overlapping [from, to) on the user's primary calendar, sorted by start, max `limit` (≤ 50). */
  listEvents(q: { from: string; to: string; limit: number }): Promise<CalendarEvent[]>;
}

/** What a provider gives Sebeto once signed in. */
export interface ProviderClients {
  mail: MailClient;
  calendar: CalendarClient;
}

/** Signature each provider module exports (fetchImpl injectable for tests). */
export type ProviderClientFactory = (tokens: TokenSource, opts?: { fetchImpl?: typeof fetch }) => ProviderClients;
