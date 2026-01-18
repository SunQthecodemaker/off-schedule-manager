-- Add is_temp column to employees table
ALTER TABLE employees 
ADD COLUMN IF NOT EXISTS is_temp boolean DEFAULT false;

COMMENT ON COLUMN employees.is_temp IS 'True if the employee is a temporary staff member for scheduling only';
