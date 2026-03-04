import { state, db } from './state.js';
import { _, _all, show, hide } from './utils.js';
import { renderScheduleManagement } from './schedule.js?v=2.3';
import { assignManagementEventHandlers, getManagementHTML, getDepartmentManagementHTML, getLeaveListHTML, getLeaveManagementHTML, handleBulkRegister, getLeaveStatusHTML, addLeaveStatusEventListeners } from './management.js?v=2.3';
import { renderDocumentReviewTab, renderTemplatesManagement } from './documents.js?v=2.3';
import { renderEmployeePortal } from './employee-portal-final.js?v=2.3';
import { getLeaveDetails } from './leave-utils.js';

// Safely initialize dayjs plugins
if (window.dayjs_plugin_isSameOrAfter) {
    dayjs.extend(window.dayjs_plugin_isSameOrAfter);
} else {
    console.warn('⚠️ dayjs_plugin_isSameOrAfter not loaded');
}

if (window.dayjs_plugin_isSameOrBefore) {
    dayjs.extend(window.dayjs_plugin_isSameOrBefore);
} else {
    console.warn('⚠️ dayjs_plugin_isSameOrBefore not loaded');
}

// =========================================================================================
// 공유 함수
// =========================================================================================



// =========================================================================================
// 데이터 로딩 및 렌더링
// =========================================================================================

async function loadManagementData() {
    try {
        const [requestsRes, employeesRes, templatesRes, docsRes, issuesRes, departmentsRes, docRequestsRes] = await Promise.all([
            db.from('leave_requests').select('*').order('created_at', { ascending: false }),
            db.from('employees').select('*, departments(*)').order('id'),
            db.from('document_templates').select('*').order('created_at', { ascending: false }),
            db.from('submitted_documents').select('*').order('created_at', { ascending: false }),
            db.from('issues').select('*').order('created_at', { ascending: false }),
            db.from('departments').select('*').order('id'),
            db.from('document_requests').select('*').order('created_at', { ascending: false })
        ]);

        if (requestsRes.error) throw requestsRes.error;
        if (employeesRes.error) throw employeesRes.error;
        if (templatesRes.error) throw templatesRes.error;
        if (docsRes.error) throw docsRes.error;
        if (issuesRes.error) throw issuesRes.error;
        if (departmentsRes.error) throw departmentsRes.error;

        state.management.leaveRequests = requestsRes.data || [];
        state.management.employees = employeesRes.data || [];
        state.management.templates = templatesRes.data || [];
        state.management.submittedDocs = docsRes.data || [];
        state.management.issues = issuesRes.data || [];
        state.management.departments = departmentsRes.data || [];
        state.management.documentRequests = docRequestsRes.data || [];
    } catch (error) {
        console.error("관리 데이터 로딩 중 에러:", error);
        alert("관리 데이터를 불러오는 데 실패했습니다: " + error.message);
    }
}

window.loadAndRenderManagement = async () => {
    await loadManagementData();
    renderManagementContent();
}

function renderManagementContent() {
    const container = _('#admin-content');
    if (!container) return;

    const { activeTab } = state.management;
    console.log('🎯 현재 활성 탭:', activeTab);

    switch (activeTab) {
        case 'leaveList':
            container.innerHTML = getLeaveListHTML();
            // 달력 렌더링
            setTimeout(() => {
                if (typeof window.renderLeaveCalendar === 'function') {
                    window.renderLeaveCalendar();
                }
            }, 100);
            break;
        case 'schedule':
            renderScheduleManagement(container);
            break;
        case 'leaveStatus':
            container.innerHTML = getLeaveStatusHTML();
            addLeaveStatusEventListeners();
            break;
        case 'submittedDocs':
            renderDocumentReviewTab(container);
            break;
        case 'management':
            container.innerHTML = getManagementHTML();
            break;
        case 'leaveManagement':
            container.innerHTML = getLeaveManagementHTML();
            break;
        case 'department':
            container.innerHTML = getDepartmentManagementHTML();
            break;
        case 'templates':
            console.log('📝 서식 관리 탭 렌더링 시작');
            console.log('renderTemplatesManagement 함수:', renderTemplatesManagement);
            // ✨ 수정: 서식 관리 탭 렌더링
            renderTemplatesManagement(container);
            break;
        default:
            container.innerHTML = `<p>${activeTab} 탭의 콘텐츠가 준비되지 않았습니다.</p>`;
    }
}

