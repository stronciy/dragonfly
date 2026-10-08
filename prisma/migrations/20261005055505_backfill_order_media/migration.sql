-- Backfill order_media from legacy notification rows that stored uploaded files.
-- report/media POST always wrote type='report'; arbitration/media POST wrote
-- type='arbitration' with a data.url. Real arbitration notifications have no
-- data.url, so they are left untouched.
WITH moved AS (
  INSERT INTO "order_media" ("id", "order_id", "user_id", "kind", "name", "mime_type", "size", "url", "caption", "created_at")
  SELECT
    n."id",
    n."data"->>'orderId',
    n."user_id",
    CASE WHEN n."type" = 'report' THEN 'report' ELSE 'arbitration' END::"OrderMediaKind",
    NULLIF(n."data"->>'name', ''),
    NULLIF(n."data"->>'mimeType', ''),
    CASE WHEN n."data"->>'size' ~ '^[0-9]+$' THEN (n."data"->>'size')::integer ELSE NULL END,
    n."data"->>'url',
    NULLIF(n."data"->>'caption', ''),
    n."created_at"
  FROM "notifications" n
  WHERE (n."type" = 'report' OR (n."type" = 'arbitration' AND n."data"->>'url' IS NOT NULL))
    AND n."data"->>'orderId' IS NOT NULL
    AND n."data"->>'url' IS NOT NULL
  RETURNING "id"
)
DELETE FROM "notifications" n USING moved m WHERE n."id" = m."id";
