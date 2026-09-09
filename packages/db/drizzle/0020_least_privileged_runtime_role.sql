-- Keep the web application out of the owner role. Set the runtime password
-- outside migrations, then use the role created here for DATABASE_URL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracera_runtime') THEN
    CREATE ROLE tracera_runtime
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  ELSE
    ALTER ROLE tracera_runtime
      WITH LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tracera_runtime', current_database());
END
$$;

ALTER ROLE tracera_runtime SET search_path = public;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM tracera_runtime;
GRANT USAGE ON SCHEMA public TO tracera_runtime;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM tracera_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM tracera_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM tracera_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM tracera_runtime;

-- Better Auth's adapter owns the lifecycle of these four tables.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.users, public.sessions, public.accounts, public.verifications
  TO tracera_runtime;

-- Checks and their claims are append-only from the application role. Public
-- and private visibility is still enforced by the server until RLS is added.
GRANT SELECT, INSERT
  ON TABLE public.checks, public.claims, public.trace_appearances
  TO tracera_runtime;

-- Domain trust refinement is the only non-auth update path in the app.
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.domains
  TO tracera_runtime;
GRANT SELECT, INSERT
  ON TABLE public.domain_trust_events
  TO tracera_runtime;