function renderManagementTabs() {
    const { activeTab } = state.management;
    const container = _('#admin-tabs');
    if (!container) return;

    const tabs = [
        { id: 'leaveList', text: '연차 신청 목록' },
        { id: 'schedule', text: '스케줄 관리' },
        { id: 'submittedDocs', text: '서류 검토' },
        { id: 'leaveManagement', text: '연차 관리' },
        { id: 'leaveStatus', text: '연차 현황' },
        { id: 'management', text: '직원 관리' },
        { id: 'department', text: '부서 관리' },
        { id: 'templates', text: '서식 관리' },
    ];

    container.innerHTML = tabs.map(tab => `
        <button data-tab="${tab.id}" class="main-tab-btn px-3 py-2 text-sm ${tab.id === activeTab ? 'active' : ''}">${tab.text}</button>
    `).join('');
}

function renderAdminSummary() {
    const { employees, leaveRequests } = state.management;

    // 임시 직원 필터링 (알바 등)
    const validEmployees = employees.filter(emp => !emp.is_temp && !(emp.email && emp.email.startsWith('temp-')));

    let total = 0, used = 0, pending = 0;
    validEmployees.forEach(emp => { total += getLeaveDetails(emp).final; });
    leaveRequests.forEach(req => {
        if (req.status === 'approved') used += (req.dates?.length || 0);
        else if (req.status === 'pending') pending++;
    });
    _('#admin-summary').innerHTML = `
        <div class="bg-blue-100 p-4 rounded"><p>전체 확정 연차</p><p class="text-xl font-bold">${total}일</p></div>
        <div class="bg-green-100 p-4 rounded"><p>전체 사용 연차</p><p class="text-xl font-bold">${used}일</p></div>
        <div class="bg-red-100 p-4 rounded"><p>전체 잔여 연차</p><p class="text-xl font-bold">${total - used}일</p></div>
        <div class="bg-yellow-100 p-4 rounded"><p>승인 대기</p><p class="text-xl font-bold">${pending}건</p></div>
        <div class="bg-indigo-100 p-4 rounded"><p>이 직원 수</p><p class="text-xl font-bold">${validEmployees.length}명</p></div>
    `;
}

async function renderAdminPortal() {
    const portal = _('#admin-portal');
    portal.innerHTML = `
        <div class="max-w-full mx-auto">
             <div class="flex justify-between items-center mb-4">
                <h1 class="text-3xl font-bold">최고 관리자 포털</h1>
                <div class="text-right">
                    <p id="admin-welcome-msg" class="text-gray-700 text-sm font-semibold">${state.currentUser.name}님, 환영합니다.</p>
                    <button id="adminLogoutBtn" class="mt-1 px-3 py-1 text-sm bg-gray-300 rounded">로그아웃</button>
                </div>
             </div>
            <div id="admin-summary" class="grid grid-cols-2 sm:grid-cols-5 gap-4 text-center mb-6 text-sm"></div>
            <div id="admin-tabs" class="flex flex-wrap gap-4 mb-4 border-b"></div>
            <div id="admin-content" class="bg-white shadow rounded p-4 overflow-x-auto"></div>
        </div>`;

    _('#adminLogoutBtn').addEventListener('click', handleLogout);
    _('#admin-tabs').addEventListener('click', handleManagementTabClick);
    portal.addEventListener('click', (e) => {
        if (e.target.id === 'open-bulk-register-btn') {
            _('#bulk-employee-data').value = '';
            _('#bulk-register-result').innerHTML = '';
            show('#bulk-register-modal');
        }
    });

    await loadManagementData();
    renderAdminSummary();
    renderManagementTabs();
    renderManagementContent();
}

// =========================================================================================
// 인증 및 라우팅
// =========================================================================================

