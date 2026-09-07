/**
 * SQL fragment counting a poster's real photos (hero + each day's photo) —
 * shared everywhere a query joins `poster_trips p`, so the count is computed
 * the same way once. Selecting the poster's full `data` column to count photos
 * in JS instead cost 25s on the live catalogue, because that column carries
 * the whole layout.
 */
export const POSTER_PHOTO_COUNT_SQL = `(
  CASE WHEN COALESCE(p.data->>'hero_image', '') ~ '^(https://|data:image/)' THEN 1 ELSE 0 END
) + COALESCE((
  SELECT count(*) FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p.data->'days') = 'array' THEN p.data->'days' ELSE '[]'::jsonb END
  ) AS day
  WHERE day->>'photo' ~ '^(https://|data:image/)'
), 0)`;
