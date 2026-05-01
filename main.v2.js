import { state, db } from './state.js';
import { _, _all, show, hide } from './utils.js';
import { renderScheduleManagement } from './schedule.js?v=20260422b';
import { assignManagementEventHandlers, getManagementHTML, getDepartmentManagementHTML, getLeaveListHTML, getLeaveManagementHTML, handleBulkRegister, getLeaveStatusHTML, addLeaveStatusEventListeners } from './management.js?v=20260501a';
import { renderDocumentReviewTab, renderTemplatesManagement } from './documents.js?v=20260426a';
import { renderEmployeePortal, getManagerPerm } from './employee-portal-final.js?v=20260501b';
import { getLeaveDetails } from './leave-utils.js';
import { loadPendingChanges, approvePendingChange, rejectPendingChange, approveAllPending, rejectAllPending } from './staging.js?v=20260426a';

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
        state.management.employees = (employeesRes.data || []).map(e => ({ ...e, entryDate: e.entryDate || e.entry_date }));
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
            setTimeout(() => {
                if (typeof window.renderLeaveCalendar === 'function') {
                    window.renderLeaveCalendar();
                }
                applyEditPermissionForManagerView();
            }, 100);
            break;
        case 'schedule':
            renderScheduleManagement(container);
            setTimeout(applyEditPermissionForManagerView, 100);
            break;
        case 'leaveStatus':
            container.innerHTML = getLeaveStatusHTML();
            addLeaveStatusEventListeners();
            applyEditPermissionForManagerView();
            break;
        case 'submittedDocs':
            renderDocumentReviewTab(container);
            setTimeout(applyEditPermissionForManagerView, 100);
            break;
        case 'management':
            container.innerHTML = getManagementHTML();
            applyEditPermissionForManagerView();
            break;
        case 'leaveManagement':
            container.innerHTML = getLeaveManagementHTML();
            applyEditPermissionForManagerView();
            break;
        case 'department':
            container.innerHTML = getDepartmentManagementHTML();
            applyEditPermissionForManagerView();
            break;
        case 'templates':
            renderTemplatesManagement(container);
            setTimeout(applyEditPermissionForManagerView, 100);
            break;
        default:
            container.innerHTML = `<p>${activeTab} 탭의 콘텐츠가 준비되지 않았습니다.</p>`;
    }
}

// admin-portal 탭 ↔ manager_permissions 메뉴 키 매핑
const TAB_TO_PERM_KEY = {
    leaveList: 'leave_request_list',
    schedule: 'schedule',
    submittedDocs: 'document_review',
    leaveManagement: 'leave_management',
    leaveStatus: 'leave_status',
    management: 'employee_management',
    department: 'department',
    templates: 'form',
};

function renderManagementTabs() {
    const { activeTab } = state.management;
    const container = _('#admin-tabs');
    if (!container) return;

    const allTabs = [
        { id: 'leaveList', text: '연차 신청 목록' },
        { id: 'schedule', text: '스케줄 관리' },
        { id: 'submittedDocs', text: '서류 검토' },
        { id: 'leaveManagement', text: '연차 관리' },
        { id: 'leaveStatus', text: '연차 현황' },
        { id: 'management', text: '직원 관리' },
        { id: 'department', text: '부서 관리' },
        { id: 'templates', text: '서식 관리' },
    ];

    // 매니저 화면이면 perm.view=true 인 탭만
    const isManagerView = state.userRole !== 'admin' && state.currentUser?.isManager;
    const tabs = isManagerView
        ? allTabs.filter(t => getManagerPerm(TAB_TO_PERM_KEY[t.id]).view)
        : allTabs;

    // 활성 탭이 노출 목록에 없으면 첫 노출 탭으로 보정
    if (isManagerView && !tabs.find(t => t.id === activeTab) && tabs.length) {
        state.management.activeTab = tabs[0].id;
    }

    container.innerHTML = tabs.map(tab => `
        <button data-tab="${tab.id}" class="main-tab-btn px-3 py-2 text-sm ${tab.id === state.management.activeTab ? 'active' : ''}">${tab.text}</button>
    `).join('');
}

