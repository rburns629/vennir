-- The team a task runs for (proto/vertra/kernel/v1: Task.for_team), which
-- may not be the team it runs in: request.json's forTeam. NULL: none (a
-- task from before it, or a caller that didn't say).
ALTER TABLE execution_tasks ADD COLUMN for_team text;
