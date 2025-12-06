import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://chnqtrmlglqdmzqwsazm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNobnF0cm1sZ2xxZG16cXdzYXptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0ODUxOTksImV4cCI6MjA3MDA2MTE5OX0.HBvXKoFAQsIjyePoMgtOpYZePoOHO9dYekcAsY1G6gQ';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ✅ REST API 호출을 위해 URL과 Key 노출
db.supabaseUrl = SUPABASE_URL;
db.supabaseKey = SUPABASE_ANON_KEY;

export const state = {
    currentUser: null,
    userRole: 'none',
    employee: {
        activeFilters: new Set(['pending', 'approved']),
        issues: [],
        documentRequests: [],
        submittedDocuments: [],
        activeTab: 'leave',
        selectedDates: []
    },
    manager: {
        activeMainTab: 'myInfo',
    },
    management: {
        activeTab: 'leaveList',
        leaveRequestView: 'list',
        leaveRequests: [],
        employees: [],
        departments: [],
        templates: [],
        submittedDocs: [],
        issues: [],
        documentRequests: [],
        activeFilters: new Set(['pending', 'approved']),
        editingTemplateId: null,
        positions: [],
    },
    schedule: {
        currentDate: dayjs().format('YYYY-MM-DD'),
        viewMode: 'working',
        teamLayout: null,
        schedules: [],
        calendarInstance: null,
        sortableInstances: [],
    },
    docSubmission: {
        currentTemplate: null,
        currentRequestId: null,
    }
};