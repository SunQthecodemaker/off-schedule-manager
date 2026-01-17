// Supabase는 index.html에서 UMD 스크립트로 로드됨
// window.supabase 객체가 로드되었는지 확인
if (typeof window.supabase === 'undefined') {
    console.error('CRITICAL: Supabase library not loaded directly. Check index.html script tags.');
    alert('시스템 초기화 오류: 데이터베이스 라이브러리를 불러오지 못했습니다. 페이지를 새로고침하세요.');
}

const createClient = window.supabase ? window.supabase.createClient : null;

const SUPABASE_URL = 'https://chnqtrmlglqdmzqwsazm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNobnF0cm1sZ2xxZG16cXdzYXptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0ODUxOTksImV4cCI6MjA3MDA2MTE5OX0.HBvXKoFAQsIjyePoMgtOpYZePoOHO9dYekcAsY1G6gQ';

export const db = createClient ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

if (db) {
    // ✅ REST API 호출을 위해 URL과 Key 노출
    db.supabaseUrl = SUPABASE_URL;
    db.supabaseKey = SUPABASE_ANON_KEY;
} else {
    console.error('Supabase client creation failed');
}

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