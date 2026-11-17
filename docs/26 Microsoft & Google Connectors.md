---
tags: [sebeto, connectors, oauth, email, calendar]
created: 2026-11-10
---

# Microsoft 365 / Outlook and Google connectors

Agents can **search and read email, read the calendar, and send email** (each email needs approval) for:
- **Microsoft:** work or school accounts (Microsoft 365) **and personal ones** (Outlook.com, Hotmail, Live);
- **Google:** Google Workspace **and personal Google accounts**.

The owner clicks **Sign in with Microsoft / Google**; no password is typed into Sebeto. Built on 2026-11-10; the app-password Gmail connector stays available ([23 Mail Connector](23%20Mail%20Connector.md)).

## For the owner
1. **Settings → Connectors → Microsoft 365 / Outlook** (or **Google (Gmail & Calendar)**) → **Sign in with …**.
2. Your browser opens the Microsoft or Google sign-in page. Pick your account and approve.
3. The browser returns to Sebeto on this computer and shows "Signed in". The Sebeto window updates by itself.
4. **Sign out** in the same dialog: Sebeto deletes its key. For Google the key is also revoked at Google. For Microsoft, the dialog links to account.microsoft.com/privacy/app-access, where you can remove Sebeto completely.

One mailbox is connected at a time: signing in replaces the Gmail app-password mailbox, and the other way round.

## What agents get
- **Tools:** `search_email`, `read_email`, `send_email` (same as before) and **`list_calendar_events`** (from/to, max 50).
- Gmail-style queries work on Microsoft too: `in:sent`, `is:unread`, `has:attachment`, `newer_than:7d`, `from:`, `subject:`.
- **Permissions:**
  - **Read your mailbox and calendar** asks once per ticket.
  - Every email sent asks.
  - Email and calendar content is untrusted: after reading it, outbound actions ask again.

## Security design
- **Authorization Code + PKCE** for a public desktop client (RFC 8252). The browser comes back to `http://localhost:<port>/oauth/callback` (Microsoft) or `http://127.0.0.1:<port>/oauth/callback` (Google) on Sebeto's own server.
  - That page needs no API token. It is protected by the loopback Host check, a **single-use 10-minute `state`**, and the PKCE verifier that never leaves the core.
  - The page shown in the browser has no scripts.
- **Tokens:**
  - the **refresh token** is stored encrypted (DPAPI on Windows);
  - **access tokens** stay in memory only and are refreshed shortly before they expire (one refresh at a time; rotated refresh tokens are kept).
  - The signed-in address comes from the ID token returned by the token endpoint.
- **Scopes:**
  - Microsoft: `openid offline_access email User.Read Mail.Read Mail.Send Calendars.Read`.
  - Google: `openid email gmail.readonly gmail.send calendar.readonly`.
  - Read-only plus send only: agents can't delete or move mail.
- **Which app is used:** your organization's app (entered in the dialog by IT) wins over Sebeto's **built-in shared app**.

## ⚠ To do once: register Sebeto's shared sign-in apps (the owner)
Until this is done, the dialog says "Sign-in is not set up in this copy of Sebeto yet". Organizations can still use their own app. The client IDs are **public** (not secrets). Put them in the environment (`SEBETO_MS_CLIENT_ID`, `SEBETO_GOOGLE_CLIENT_ID`, `SEBETO_GOOGLE_CLIENT_SECRET`) or in `packages/core/oauth-apps.json`:
```json
{ "microsoft": { "clientId": "…" }, "google": { "clientId": "….apps.googleusercontent.com", "clientSecret": "GOCSPX-…" } }
```

### Microsoft (personal + work accounts)
1. Go to https://entra.microsoft.com (a free Microsoft account works; a free Azure tenant may be created for you) → **App registrations → New registration**.
2. **Name:** Sebeto. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
3. **Redirect URI:** platform **Public client/native (mobile & desktop)**, value `http://localhost/oauth/callback` (any port is accepted on localhost).
4. **Authentication → Allow public client flows:** Yes.
5. **API permissions → Microsoft Graph → Delegated:** `User.Read`, `Mail.Read`, `Mail.Send`, `Calendars.Read`, `offline_access`. Admin consent is not needed for these, but some companies require it.
6. Copy the **Application (client) ID**.
7. Before going public: **publisher verification** (requires a Microsoft Partner Network ID). Otherwise users see "unverified" on the consent screen.

### Google (Workspace + personal accounts)
1. Go to https://console.cloud.google.com → a new project "Sebeto". **Enable** the Gmail API and the Google Calendar API.
2. **Google Auth Platform → Branding / Audience:** user type **External**. While the app is in **Testing**, add the Google accounts that may sign in as **test users** (yourself first).
3. **Data access:** add the scopes `gmail.readonly`, `gmail.send`, `calendar.readonly`.
4. **Clients → Create client → Desktop app.** Copy the client ID and the client secret. For desktop apps the secret is not confidential, but Google's token endpoint still wants it.
5. Before going public: Gmail read/send scopes require **Google verification** and a **security assessment** (this costs money). Until then the app works only for its test users and shows an "unverified app" warning. For personal Gmail, the app-password connector is a no-cost alternative.

## Technical
- **Code:**
  - `packages/core/src/connectors/oauth.ts` (flow, apps, tokens);
  - `graph.ts` (Microsoft Graph mail + calendar) and `google.ts` (Gmail + Calendar APIs), both built by sub-agents;
  - `clients.ts` (contracts), `mail.ts` (one connector for all providers), `services/oauth.ts`, `api/server.ts` (`/oauth/callback`);
  - UI: `SignInConnector.tsx`.
- **API:** `GET /connectors/oauth`, `PUT /connectors/oauth/{provider}` (organization app; empty clientId removes it), `POST /connectors/oauth/{provider}/start` → `{authUrl}`.
- **Tests:** 8 on the flow; 21 Graph and 24 Google with fake HTTP; an API test of the callback page (no token, Host check, escaping).
- **Verified on the running app (2026-11-10):**
  - The new cards appear.
  - Without an app, the dialog explains that sign-in is not set up and opens the organization-app form.
  - After entering an app ID, **Sign in with Microsoft** produced the correct link. **Microsoft accepted it** and showed its sign-in page.
  - A forged return link was refused by Sebeto's callback page.
  - **A real sign-in is still to be tested**, once a sign-in app is registered.
