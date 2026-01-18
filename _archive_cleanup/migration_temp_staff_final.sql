-- [Temporary Staff Feature Migration]
-- 1. Add 'is_temp' column to allow distinguishing temporary staff
ALTER TABLE employees 
ADD COLUMN IF NOT EXISTS is_temp boolean DEFAULT false;

COMMENT ON COLUMN employees.is_temp IS 'True if the employee is a temporary staff member for scheduling only';

-- 2. Allow 'department_id' to be NULL (since temp staff usually don't have a department)
ALTER TABLE employees 
ALTER COLUMN department_id DROP NOT NULL;
