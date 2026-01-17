# Project Status Report & Handover (2026-01-15)

## 📌 Recent Updates (Session Summary)
1.  **Leave Management Repair**:
    *   Resolved `isSameOrBefore` / `isSameOrAfter` plugin errors by correctly importing Day.js plugins.
    *   Fixed "Save" functionality in Leave Management tab. (Database schema check added).

2.  **Settlement System Upgrade**:
    *   **Previous Period Carry-Over**: Added logic to calculate unused leave from the *previous* renewal period and allow managers to carry it over. Useful for initial setup or annual renewal.
    *   **Resignation Settlement**: Maintained existing logic for settling current remaining leave.
    *   **Editable Carry-Over**: Managers can now manually adjust the auto-calculated carry-over amount before saving.

3.  **Leave Request Features**:
    *   **Borrowing (당겨쓰기)**: Logic verified. It activates automatically when an employee requests more days that they currently have remaining.
    *   **Calendar Filtering**: Fixed a selector syntax error that prevented calendar filters (Pending/Approved/All) from working.
    *   **Monthly View**: Added a Month Picker to the Leave Request List to easily view past/future requests.

4.  **Admin & Structure**:
    *   **File Cleanup**: Unused/Legacy files moved to `_archive_20260115/` folder.
    *   **Active Files**: See list below.

## 📂 Active File Structure
| File Name | Description |
| :--- | :--- |
| `index.html` | Entry point. Imports styles and main scripts. |
| `main.js` | Main application entry. Routes to specific modules. |
| `management.js` | Core admin logic (Employees, Leave Requests, Settlement). |
| `schedule.js` | Schedule management logic (Calendar, Drag & Drop). |
| `employee-portal-final.js` | Employee-facing portal logic (Dashboard, Requests). |
| `documents.js` | Document submission and template management. |
| `leave-utils.js` | Leave calculation logic (Legal, Adjust, Used, Remaining). |
| `state.js` | Global state management store. |
| `utils.js` | Helper functions (Selectors, Visibility). |
| `style.css` | Global styles. |
| `server.js` | (Optional) Simple server script. |
| `migration_add_carried_over.sql` | SQL reference for `carried_over_leave` column. |

## 🚀 Next Steps (Pending)
1.  **Hospital Administrative Documents**:
    *   Identify necessary templates (Shift Change, Incident Report, etc.).
    *   Create HTML templates for these in the Document Management system.
2.  **User Verification**:
    *   Verify the "Monthly View" in Leave List works as expected.
    *   Verify "Borrowing" warnings appear correctly.

## 💡 Notes for Next Session
*   **Cache Issue**: If JS changes doesn't seem to reflect, perform a hard refresh (`Ctrl+Shift+R`) as the browser might cache `management.js`.
*   **Database**: Ensure `carried_over_leave` column exists in Supabase `employees` table.
