# ANTIGRAVITY Handover Document
**Last Updated**: 2026-01-30

## 1. System Architecture Pivot
We have moved away from the complex "Excel-like Grid" UI to a more robust **"Local-First"** approach.

### A. UI Layout (Flow Layout)
*   **Decision**: Reverted `4-Column Grid` in favor of `Flex Flow Layout`.
*   **Reason**: User feedback indicated the grid was rigid and unresponsive.
*   **Key Files**: `schedule.js` (Rendering), `style.css` (Flexbox).
*   **Features**: Drag & Drop, Multi-Select, Context Menu are fully supported.

### B. Data Integrity (Smart Import)
*   **Problem**: AppSheet/Excel data often conflicts with real-time Leave data in the Web DB.
*   **Solution**: **"Local-First" Priority Logic**.
    *   When importing from AppSheet, if a user has an `approved` leave in `leave_requests`, the import logic **excludes** their work schedule.
    *   **Alert**: Users get a summary of excluded schedules.
*   **Key File**: `appsheet-client.js` (`importFromAppSheet` function).

## 2. Environment Status
*   **Windows Environment**: `$HOME` variable is missing, preventing Puppeteer (Browser Tests) from running.
*   **Action**: Manual verification is currently required for UI interactions.

## 3. Next Steps for Developer
1.  **Deploy GAS**: Ensure the Google Apps Script is deployed and the URL is set in the Web App via "Settings".
2.  **Monitor Conflicts**: Watch for user feedback on the "Conflict Alert" during import.
3.  **Optimize Drag & Drop**: If lists get too long, consider virtual scrolling (though current size is manageable).
