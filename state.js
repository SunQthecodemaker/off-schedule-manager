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
    viewAs: 'employee',
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

// 알바(스케줄러 자유배치용 임시직원) — 항상 연차/관리 시스템에서 격리
export function isAlbaEmployee(emp) {
    if (!emp) return false;
    return !!(emp.is_temp && emp.email && emp.email.startsWith('temp-'));
}

// 테스트 직원 — 이름 또는 부서 이름에 "테스트" 포함. admin 한테만 표시
export function isTestEmployee(emp, departments) {
    if (!emp) return false;
    if (emp.name && emp.name.includes('테스트')) return true;
    const depts = departments || (state.management && state.management.departments) || [];
    const dept = depts.find(d => d.id === emp.department_id);
    if (dept && dept.name && dept.name.includes('테스트')) return true;
    return false;
}

// 다음달 1일 cutoff 계산 (메인 화면 격리용)
function startOfNextMonth(dateStr) {
    if (!dateStr) return null;
    return dayjs(dateStr).add(1, 'month').startOf('month').format('YYYY-MM-DD');
}

/**
 * 직원 상태 분류 — 단일 헬퍼.
 * 우선순위: alba > test > retired > on_leave > hidden > active
 *
 * 퇴사 판정: emp.retired===true 즉시 retired,
 *           또는 emp.resignation_date <= dateStr 면 retired
 *           (다음달 1일 cutoff 정책은 isVisibleIn 컨텍스트별로 적용)
 *
 * @param {Object} emp - 직원 객체
 * @param {string} [dateStr] - 기준일 (YYYY-MM-DD), 미지정 시 오늘
 * @returns {'alba'|'test'|'retired'|'on_leave'|'hidden'|'active'|'unknown'}
 */
export function getEmployeeStatus(emp, dateStr) {
    if (!emp) return 'unknown';
    const d = dateStr || dayjs().format('YYYY-MM-DD');
    if (isAlbaEmployee(emp)) return 'alba';
    if (isTestEmployee(emp)) return 'test';
    if (emp.retired) return 'retired';
    if (emp.resignation_date && d >= emp.resignation_date) return 'retired';
    if (emp.leave_start_date && d >= emp.leave_start_date) {
        if (!emp.return_date || d < emp.return_date) return 'on_leave';
    }
    if (emp.schedule_visible === false) return 'hidden';
    return 'active';
}

/**
 * 컨텍스트별 직원 노출 여부 — 단일 진입점.
 * 메인 화면(leave_review·schedule_grid)은 퇴사 다음달 1일까지 노출, 그 후 격리.
 * 직원 관리 테이블(employee_list_*)은 즉시 cutoff.
 *
 * @param {'leave_review'|'schedule_grid'|'employee_list_active'|'employee_list_retired'} context
 * @param {Object} emp
 * @param {Object} [viewer] - viewer state (userRole, viewAs). 미지정 시 전역 state.
 */
export function isVisibleIn(context, emp, viewer) {
    if (!emp) return false;
    if (isAlbaEmployee(emp)) return false; // 알바는 모든 컨텍스트에서 격리

    const v = viewer || state;
    const isAdminView = v.userRole === 'admin' || v.viewAs === 'admin';
    const today = dayjs().format('YYYY-MM-DD');

    const onLeave = emp.leave_start_date
        && today >= emp.leave_start_date
        && (!emp.return_date || today < emp.return_date);

    switch (context) {
        case 'leave_review': {
            // 연차 검수·연차 관리·연차 현황 — active 직원만 노출
            // 테스트 직원은 admin 또는 매니저뷰(viewAs=admin)에게만 노출 (PR #17 정책)
            if (emp.retired) return false;
            if (emp.resignation_date && today >= startOfNextMonth(emp.resignation_date)) return false;
            if (isTestEmployee(emp) && !isAdminView) return false;
            if (onLeave) return false; // 휴직 직원도 검수칸에서 격리
            return true;
        }
        case 'schedule_grid': {
            // 스케줄 관리 전체 (메인 그리드·sidebar 배치·cell) — active 만 노출.
            // alba/test/휴직/퇴사/hidden 모두 격리.
            if (emp.retired) return false;
            if (emp.resignation_date && today >= startOfNextMonth(emp.resignation_date)) return false;
            if (emp.schedule_visible === false) return false;
            if (isTestEmployee(emp)) return false;
            if (onLeave) return false;
            return true;
        }
        case 'employee_list_active': {
            // 직원 관리 [활성] 탭 — 즉시 cutoff
            if (emp.retired) return false;
            if (emp.resignation_date && emp.resignation_date <= today) return false;
            return true;
        }
        case 'employee_list_retired': {
            // 직원 관리 [퇴사자] 탭 — 즉시 cutoff
            if (emp.retired) return true;
            return !!(emp.resignation_date && emp.resignation_date <= today);
        }
        default:
            return true;
    }
}

// 호환 래퍼 (기존 호출부가 있다면 동작 유지). 신규 코드는 isVisibleIn('leave_review', ...) 사용.
export function isVisibleForLeaveContext(emp) {
    return isVisibleIn('leave_review', emp);
}

// ═══════════════════════════════════════════════════════
// 부서 순서 — 단일 source of truth
// 모든 화면 (검수칸·사이드바 부서 풀·연차 dropdown 등) 이 이 순서대로 직원 표시
// ═══════════════════════════════════════════════════════
export const DEPT_ORDER = ['원장', '진료실', '경영지원실', '기공실'];

/**
 * 직원 배열을 부서 순서 + 같은 부서 내 ID 순으로 정렬한 새 배열 반환.
 * @param {Array} employees - 정렬할 직원 배열
 * @param {Array} [departments] - 부서 배열 (id→name 매핑용). 미지정 시 state.management.departments
 * @returns {Array} 정렬된 새 배열 (원본 변경 안 함)
 */
export function sortByDeptOrder(employees, departments) {
    if (!Array.isArray(employees)) return [];
    const depts = departments || (state.management && state.management.departments) || [];
    const deptNameMap = {};
    depts.forEach(d => { deptNameMap[d.id] = d.name; });

    const deptIdx = (emp) => {
        const name = deptNameMap[emp.department_id] || '';
        const idx = DEPT_ORDER.indexOf(name);
        return idx === -1 ? 99 : idx; // 미지정 부서는 끝으로
    };

    return employees.slice().sort((a, b) => {
        const di = deptIdx(a) - deptIdx(b);
        if (di !== 0) return di;
        return (a.id || 0) - (b.id || 0); // 같은 부서 내 ID 순
    });
}