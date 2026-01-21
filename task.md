# Project Tasks: Off-Schedule Manager

## 🚀 Current Status
- **Phase**: Stabilization & Refinement
- **Focus**: Verifying recent fixes (Schedule Saving, Mobile Views) and ensuring system reliability.

## ✅ Completed Tasks

### 1. Employee Management
- [x] **CRUD Operations**: Add, Edit, Delete employees.
- [x] **Department Management**: Add/Edit/Delete departments.
- [x] **Status Management**: Toggle between Active [재직자] and Retired [퇴사자] views.
- [x] **Resignation Handling**: "Retire" button with date picker; "Restore" functionality.
- [x] **Password Reset**: Admin ability to reset employee passwords.
- [x] **Bulk Registration**: Excel copy-paste support for adding multiple employees.

### 2. Schedule Management (Admin)
- [x] **Drag & Drop UI**: Calendar grid with drag-and-drop support for shifts.
- [x] **Team/Group Layout**: Organize employees by teams in the sidebar.
- [x] **Grid Positioning**: Logic to save and restore exact grid positions (`grid_position`).
- [x] **Fixed Grid Movement**: Implemented 'Swap' logic to prevent shifting during drag-and-drop.
- [x] **Save Logic**: Batch saving of schedule changes to Supabase.
- [x] **Conflict Handling**: Visual feedback for existing schedules.
- [x] **Sort Order Saving**: Ability to save the sidebar sort order.
- [x] **Right-Click Leave Registration**: Context menu for quick leave registration.
- [x] **Right-Click Leave Cancellation**: Cancel/Reject leaves contextually.

### 3. Employee Portal
- [x] **Authentication**: Separate login flows for Employees and Admins.
- [x] **Dashboard**: Summary of Leave (Final/Used/Remaining) and Renewal Date.
- [x] **Leave Requests**:
    - Calendar view for selecting dates.
    - Digital signature support (`signature_pad`).
    - Status tracking (Manager Approval -> Final Approval).
- [x] **Document Submission**:
    - Request system for specific documents (e.g., 경위서).
    - File attachment support (Supabase Storage).
    - UI for viewing submitted documents.
- [x] **Mobile Optimization**: Responsive layout adjustments (header wrapping, navigation).
- [x] **Read-Only Schedule View**: "Working" and "Off" view toggles for employees.

### 4. Advanced Features
- [x] **Signature Pad Integration**: For leave requests and document submissions.
- [x] **Supabase Integration**: Database (PostgreSQL) and Storage (Files) connected.
- [x] **Modals**: Reusable modal components for various actions.

## 🚧 Current & Pending Tasks
- [ ] **Data Verification**:
    - Verify that "Schedule Save" errors are fully resolved.
    - Confirm "No Worker" display issue in Employee Portal is fixed.
- [ ] **Code Cleanup**:
    - Remove unused files (e.g., older versions of `employee-portal.js`).
    - Consolidate repetitive logic in `schedule.js`.
- [ ] **Final QA**:
    - Test full flow: New Employee -> Schedule Assign -> Login -> Leave Request -> Approval.

## 📝 Work Log
- **2025-12-15**: Comprehensive work review; verified Position Management and Schedule Saving logic.
- **2025-12-13**: Fixed critical "Schedule Save" error and "15 records saved" message logic.
- **2025-12-12**: Refined Employee Portal UI (Department filters, Grid layout).
- **2025-12-11**: Implemented "Confirm Schedule" button & Mobile view improvements.
- **2025-12-08**: Added "Retire" button and Password Reset functionality.
- **2026-01-21**: Implemented Right-Click Context Menu for Leave Registration/Cancellation. Fixed persistent Service Worker caching issue and removed duplicate legacy code causing "Ghost Menu".