/** 매니저 화면에서 perm.edit=false 인 탭의 input/button 비활성화 */
function applyEditPermissionForManagerView() {
    const isManagerView = state.userRole !== 'admin' && state.currentUser?.isManager;
    if (!isManagerView) return;
    const { activeTab } = state.management;
    const perm = getManagerPerm(TAB_TO_PERM_KEY[activeTab]);
    if (perm.edit) return;
    const container = _('#admin-content');
    if (!container) return;
    container.querySelectorAll('input, select, textarea, button').forEach(el => {
        if (el.matches('[data-keep-enabled]')) return;
        if (el.tagName === 'BUTTON') {
            el.style.display = 'none';
        } else {
            el.disabled = true;
            el.classList.add('bg-gray-100', 'cursor-not-allowed');
        }
    });
}

function renderAdminSummary() {
    const { employees, leaveRequests } = state.management;
    let total = 0, used = 0, pending = 0;
    employees.forEach(emp => { total += getLeaveDetails(emp).final; });
    leaveRequests.forEach(req => {
        if (req.status === 'approved') used += (req.dates?.length || 0);
        else if (req.status === 'pending') pending++;
    });
    _('#admin-summary').innerHTML = `
        <div class="dash-card"><p>전체 확정 연차</p><p class="text-xl font-bold">${total}일</p></div>
        <div class="dash-card"><p>전체 사용 연차</p><p class="text-xl font-bold">${used}일</p></div>
        <div class="dash-card dash-card-accent"><p>전체 잔여 연차</p><p class="text-xl font-bold">${total - used}일</p></div>
        <div class="dash-card dash-card-warn"><p>승인 대기</p><p class="text-xl font-bold">${pending}건</p></div>
        <div class="dash-card dash-card-dark"><p>이 직원 수</p><p class="text-xl font-bold">${employees.length}명</p></div>
    `;
}

async function renderAdminPortal() {
    const portal = _('#admin-portal');
    const isManagerView = state.userRole !== 'admin' && state.currentUser?.isManager;
    const title = isManagerView ? '매니저 화면' : '최고 관리자 포털';
    const backBtn = isManagerView
        ? `<button id="exitManagerViewBtn" class="px-3 py-1 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded transition-colors">← 직원 화면으로</button>`
        : '';

    portal.innerHTML = `
        <div class="max-w-full mx-auto">
             <div class="flex justify-between items-center mb-4">
                <h1 class="text-3xl font-bold">${title}</h1>
                <div class="text-right">
                    <p id="admin-welcome-msg" class="text-gray-700 text-sm font-semibold">${state.currentUser.name}님${isManagerView ? '' : ', 환영합니다.'}</p>
                    <div class="mt-1 flex gap-2 justify-end flex-wrap">
                        ${backBtn}
                        <button id="adminLogoutBtn" class="px-3 py-1 text-sm bg-gray-300 rounded">로그아웃</button>
                    </div>
                </div>
             </div>
            <div id="approval-banner-container"></div>
            <div id="admin-summary" class="grid grid-cols-2 sm:grid-cols-5 gap-4 text-center mb-6 text-sm"></div>
            <div id="admin-tabs" class="flex flex-wrap gap-4 mb-4 border-b"></div>
            <div id="admin-content" class="bg-white shadow rounded p-4 overflow-x-auto"></div>
        </div>`;

    _('#adminLogoutBtn').addEventListener('click', handleLogout);
    _('#admin-tabs').addEventListener('click', handleManagementTabClick);
    _('#exitManagerViewBtn')?.addEventListener('click', () => {
        state.viewAs = 'employee';
        sessionStorage.setItem('viewAs', 'employee');
        window.dispatchEvent(new CustomEvent('viewAs:change'));
    });
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
    if (!isManagerView) await renderApprovalBanner();
}

