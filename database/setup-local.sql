-- One-time local setup on the host PostgreSQL server. Creates the application database if missing.
-- Never touches existing databases and never uses the maintenance "postgres" database for the app.
--   PGPASSWORD=<your password> psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -f database/setup-local.sql
-- Then:  npm run migrate
SELECT 'CREATE DATABASE documind' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'documind')\gexec
