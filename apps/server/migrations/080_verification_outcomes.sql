-- Issue 4: separate security outcome from task outcome on verification runs. Additive only: every existing column
-- (including the legacy single-value result / prohibited_behavior_* / legitimate_behavior_worked) is untouched, and
-- historical rows keep NULL here. NULL means "not recorded": readers derive outcomes with outcomesForRun()
-- (@kw/schema), which infers a security outcome from legacy columns and never infers task success.
-- Each column holds JSON validated by @kw/schema (SecurityOutcome / TaskOutcome / ReportedTaskClaim).
ALTER TABLE verification_runs ADD COLUMN security_outcome TEXT;
ALTER TABLE verification_runs ADD COLUMN task_outcome TEXT;
ALTER TABLE verification_runs ADD COLUMN reported_task_claim TEXT;