// =========================================================================================
// 매니저 임시저장 승인 배너 (관리자 포털 상단)
// =========================================================================================
async function renderApprovalBanner() {
    const container = _('#approval-banner-container');
    if (!container) return;

    const items = await loadPendingChanges();
    if (!items.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="mb-4 bg-yellow-50 border-2 border-yellow-400 rounded-lg p-4 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3">
                <span class="text-2xl">⏳</span>
                <div>
                    <p class="font-bold text-yellow-800">매니저가 제출한 변경 ${items.length}건 대기 중</p>
                    <p class="text-sm text-yellow-700">실제 데이터에 반영하려면 검토 후 승인하세요.</p>
                </div>
            </div>
            <div class="flex gap-2">
                <button id="approve-all-pending-btn" class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-bold">전체 승인</button>
                <button id="review-pending-btn" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-bold">개별 검토</button>
                <button id="reject-all-pending-btn" class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">전체 반려</button>
            </div>
        </div>
    `;

    _('#approve-all-pending-btn').onclick = async () => {
        if (!confirm(`임시저장된 ${items.length}건을 모두 승인하시겠습니까?\n실제 데이터에 즉시 반영됩니다.`)) return;
        const r = await approveAllPending();
        let msg = `승인 ${r.success}건 완료`;
        if (r.failed) msg += `, ${r.failed}건 실패\n${r.errors.join('\n')}`;
        alert(msg);
        await window.loadAndRenderManagement?.();
        await renderApprovalBanner();
    };

    _('#reject-all-pending-btn').onclick = async () => {
        const reason = prompt(`임시저장된 ${items.length}건을 모두 반려합니다.\n반려 사유를 입력하세요:`);
        if (!reason) return;
        const r = await rejectAllPending(reason);
        alert(`반려 ${r.success}건 완료${r.failed ? `, ${r.failed}건 실패` : ''}`);
        await renderApprovalBanner();
    };

    _('#review-pending-btn').onclick = () => openReviewModal(items);
}

function openReviewModal(items) {
    let modal = document.getElementById('review-pending-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'review-pending-modal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4';

    const empMap = {};
    state.management.employees.forEach(e => { empMap[e.id] = e.name; });

    const labelMap = {
        employee: '직원', department: '부서', leave_management: '연차관리',
        document: '서류', document_request: '서류요청', form_template: '서식'
    };
    const actionMap = { create: '생성', update: '수정', delete: '삭제' };

    const rows = items.map(it => {
        const creator = empMap[it.created_by] || `매니저 #${it.created_by}`;
        const time = dayjs(it.created_at).format('MM-DD HH:mm');
        const summary = summarizeChange(it);
        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-2 text-xs">${time}</td>
                <td class="p-2 text-xs font-semibold">${creator}</td>
                <td class="p-2 text-xs">${labelMap[it.entity_type] || it.entity_type}</td>
                <td class="p-2 text-xs"><span class="px-2 py-0.5 rounded ${it.action === 'delete' ? 'bg-red-100 text-red-700' : it.action === 'create' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">${actionMap[it.action] || it.action}</span></td>
                <td class="p-2 text-xs">${it.entity_id ?? '신규'}</td>
                <td class="p-2 text-xs max-w-md whitespace-pre-wrap break-all">${summary}</td>
                <td class="p-2 text-center whitespace-nowrap">
                    <button data-action="approve" data-id="${it.id}" class="px-2 py-1 bg-green-500 text-white text-xs rounded">✅ 승인</button>
                    <button data-action="reject" data-id="${it.id}" class="px-2 py-1 bg-red-500 text-white text-xs rounded ml-1">❌ 반려</button>
                </td>
            </tr>
        `;
    }).join('');

    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl p-6 w-[1100px] max-w-full max-h-[85vh] overflow-y-auto">
            <div class="flex justify-between items-center mb-4 border-b pb-3">
                <h2 class="text-xl font-bold">매니저 임시저장 검토 (${items.length}건)</h2>
                <button id="close-review-modal" class="text-2xl">&times;</button>
            </div>
            <table class="w-full text-sm">
                <thead>
                    <tr class="border-b bg-gray-50">
                        <th class="p-2 text-left">시각</th>
                        <th class="p-2 text-left">제출자</th>
                        <th class="p-2 text-left">메뉴</th>
                        <th class="p-2 text-left">작업</th>
                        <th class="p-2 text-left">대상</th>
                        <th class="p-2 text-left">변경 요약</th>
                        <th class="p-2 text-center">처리</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('close-review-modal').onclick = () => modal.remove();

    modal.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id, 10);
        const action = btn.dataset.action;

        if (action === 'approve') {
            if (!confirm('이 변경을 승인하여 실제 데이터에 반영하시겠습니까?')) return;
            const r = await approvePendingChange(id);
            if (!r.ok) return alert('승인 실패: ' + r.error);
        } else if (action === 'reject') {
            const reason = prompt('반려 사유를 입력하세요:');
            if (!reason) return;
            const r = await rejectPendingChange(id, reason);
            if (!r.ok) return alert('반려 실패: ' + r.error);
        }
        modal.remove();
        await window.loadAndRenderManagement?.();
        await renderApprovalBanner();
    });
}

function summarizeChange(item) {
    if (!item.payload) return '-';
    const keys = Object.keys(item.payload).slice(0, 6);
    return keys.map(k => {
        const v = item.payload[k];
        const s = (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
        return `${k}: ${s.length > 40 ? s.slice(0, 40) + '…' : s}`;
    }).join(' / ');
}

// 다른 모듈(staging 승인 후, 매니저 페이지 등)에서 호출 가능
window.refreshApprovalBanner = renderApprovalBanner;

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
    state.viewAs = 'employee';
    sessionStorage.removeItem('viewAs');
    await checkAuth();
}

function render() {
    _all('.page-section').forEach(el => el.classList.add('hidden'));

    // body 배경 클래스 — 페르소나 인지용
    document.body.classList.remove('mode-employee', 'mode-admin');

    const user = state.currentUser;
    const isManager = !!(user && user.isManager);
    const viewAs = state.viewAs || 'employee';

    if (state.userRole === 'admin') {
        document.body.classList.add('mode-admin');
        show('#admin-portal');
        renderAdminPortal();
    } else if (state.userRole === 'employee' && isManager && viewAs === 'admin') {
        // 매니저가 매니저 화면 진입 → admin-portal 재사용 + perm 필터
        document.body.classList.add('mode-admin');
        show('#admin-portal');
        renderAdminPortal();
    } else if (state.userRole === 'employee') {
        document.body.classList.add('mode-employee');
        show('#employee-portal');
        renderEmployeePortal();
    } else {
        show('#login-screen');
    }
}

// 매니저가 진입/복귀 버튼 클릭 시 발화 — render() 만 다시 돌리면 됨
window.addEventListener('viewAs:change', () => render());

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
            employee.entryDate = employee.entryDate || employee.entry_date;
            // role 필드와 isManager 동기화
            if (employee.role === 'manager' || employee.isManager) {
                employee.isManager = true;
            }
            state.currentUser = employee;
            state.currentUser.auth_uuid = session.user.id;

            // role에 따라 포털 분기
            if (employee.role === 'admin') {
                state.userRole = 'admin';
                state.viewAs = 'admin';
                state.management.activeTab = 'leaveList';
                assignManagementEventHandlers();
            } else if (employee.role === 'manager' || employee.isManager) {
                // 매니저는 직원 포털 디폴트, "매니저 화면 보기" 버튼으로 admin-portal 진입
                state.userRole = 'employee';
                state.viewAs = sessionStorage.getItem('viewAs') === 'admin' ? 'admin' : 'employee';
                assignManagementEventHandlers();
            } else {
                // 일반 직원은 Supabase Auth 로그인 허용하지만 직원 포털
                state.userRole = 'employee';
                state.viewAs = 'employee';
            }
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

        employee.entryDate = employee.entryDate || employee.entry_date;
        // role 필드와 isManager 동기화
        if (employee.role === 'manager' || employee.isManager) {
            employee.isManager = true;
        }
        state.currentUser = employee;
        state.userRole = 'employee';
        // 매니저는 5개 메뉴 inline onclick 핸들러를 위해 글로벌 등록 필요
        if (employee.isManager) {
            assignManagementEventHandlers();
        }
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
