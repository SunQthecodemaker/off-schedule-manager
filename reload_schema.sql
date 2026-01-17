-- Reload PostgREST schema cache
-- This is required after altering table columns (like adding is_temp)
NOTIFY pgrst, 'reload config';
