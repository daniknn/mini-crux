-- Everything extraction needs about one creative. `media_url` is signed and may already be
-- dead; media.land() only falls back to it when the bytes are not already in storage.
select c.id,
       c.workspace_id,
       c.creative_hash,
       c.media_type::text as media_type,
       c.media_url
from public.creatives c
where c.id = $1::uuid
