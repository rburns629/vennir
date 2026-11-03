-- The order a scheduler pass reads READY tasks in, a page at a time past
-- held ones (scheduler/claiming.go): (available_at, id), READY only.
CREATE INDEX ix_execution_tasks_ready_order ON execution_tasks (available_at, id) WHERE state = 'READY';
