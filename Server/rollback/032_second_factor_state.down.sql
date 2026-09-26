-- Rollback of 032. The four tables hold live second-factor state: in-flight
-- login challenges, pending enrolments, spent TOTP codes and emergency
-- recovery codes. Dropping them signs out every partially authenticated
-- login, cancels every enrolment in progress, and invalidates every
-- emergency recovery code an account was issued. A pre-032 server keeps the
-- same state in memory, so it starts empty either way.
DROP TABLE IF EXISTS totp_recovery_codes;
DROP TABLE IF EXISTS totp_used_codes;
DROP TABLE IF EXISTS pending_totp_enrollments;
DROP TABLE IF EXISTS partial_auth_challenges;
DELETE FROM schema_versions WHERE version = '032_second_factor_state.sql';
