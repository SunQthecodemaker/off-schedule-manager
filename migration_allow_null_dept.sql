-- Allow department_id to be NULL for temporary staff
ALTER TABLE employees 
ALTER COLUMN department_id DROP NOT NULL;