const handleManagementTabClick = (e) => {
    if (e.target.matches('.main-tab-btn')) {
        state.management.activeTab = e.target.dataset.tab;
        renderManagementTabs();
        renderManagementContent();
    }
}

async function handleAdminLogin(e) {
    e.preventDefault();
    const email = _('#adminLoginId').value;
    const password = _('#adminLoginPass').value;

    try {
        const { data, error } = await db.auth.signInWithPassword({ email, password });

        if (error) {
            console.error('Login Error:', error);
            if (error.message === 'Failed to fetch') {
                alert('로그인 실패: 서버와 통신할 수 없습니다. (CORS 또는 네트워크 오류)\nSupabase 대시보드에서 URL 설정을 확인해주세요.');
            } else {
                alert('로그인 실패: ' + error.message);
            }
            return;
        }

        if (data.user) {
            await checkAuth();
        }
    } catch (err) {
        console.error('Unexpected Login Error:', err);
        alert('로그인 중 예기치 않은 오류가 발생했습니다: ' + (err.message || err));
    }
}

async function handleLogout() {
    await db.auth.signOut();
    state.currentUser = null;
    state.userRole = 'none';
    await checkAuth();
}

function render() {
    _all('.page-section').forEach(el => el.classList.add('hidden'));
    if (state.userRole === 'admin') {
        show('#admin-portal');
        renderAdminPortal();
    } else if (state.userRole === 'employee') {
        show('#employee-portal');
        renderEmployeePortal();
    } else {
        show('#login-screen');
    }
}

async function checkAuth() {
    const { data: { session } } = await db.auth.getSession();

    if (session) {
        const { data: employee, error } = await db.from('employees')
            .select('*, departments(*)')
            .eq('email', session.user.email)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('직원 정보 조회 오류:', error);
            await handleLogout();
            return;
        }

        if (employee) {
            state.currentUser = employee;
            state.currentUser.auth_uuid = session.user.id;
            state.userRole = 'admin';
            state.management.activeTab = 'leaveList';
            assignManagementEventHandlers();
        } else {
            console.warn('인증된 사용자의 이메일이 직원 목록에 없습니다.');
            await handleLogout();
            return;
        }
    } else {
        state.currentUser = null;
        state.userRole = 'none';
    }
    render();
}

async function handleEmployeeLogin(e) {
    e.preventDefault();
    const name = _('#empLoginName').value.trim();
    const password = _('#empLoginPass').value;

    if (!name || !password) {
        alert('이름과 비밀번호를 입력해주세요.');
        return;
    }

    try {
        const { data: employee, error } = await db.from('employees')
            .select('*, departments(*)')
            .eq('name', name)
            .eq('password', password)
            .single();

        if (error || !employee) {
            alert('로그인 실패: 이름 또는 비밀번호가 일치하지 않습니다.');
            return;
        }

        state.currentUser = employee;
        state.userRole = 'employee';
        render();
    } catch (error) {
        console.error('직원 로그인 오류:', error);
        alert('로그인 중 오류가 발생했습니다: ' + error.message);
    }
}

function main() {
    _('#employeeLoginForm').addEventListener('submit', handleEmployeeLogin);
    _('#adminLoginForm').addEventListener('submit', handleAdminLogin);
    _('#goToOwnerLoginBtn').addEventListener('click', () => { hide('#employeeLoginContainer'); show('#ownerLoginContainer'); });
    _('#goToEmployeeLoginBtn').addEventListener('click', () => { show('#employeeLoginContainer'); hide('#ownerLoginContainer'); });
    _('#close-bulk-modal-btn').addEventListener('click', () => hide('#bulk-register-modal'));
    _('#cancel-bulk-submission-btn').addEventListener('click', () => hide('#bulk-register-modal'));
    _('#submit-bulk-register-btn').addEventListener('click', handleBulkRegister);

    window.addEventListener('afterprint', () => {
        const printTitleEl = _('#print-title');
        if (printTitleEl) printTitleEl.classList.add('hidden');
        document.body.classList.remove('printing');
    });

    checkAuth();
}

document.addEventListener('DOMContentLoaded', main);