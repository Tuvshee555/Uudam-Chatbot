# Meta-app migration: moving the UUDAM Page to app `uudam-v2`

The original Meta app is not in the owner's developer account: its ID is in no env var, its
tokens hold only `pages_messaging` + `public_profile`, data access expired 2026-09-10, and
`message_echoes` was never delivered. The new app **uudam-v2 (App ID 2959934047708039)** is
owned by the owner; this code supports running BOTH apps against the same Page and the same
deployment until an explicit cutover, with no change in behaviour while the `_NEXT` variables
are unset.

## How dual-app support works (this code)

| Concern | Old app only (today) | During migration | After cutover |
|---|---|---|---|
| Webhook signature | `META_APP_SECRET` | either secret verifies (`verifyMetaSignatureAny`) | both until the old app is removed |
| Webhook GET verify | `VERIFY_TOKEN` | either token (`VERIFY_TOKEN_NEXT`) | both |
| Sends / thread reads | `FACEBOOK_PAGES` tokens | unchanged | `FACEBOOK_PAGES_NEXT` replaces that page's token; `appsecret_proof` follows the token's own app |
| Duplicate deliveries | 2-min memory | events WITH a Meta `mid` are remembered 48 h (both apps deliver the same `mid`); button taps / mid-less events keep the 2-min window so a repeated legitimate tap is still answered | same |
| Echoes | never delivered | recorded observe-only (`travel_echo_events`, no message text); unknown app ids never count as a consultant | enforcement only after the matrix proves the split (`ECHO_TAKEOVER_MODE=enforce` + `ECHO_HUMAN_APP_IDS`) |
| Takeover enforcement | thread lookup | thread lookup (unchanged) | thread lookup until echo enforcement is proven |

New environment variables (all optional; nothing changes while unset):

- `META_APP_ID` — `2959934047708039`; classifies the bot's own echoes, shown in diagnostics.
- `META_APP_SECRET_NEXT` — the new app's App Secret (required before `FACEBOOK_PAGES_NEXT`).
- `VERIFY_TOKEN_NEXT` — a NEW random string for the new app's webhook handshake.
- `FACEBOOK_PAGES_NEXT` — `pageId:token` for the new app's Page token; **setting it IS the cutover**.
- `ECHO_TAKEOVER_MODE` — `observe` (default) or `enforce`.
- `ECHO_HUMAN_APP_IDS` — comma-separated app ids PROVEN to be human inbox surfaces.

## Owner's sequence (each step gated on the one before)

1. **Merge this branch** (no `_NEXT` vars set). Production behaviour changes only in two
   reviewed ways: 48-h duplicate memory for `mid` events, and "Ботод буцаах" now also stops an
   old consultant reply from re-pausing the conversation (`bot_released_at`).
2. **App basics** (developers.facebook.com → uudam-v2): icon, category, privacy-policy URL,
   data-deletion URL; link the app to the business portfolio that owns the Page; start
   Business Verification. Messenger use case → add `pages_messaging`, `pages_manage_metadata`,
   `pages_show_list`. Add a tester account (Roles).
3. **Connect the Page and generate the token** (Messenger API settings → add Page
   1010493442437235 → Generate token). In the Access Token Debugger confirm: App =
   2959934047708039, Page = 1010493442437235, scopes include `pages_messaging` +
   `pages_manage_metadata`, expires = Never. Store the token in the password manager only.
4. **Vercel, webhook phase** (Production env): set `META_APP_ID`, `META_APP_SECRET_NEXT`,
   `VERIFY_TOKEN_NEXT` (do NOT set `FACEBOOK_PAGES_NEXT` yet) → redeploy. Then in the app's
   Messenger settings: callback `https://<production-host>/api/webhook`, verify token =
   `VERIFY_TOKEN_NEXT`, Verify and save. Subscribe the Page to: `messages`,
   `messaging_postbacks`, `messaging_referrals`, `message_echoes`, `message_reads`. Nothing
   else.
5. **Test-user check** (app still in Development mode; only role users reach it): the tester
   messages the Page. Expect exactly ONE reply (both apps deliver; the 48-h `mid` memory
   absorbs the second). The reply's echo carries the OLD app's id — the first hard
   identification of the original app; note it down.
6. **Echo matrix** (observe-only, 3–7 days): `/api/admin/takeover-diagnostics` → `echoMatrix`.
   Collect at least: a bot reply, a desktop Business Suite reply, a phone-app reply, Meta's
   welcome greeting in a brand-new chat, each app in the Page's Business-integrations list.
   Only if human surfaces separate cleanly, set `ECHO_HUMAN_APP_IDS` and later
   `ECHO_TAKEOVER_MODE=enforce` in a separate, reviewed deploy.
7. **App Review + Live**: request Advanced Access for `pages_messaging` and
   `pages_manage_metadata`; after approval and Business Verification, switch the app to Live.
   An app in Development mode serves ONLY role users — never cut over before Live.
8. **Cutover**: set `FACEBOOK_PAGES_NEXT=1010493442437235:<new token>` → redeploy. Verify:
   replies arrive; echoes of bot replies carry `2959934047708039`; outbound ids recorded;
   diagnostics token scopes include `pages_manage_metadata`; no double replies. Watch 3–7
   days. The second page (…3582) is untouched unless it is given its own NEXT entry.
9. **Rollback** (any time before the old app is removed): delete `FACEBOOK_PAGES_NEXT` (or all
   `_NEXT` vars) and redeploy — or Vercel Instant Rollback. To silence the new app's
   deliveries immediately, unsubscribe the Page in ITS Messenger settings. Removing the OLD
   app from the Page's Business integrations is irreversible; do it only after a stable
   period, then fold the `_NEXT` values into the primary names.
