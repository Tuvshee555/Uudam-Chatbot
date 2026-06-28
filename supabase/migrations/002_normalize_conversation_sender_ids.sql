-- One-time migration: make old conversation history visible in the admin inbox.
--
-- Context: the app temporarily stored conversation sender_ids with a
-- "platform:pageId:psid" prefix, then switched to raw PSIDs. Old rows keep
-- the prefix and are invisible to the admin conversation API. This script
-- strips the prefix back to the raw PSID used by travel_senders.sender_id.

-- Normalize conversation history keys.
UPDATE travel_conversations
SET sender_id = substring(sender_id from '^[^:]+:[^:]+:(.+)$')
WHERE sender_id LIKE 'facebook:%:%' OR sender_id LIKE 'instagram:%:%';

-- Clean up ghost sender rows created by an earlier backfill that never
-- corresponded to an actual inbound message.
DELETE FROM travel_senders WHERE msg_count = 0;

-- After this runs, refresh sender display names separately by re-backfilling
-- from the Meta Conversations API matched on raw sender_id (UPDATE-only).
