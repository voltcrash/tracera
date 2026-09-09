DELETE FROM "sessions" WHERE "expires_at" <= NOW();
DELETE FROM "verifications" WHERE "expires_at" <= NOW();

CREATE INDEX IF NOT EXISTS "verifications_expires_at_idx" ON "verifications" ("expires_at");

ALTER TABLE "checks"
  ADD CONSTRAINT "checks_input_type_check"
    CHECK ("input_type" IN ('text', 'link', 'image')),
  ADD CONSTRAINT "checks_visibility_check"
    CHECK ("visibility" IN ('public', 'private')),
  ADD CONSTRAINT "checks_private_owner_check"
    CHECK ("visibility" = 'public' OR "owner_user_id" IS NOT NULL),
  ADD CONSTRAINT "checks_lineage_reason_check"
    CHECK ("lineage_reason" IN ('first_check', 'related_story', 'scheduled_recheck'));

ALTER TABLE "trace_appearances"
  ADD CONSTRAINT "trace_appearances_occurrence_type_check"
    CHECK ("occurrence_type" IN ('first_check', 'exact_resubmission', 'related_story', 'scheduled_recheck'));

ALTER TABLE "claims"
  ADD CONSTRAINT "claims_claim_type_check"
    CHECK ("claim_type" IN ('factual_assertion', 'opinion', 'framing')),
  ADD CONSTRAINT "claims_checkability_check"
    CHECK ("checkability" IN ('checkable', 'needs_context', 'not_checkable')),
  ADD CONSTRAINT "claims_verdict_check"
    CHECK ("verdict" IS NULL OR "verdict" IN ('supported', 'contradicted', 'misleading', 'mixed', 'unverified')),
  ADD CONSTRAINT "claims_confidence_range_check"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  ADD CONSTRAINT "claims_evidence_quality_range_check"
    CHECK ("evidence_quality" IS NULL OR ("evidence_quality" >= 0 AND "evidence_quality" <= 1));

ALTER TABLE "domains"
  ADD CONSTRAINT "domains_trust_score_range_check"
    CHECK ("trust_score" >= 0 AND "trust_score" <= 1);

ALTER TABLE "domain_trust_events"
  ADD CONSTRAINT "domain_trust_events_signal_type_check"
    CHECK ("signal_type" IN ('verification_outcome', 'editorial_review')),
  ADD CONSTRAINT "domain_trust_events_previous_score_range_check"
    CHECK ("previous_score" >= 0 AND "previous_score" <= 1),
  ADD CONSTRAINT "domain_trust_events_proposed_score_range_check"
    CHECK ("proposed_score" >= 0 AND "proposed_score" <= 1),
  ADD CONSTRAINT "domain_trust_events_applied_score_range_check"
    CHECK ("applied_score" IS NULL OR ("applied_score" >= 0 AND "applied_score" <= 1));

ALTER TABLE "alert_subscriptions"
  ADD CONSTRAINT "alert_subscriptions_active_check"
    CHECK ("active" IN ('true', 'false'));

ALTER TABLE "decay_events"
  ADD CONSTRAINT "decay_events_event_type_check"
    CHECK ("event_type" IN ('scheduled', 'started', 'completed', 'changed', 'failed'));
