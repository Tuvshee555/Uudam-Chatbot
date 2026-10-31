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
| Echoes | Every echo is recorded in `travel_echo_events` (app id, metadata flag, lengths, attachment types, delivering app, `verdict` — never text). The bot's own echoes are known by its send metadata or `META_APP_ID`. With `ECHO_TAKEOVER_MODE=enforce`, an echo from an app in `ECHO_HUMAN_APP_IDS` pauses the customer at once **only if Meta's own record of that message proves a consultant** (`echoObserver.ts verifyHumanEcho` with `staffTakeover.ts classifyThread`: `source:mobile`, or a `source:web` message that passes the automation tests in "Echo evidence" below). Unknown app ids, automations and messages Meta's record does not show yet NEVER count as a consultant; the thread lookup on the next customer message stays the backstop. A consultant's take-over lasts until «Ботод буцаах» (2026-10-31; it used to end after three days). |
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
| `ECHO_TAKEOVER_MODE` | `enforce` (set 2026-10-31 after the evidence below; `observe` turns echo takeover off again) | done | no |
| `ECHO_HUMAN_APP_IDS` | `263902037430900` — Meta's inbox app (Business Suite / Pages app) | done | no |

### Echo evidence (production, 2026-10-31)

104 echoes of 80 messages, each matched by `mid` to Meta's own record (Conversations API tags) and to
the bot's recorded send ids:

| App id | Meta's record | Bot evidence | Count | What it is |
|---|---|---|---|---|
| `1350045020372966` (Uudam-chatbot) | `source:web` | send metadata + recorded id | 17 | the bot |
| `263902037430900` (Meta inbox) | `source:mobile` | none | 57 | consultants on the phone app |
| `263902037430900` (Meta inbox) | `source:web`, 2–6 s after the customer | none | 5 | Meta's automated replies |
| `263902037430900` (Meta inbox) | `source:pages:private_reply` | none | 1 | a comment private reply |

So the inbox app id covers people AND automations: it is only a candidate, never proof. No desktop
(Business Suite on a computer) consultant reply had been seen yet; it is `source:web` from the same
app, told from an automation by timing, exactly as the thread check has done since 2026-10-30.

**14-day study (300 real threads, 2026-10-31).** 1,261 consultant messages were from the phone app; none
from a computer. Every Page message the old rules read as a desktop consultant was Meta's own: a
returning customer's welcome burst, "Lead stage set to …" (50 conversations), a comment private-reply
notice, a personalised automated reply 21 s after the customer. A `source:web` message now counts as a
consultant only if it is none of: within 20 s of the customer's message; within 5 s of a Meta
automation/notice; a Meta notice; the conversation's opener; a verbatim repeat of an earlier Page
message; 40+ characters arriving faster than 6 a second since the customer wrote. The bot's own reply
opens no window (9% of real take-overs come within 20 s of it). Replayed on the same threads: 0
desktop false positives (was 4), phone detection unchanged. **Known gap:** a desktop consultant's
FIRST reply within 20 s of the customer's message still reads as an automation (`test.todo` in
`tests/human-takeover-journeys.test.ts`, live desktop test pending).

### uudam-v2's page webhook — REMOVED 2026-10-31 11:40 UTC (duplicates), backup below

Since the original app holds `message_echoes` (09:35 → 11:40 UTC: every customer message was delivered by
both apps; every echo too, minus rows lost to database connection timeouts), uudam-v2's app-level
`page` webhook subscription was deleted to stop the duplicate deliveries. The app, its secret, its page
token and every `*_NEXT` Vercel variable are untouched; `META_NEXT_SEND` stays `off`. The deleted
configuration, to restore it (Stage 1–2 of a future cutover):

```
POST https://graph.facebook.com/v25.0/2959934047708039/subscriptions
  object=page
  callback_url=https://uudam-chatbot.vercel.app/api/webhook
  fields=message_echoes,messages,messaging_postbacks,messaging_referrals   (versions were v26.0)
  verify_token=<VERIFY_TOKEN or VERIFY_TOKEN_NEXT — either is accepted by the webhook handshake>
  access_token=2959934047708039|<uudam-v2 App secret>
```

Then confirm with `GET /2959934047708039/subscriptions` and, after the next customer message, that
`webhook.inbound_received` shows `deliveredBy: next` again.

No other variable is needed. The second page (596733917653582, "Uudam travel - AI") has no NEXT entry.
As of 2026-10-31 it is not in use: no customer message since receipts began (2026-10-30), no echo, its
last customer document 2026-07-09; its token lost every page permission and Meta no longer shows the
page to the app. It stays in `FACEBOOK_PAGES` unchanged (harmless); renew it only if the page is
brought back. Vercel applies a variable only to NEW deployments: after every change, Deployments →
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
