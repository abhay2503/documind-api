-- One-time local setup on the host MySQL server (run as an admin user):
--   sudo mysql < database/setup-local.sql
-- Change the password here AND in your .env before running.
CREATE DATABASE IF NOT EXISTS documind CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'documind'@'localhost' IDENTIFIED BY 'change-me-local';
CREATE USER IF NOT EXISTS 'documind'@'127.0.0.1' IDENTIFIED BY 'change-me-local';
GRANT ALL PRIVILEGES ON documind.* TO 'documind'@'localhost';
GRANT ALL PRIVILEGES ON documind.* TO 'documind'@'127.0.0.1';
FLUSH PRIVILEGES;
