# UUDAM Instagram through the Ursgal hub

The original UUDAM Meta app has no Instagram permission (its token holds only `pages_messaging` and
`public_profile`, see `meta-app-migration.md`). The Meta app "Ursgal Digital" (1153306444307981) has
`instagram_basic` and `instagram_manage_messages`. Its one webhook is the hub at
https://www.ursgaldigital.com (repo `ursgal-digital-clean`), so UUDAM's Instagram account is
connected there and the hub forwards its events here.

Messenger does not change: it stays on `FACEBOOK_PAGES` and the UUDAM app.

## What the code does

| Concern | Behaviour |
|---|---|
| Signature | A delivery with `x-ursgal-signature` is checked against `URSGAL_HUB_SECRET` and `URSGAL_HUB_ROUTE_ID` (`ursgalHub.ts`, `ursgalHubClient.ts` copied unchanged from the hub). It must be signed in the last 5 minutes. It never carries Meta's signature. Without both settings every hub delivery gets 401. |
| What is answered | Only `object: "instagram"`. The hub's app is subscribed to the Page too. The hub drops UUDAM's Page events itself (`META_IGNORE_ACCOUNTS`, default the UUDAM Page, in the hub repo). Any non-Instagram event that still arrives is answered 200 and dropped here (`webhook.hub_event_ignored`): the UUDAM app already delivers Messenger. |
| Timing | The hub waits 8 seconds, then tells Meta to retry. A hub delivery is answered 200 at once, and the events are processed in the background (`waitUntil`, within `maxDuration`). A retry is absorbed by the 48-hour `mid` memory. |
| Token | For each Instagram entry, the hub lends the UUDAM Page's token (`POST /api/meta/page-token`). It is used only if the hub's Page is linked to that same Instagram account. It is kept in memory for 10 minutes (`lentPageTokens.ts`), never stored or logged. No token, no reply (`webhook.hub_token_unavailable`). |
| `appsecret_proof` | The hub sends its own proof with the token, since this deployment never holds the Ursgal app's secret. Every Graph call takes its proof from `appsecretProofFor` (`env.ts`). |
| Replies | Through the same paths as before (`deliverFastPathReply`, the model path), sent as the Instagram account (`POST /{ig-id}/messages`). |
| Echoes | Recorded in `travel_echo_events` with `delivered_by = 'hub'`. A consultant's Instagram reply does **not** pause the bot yet: the echo is observed only, as on Messenger before 2026-10-31. Staff pause an Instagram customer in the admin panel. Enforcement comes only after the echo matrix shows which app ids staff replies carry. |

## Settings (Vercel → uudam-chatbot → Production only)

| Variable | Value | Sensitive |
|---|---|---|
| `URSGAL_HUB_ROUTE_ID` | the route id shown at /holboh/admin (16 hex characters) | no |
| `URSGAL_HUB_SECRET` | the route secret, shown **once** when the route is created | yes |
| `URSGAL_HUB_PAGE_ID` | optional; default is the first `FACEBOOK_PAGES` page (UUDAM, 1010493442437235) | no |
| `URSGAL_HUB_URL` | optional; default `https://www.ursgaldigital.com` | no |

The build preflight stops a deploy that has only half of these, or a value in the wrong form. The
live deployment keeps serving. Vercel applies variables only to new deployments: Redeploy after a
change.

## Connecting, in this order

1. Deploy this code. With no `URSGAL_*` variable it changes nothing.
2. At https://www.ursgaldigital.com/holboh/admin, create a route.
   - Name: Uudam.
   - Webhook URL: `https://uudam-chatbot.vercel.app/api/webhook`.
   - Put its id and secret in the two variables above, then Redeploy.
3. At https://www.ursgaldigital.com/holboh, log in with an account that is admin of the UUDAM Page.
   Choose **UUDAM Travel Agency** and its Instagram account. The Instagram account must be a
   professional account linked to that Page.
4. At /holboh/admin, assign the UUDAM Page to the Uudam route **right away**. The hub never answers
   UUDAM's Messenger (`META_IGNORE_ACCOUNTS`). Until the Page is assigned, though, the hub's general
   assistant would answer its Instagram. Before App Review it can only reach people with a role on
   the Ursgal Digital app.
5. Test: an Instagram account with a role on the Ursgal Digital app (until App Review, nobody else gets
   a reply) sends the UUDAM Instagram account a question about a trip. Expect exactly one reply, and in
   the logs:
   - `webhook.received` with `deliveredBy: "hub"`;
   - `meta.instagram.request_success`.
6. When App Review approves `instagram_manage_messages` for the Ursgal Digital app, every customer gets
   answers. Nothing else to change.

## Stopping it

- Disconnect UUDAM at https://www.ursgaldigital.com/holboh/huudas. The hub unsubscribes the Page and
  deletes its token.
- Do **not** delete the Uudam route or assign the Page to «Hub-ийн туслах»: either one hands UUDAM's
  Instagram messages to the hub's general assistant.
- Do not remove the two variables while the Page is still routed here. Every delivery would be refused,
  and the hub would keep telling Meta to retry.
