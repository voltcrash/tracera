CREATE TABLE "media_diet_preferences" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "frequency" varchar(16) NOT NULL DEFAULT 'monthly',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
