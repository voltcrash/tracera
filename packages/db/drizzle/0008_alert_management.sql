DELETE FROM "alert_subscriptions" AS older
USING "alert_subscriptions" AS newer
WHERE older.check_id = newer.check_id
  AND lower(older.email) = lower(newer.email)
  AND older.created_at < newer.created_at;
ALTER TABLE "alert_subscriptions" ADD COLUMN "last_notified_check_id" uuid;
ALTER TABLE "alert_subscriptions" ADD COLUMN "updated_at" timestamp with time zone NOT NULL DEFAULT now();
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_check_email_unique" UNIQUE ("check_id", "email");
