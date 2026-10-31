# Meta-app migration: UUDAM Page → app `uudam-v2` (App ID 2959934047708039)

The original Meta app is outside the owner's control (its ID is in no env var, its token holds
only `pages_messaging` + `public_profile`, data access expired 2026-09-10, and `message_echoes`
was never delivered). This code lets the old app and `uudam-v2` serve the same Page from the
same deployment, moving over in explicit, reversible stages. With no new variable set, the
running behaviour is today's, except the two reviewed fixes listed under "On merge".

## What the code does

| Concern | Behaviour |
|---|---|
| Webhook signature | A delivery verifies with EITHER app secret; the receipt (`webhook.inbound_received`) records `deliveredBy: current \| next`. |
| Webhook handshake | `VERIFY_TOKEN` or `VERIFY_TOKEN_NEXT`. |
| Which app sends | `META_NEXT_SEND`: `off` (default) → old app for everyone; `testers` → new app ONLY for the PSIDs in `META_NEXT_TESTER_IDS`; `all` → new app for every customer of the pages in `FACEBOOK_PAGES_NEXT` (the cutover: sends, thread reads, alerts, crons). `appsecret_proof` always uses the secret of the app that issued the token. |
| Duplicates | Both apps deliver every event with the same Meta `mid`. Events with a `mid` are remembered 48 h; button taps / events without a `mid` keep the 2-minute window, so a customer tapping the same menu button again is answered. |
| Echoes | Recorded observe-only in `travel_echo_events` (app id, metadata flag, lengths, attachment types, delivering app — never text). The bot's own echoes are known by its send metadata or `META_APP_ID`. Unknown app ids NEVER count as a consultant. Echo-based takeover needs `ECHO_TAKEOVER_MODE=enforce` + proven `ECHO_HUMAN_APP_IDS`, a later decision. The thread lookup stays the enforcement path. |
| `standby` events | Never answered (Meta: "Do not respond to standby messages"); counted as `webhook.standby_observed`. |
| Bad settings | Fail SAFE: an invalid migration variable is ignored as a whole (old app keeps serving), logged as `env.meta_migration_settings_ignored`, shown in diagnostics — and the build preflight refuses to deploy it. |
| Evidence | `GET /api/admin/takeover-diagnostics` → `migration` (flags, `nextTokens` = Meta's own check of the stored new token: valid, `appIdMatches`, `pageMatches`, `hasRequiredScopes`, expiry) and `echoMatrix` (what each app id actually sent). |

**On merge (no variable set) two behaviours change immediately:** the 48-h `mid` memory, and
"Ботод буцаах" now records `bot_released_at` so an old consultant reply still in the thread can
no longer re-pause a conversation staff handed back. Everything else waits for the variables.

## Vercel variables (Production scope ONLY — never Preview or Development)

| Variable | Value | When | Sensitive |
|---|---|---|---|
| `META_APP_ID` | `2959934047708039` | Stage 1 | no |
| `META_APP_SECRET_NEXT` | uudam-v2 → App settings → Basic → App secret | Stage 1 | yes |
| `VERIFY_TOKEN_NEXT` | a NEW random string, 32+ characters, used nowhere else | Stage 1 | yes |
| `FACEBOOK_PAGES_NEXT` | `1010493442437235:<uudam-v2 page token>` | Stage 2 (holding it sends nothing) | yes |
| `META_NEXT_TESTER_IDS` | the testers' page-scoped ids (PSIDs), comma-separated | Stage 4 | no |
| `META_NEXT_SEND` | `testers` (Stage 4), then `all` (Stage 6) | Stage 4 / 6 | no |
| `ECHO_TAKEOVER_MODE`, `ECHO_HUMAN_APP_IDS` | **do not set** — only after the echo matrix proves a split | later | no |

No other variable is needed. The second page (596733917653582) has no NEXT entry and stays on the
old app. Vercel applies a variable only to NEW deployments: after every change, Deployments →
latest Production → ⋯ → Redeploy. A bad value fails that build; the live deployment keeps serving.

## Stages (each one only after the previous is verified)

### Stage 0 — App setup in developers.facebook.com → uudam-v2
1. App settings → Basic: app icon, category, Privacy Policy URL, User data deletion URL; link the
   app to the business portfolio that owns the UUDAM Page. Do not share the App secret anywhere but
   Vercel and the password manager.
2. App settings → Advanced → Security: leave "Require app secret" OFF for now (parity with the old
   app; a few page-token calls — customer names, PDF uploads — do not send `appsecret_proof` yet).
3. Use cases → "Engage with customers on Messenger from Meta" → Customize → Permissions: add
   `pages_messaging`, `pages_manage_metadata`, `pages_show_list`. Nothing else.
4. App roles → Roles → add each tester (owner/staff accounts) as Tester; they accept at
   developers.facebook.com/requests. While unpublished the app reaches ONLY these people.
5. If not yet done: Business Settings → Security Center → start Business Verification (App Review
   may ask for it).

### Stage 1 — Accept the new app's webhook (no token yet)
6. Vercel: set `META_APP_ID`, `META_APP_SECRET_NEXT`, `VERIFY_TOKEN_NEXT` → Redeploy.
7. Diagnostics → `migration`: `metaAppId` = 2959934047708039, `metaAppSecretNextSet` and
   `verifyTokenNextSet` true, `ignoredSettingIssues` empty.

### Stage 2 — Connect the Page and generate the token
8. Messenger API Settings → "Generate access tokens" → connect Page **UUDAM Travel Agency
   (1010493442437235)** with a Page admin account → Generate → copy the token once.
   More durable (not tied to a person's login): Business Settings → System users → Admin system
   user → assign uudam-v2 and the Page → Generate token (same three permissions) → Graph API
   Explorer `GET /me/accounts` with it → the Page's `access_token`.
9. Access Token Debugger (developers.facebook.com/tools/debug/accesstoken): App ID
   2959934047708039, Type Page, Page 1010493442437235, scopes include `pages_messaging` and
   `pages_manage_metadata`, Expires: Never. Anything else: regenerate, do not continue.
10. Vercel: `FACEBOOK_PAGES_NEXT=1010493442437235:<token>` → Redeploy. Diagnostics →
    `migration.nextTokens[0]`: `valid`, `appIdMatches`, `pageMatches`, `hasRequiredScopes` all true.
    Customers are still answered by the old app (`nextSend: off`).

### Stage 3 — Webhook and subscriptions for uudam-v2
11. Messenger API Settings → "Configure webhooks": Callback URL
    `https://uudam-chatbot.vercel.app/api/webhook`, Verify token = the `VERIFY_TOKEN_NEXT` value →
    Verify and save.
12. Subscribe Page 1010493442437235 (the page row's webhook subscriptions, or
    `POST /v25.0/1010493442437235/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_referrals,message_echoes`
    with the new page token) to exactly: **`messages`, `messaging_postbacks`,
    `messaging_referrals`, `message_echoes`**. Not `message_reads` (the bot never uses it),
    `message_deliveries`, `standby`, or `feed`. The old app's own subscription is untouched.
13. Meta Business Suite → Settings → Conversation routing (or
    facebook.com/settings?tab=msgr_conversation_routing): note whether a default app is set and
    which. Meta: "Only the default app can send a message when the thread is idle" and other apps
    then receive `standby` instead of messages. No default app = all connected apps receive and
    may respond.

### Stage 4 — Test users (app still in Development mode)
14. A tester messages the Page. Expect exactly ONE reply (old app). Evidence (diagnostics / ask
    Claude to read it): two `webhook.inbound_received` receipts, `deliveredBy` `current` and `next`,
    one `webhook.inbound_duplicate`; an `echoMatrix` row from `delivered_by: next` with
    `has_bot_metadata: true` and the OLD app's id — the first hard identification of the original
    app. If no `next` receipt appears, the routing from step 13 gives the conversation to another
    app: stop and report it.
15. Vercel: `META_NEXT_TESTER_IDS=<tester PSIDs>` (Claude can read them from the database by the
    tester's name), `META_NEXT_SEND=testers` → Redeploy. The tester messages again: the reply now
    comes through uudam-v2 (echo row with app id 2959934047708039 + metadata). All other customers
    stay on the old app.

### Stage 5 — Echo matrix (observe only), App Review, Live
16. In a tester's conversation produce one of each and note the time: a bot reply; a consultant
    reply typed in Business Suite on a computer; a consultant reply from the phone app; Meta's
    welcome greeting (a tester who never wrote to the Page); any away/instant reply; each app
    listed in the Page's Business integrations. `echoMatrix` then shows which app id each origin
    carries. Enforcement stays off unless the matrix shows human surfaces with app ids no
    automation shares — a separate reviewed change.
17. App Review → request Advanced Access for `pages_messaging` and `pages_manage_metadata`, with a
    screencast of a tester receiving the bot's reply through uudam-v2 (Stage 4). The Page must be
    published and the webhook answering 200. Meta's checklist also asks for a brief welcome on the
    Get Started postback; the bot deliberately stays quiet there (the Page's own greeting covers
    it) — mention this in the submission.
18. After approval (and Business Verification if required): switch the app to Live.

### Stage 6 — Cutover
19. If step 13 showed a default app: set **uudam-v2** as the default app.
20. Vercel: `META_NEXT_SEND=all` → Redeploy.
21. Verify within 15 minutes: `migration.pagesOnNextToken` lists …7235; a non-tester account gets
    a reply; new `echoMatrix` bot rows carry 2959934047708039; no `webhook.send.primary_failed`;
    each message answered once. Watch 3–7 days.

## Rollback (any stage, until the old app is removed)
- Vercel: `META_NEXT_SEND=off` (or delete it) → Redeploy; or Deployments → the previous
  Production deployment → Instant Rollback. If step 19 changed the default app, set it back.
- To stop uudam-v2's deliveries entirely: unsubscribe the Page in uudam-v2's Messenger settings
  (deliveries are harmless meanwhile — duplicates are absorbed).
- Removing the OLD app from the Page's Business integrations is irreversible: only after a stable
  period, and only from the UUDAM Page (the second page still uses it). Folding the `_NEXT` values
  into the primary variable names is a separate, planned change.
