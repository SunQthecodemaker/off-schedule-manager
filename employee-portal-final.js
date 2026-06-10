import { state, db } from './state.js?v=20260610b';
import { _, show, hide, resizeGivenCanvas } from './utils.js';
import { getLeaveDetails, isLeaveInPeriod } from './leave-utils.js';
import { renderScheduleManagement, computeDayGridSlots, hydrateScheduleRow } from './schedule.js?v=20260610b';
import { getLeaveListHTML, getLeaveStatusHTML, getManagementHTML, getDepartmentManagementHTML, getLeaveManagementHTML, addLeaveStatusEventListeners } from './management.js?v=20260610b';
import { renderDocumentReviewTab, renderTemplatesManagement } from './documents.js?v=20260610b';
import { renderMyWelfareSection } from './employee-welfare.js?v=20260610b';

// =========================================================================================
// 매니저 권한 시스템 (employees.manager_permissions jsonb)
// 8개 메뉴: schedule, leave_request_list, leave_status, document_review,
//           leave_management, employee_management, department, form
// 각 메뉴: { view: bool, edit: bool, commit: bool }
//   view   = 메뉴 노출
//   edit   = 입력·버튼 활성 (수정 가능)
//   commit = 매니저가 직접 최종 반영 (off 면 매니저 [저장] = 임시저장 → 관리자 결재)
// 관리자가 직원 관리 모달에서 토글 가능. default 는 사용자 정책:
//   평소 끔(view=false): 연차관리·직원관리·부서관리 (초기 세팅 시만 켬)
//   조회만(edit=false):  연차 현황
//   매니저 즉시 확정(commit=true): 서식 관리 (그 외엔 결재 필요)
// =========================================================================================
const DEFAULT_MANAGER_PERMS = {
    schedule:            { view: true,  edit: true,  commit: false },
    leave_request_list:  { view: true,  edit: true,  commit: false },
    leave_status:        { view: true,  edit: false, commit: false },
    document_review:     { view: true,  edit: true,  commit: false },
    leave_management:    { view: false, edit: false, commit: false },
    employee_management: { view: false, edit: false, commit: false },
    department:          { view: false, edit: false, commit: false },
    form:                { view: true,  edit: true,  commit: true  }
};

/** 현재 로그인 직원의 메뉴 권한 (관리자는 모두 true, 매니저는 DB 값, 일반 직원은 모두 false) */
export function getManagerPerm(menuKey) {
    if (state.userRole === 'admin') return { view: true, edit: true, commit: true };
    const u = state.currentUser;
    if (!u || !u.isManager) return { view: false, edit: false, commit: false };
    const stored = u.manager_permissions && u.manager_permissions[menuKey];
    const dflt = DEFAULT_MANAGER_PERMS[menuKey];
    if (!stored) return dflt || { view: false, edit: false, commit: false };
    // 저장값이 옛 schema (commit 키 없음) 인 경우 default 의 commit 으로 보강
    return {
        view: !!stored.view,
        edit: !!stored.edit,
        commit: stored.commit !== undefined ? !!stored.commit : !!(dflt && dflt.commit)
    };
}

// =========================================================================================
// 직원 포털 렌더링
// =========================================================================================

export async function renderEmployeePortal() {
    const portal = _('#employee-portal');
    const user = state.currentUser;

    if (!user) {
        portal.innerHTML = '<p class="text-red-600">사용자 정보를 불러올 수 없습니다.</p>';
        return;
    }

    let departmentName = '부서 미지정';

    if (user.department_id) {
        try {
            const { data: dept, error } = await db.from('departments')
                .select('*')
                .eq('id', user.department_id)
                .single();

            if (!error && dept) {
                departmentName = dept.name;
                user.departments = dept;
            }
        } catch (err) {
            console.error('부서 정보 로드 오류:', err);
        }
    } else if (user.dept) {
        departmentName = user.dept;
    } else if (user.departments?.name) {
        departmentName = user.departments.name;
    }

    const leaveDetails = getLeaveDetails(user);

    // 갱신일 계산
    let renewalDateText = '미설정';
    let renewalDateShort = '미설정';
    if (user.leave_renewal_date) {
        const today = dayjs();
        const renewalThisYear = dayjs(user.leave_renewal_date).year(today.year());
        const nextRenewal = today.isAfter(renewalThisYear)
            ? renewalThisYear.add(1, 'year')
            : renewalThisYear;
        renewalDateText = nextRenewal.format('YYYY-MM-DD');
        renewalDateShort = nextRenewal.format('YY-MM-DD');
    } else if (user.entryDate || user.entry_date) {
        const today = dayjs();
        const entryAnniversaryThisYear = dayjs(user.entryDate || user.entry_date).year(today.year());
        const nextAnniversary = today.isAfter(entryAnniversaryThisYear)
            ? entryAnniversaryThisYear.add(1, 'year')
            : entryAnniversaryThisYear;
        renewalDateText = nextAnniversary.format('YYYY-MM-DD');
        renewalDateShort = nextAnniversary.format('YY-MM-DD');
    }

    portal.innerHTML = `
        <div class="max-w-full mx-auto">
            <div class="flex justify-between items-start mb-6">
                <h1 class="text-xl sm:text-3xl font-bold flex-shrink-0">직원 포털</h1>
                <div class="text-right min-w-0">
                    <!-- 이름 줄: 이름 + (매니저만) 매니저 화면 보기 버튼 -->
                    <div class="flex items-center justify-end gap-2">
                        <p class="text-gray-700 text-sm font-semibold whitespace-nowrap">${user.name}님 (${departmentName})</p>
                        ${user.isManager ? `<button id="enterManagerViewBtn" class="emp-manager-btn px-3 py-1 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded transition-colors whitespace-nowrap flex-shrink-0">🛠️ 매니저 화면 보기</button>` : ''}
                    </div>
                    <!-- 공통 버튼 줄: 모든 직원 동일 3개, 한 줄 고정 -->
                    <div class="mt-1 flex gap-2 justify-end emp-header-actions">
                        <button id="changeEmailBtn" class="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded transition-colors">이메일 변경</button>
                        <button id="changePasswordBtn" class="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded transition-colors">비밀번호 변경</button>
                        <button id="employeeLogoutBtn" class="px-3 py-1 text-sm bg-gray-300 hover:bg-gray-400 rounded transition-colors">로그아웃</button>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-4 gap-2 sm:gap-4 mb-6">
                <div class="dash-card p-2 sm:p-4 flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-xs whitespace-nowrap">확정 연차</p>
                    <p class="text-lg sm:text-2xl font-bold whitespace-nowrap" id="final-leaves">${leaveDetails.final}일</p>
                </div>
                <div class="dash-card p-2 sm:p-4 flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-xs whitespace-nowrap">사용 연차</p>
                    <p class="text-lg sm:text-2xl font-bold whitespace-nowrap" id="used-leaves">계산 중...</p>
                </div>
                <div class="dash-card dash-card-accent p-2 sm:p-4 flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-xs whitespace-nowrap">잔여 연차</p>
                    <p class="text-lg sm:text-2xl font-bold whitespace-nowrap" id="remaining-leaves">계산 중...</p>
                </div>
                <div class="dash-card dash-card-dark p-2 sm:p-4 flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-xs font-semibold whitespace-nowrap">갱신일</p>
                    <p class="text-xs sm:text-xl font-medium whitespace-nowrap">${renewalDateShort || renewalDateText}</p>
                </div>
            </div>

            <!-- 서류 제출 요청 알림 배너 -->
            <div id="doc-alert-banner" class="hidden mb-4 bg-red-50 border border-red-300 rounded-lg p-4 flex items-center gap-3 cursor-pointer" onclick="document.getElementById('tab-docs-btn').click()">
                <span class="text-2xl">📋</span>
                <div>
                    <p class="font-bold text-red-700">미제출 서류가 있습니다</p>
                    <p id="doc-alert-detail" class="text-sm text-red-600">서류를 제출하지 않으면 연차 신청이 제한됩니다. 클릭하여 확인하세요.</p>
                </div>
            </div>

            <!-- 직원 본인 인라인 연차 박스 그리드 -->
            <div id="employee-leave-grid-container" class="mb-6 bg-white shadow rounded p-4 overflow-x-auto">
                <div class="text-center text-gray-500 text-sm">연차 정보를 불러오는 중입니다...</div>
            </div>

            <!-- 탭 버튼 -->
            <div class="flex border-b mb-4 overflow-x-auto" style="white-space:nowrap;">
                <button id="tab-leave-btn" class="employee-tab-btn px-3 sm:px-6 py-2 sm:py-3 text-sm sm:text-base font-semibold border-b-2 border-blue-600 text-blue-600 flex-shrink-0">연차 신청</button>
                <button id="tab-docs-btn" class="employee-tab-btn px-3 sm:px-6 py-2 sm:py-3 text-sm sm:text-base font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700 relative flex-shrink-0">
                    서류 제출
                    <span id="doc-tab-badge" class="hidden absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">0</span>
                </button>
                <button id="tab-work-schedule-btn" class="employee-tab-btn px-3 sm:px-6 py-2 sm:py-3 text-sm sm:text-base font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700 flex-shrink-0">
                    📅 근무 스케줄
                </button>
                <button id="tab-welfare-btn" class="employee-tab-btn px-3 sm:px-6 py-2 sm:py-3 text-sm sm:text-base font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700 flex-shrink-0">
                    💊 진료비 복지
                </button>
            </div>

            <!-- 매니저 전용: 스케줄 승인 요청 반려 알림 배너 -->
            ${user.isManager ? `
                <div id="manager-rejection-banner" class="hidden mb-4 bg-red-50 border border-red-300 rounded-lg p-4 flex items-start justify-between gap-3">
                    <div class="flex items-start gap-3">
                        <span class="text-2xl">⚠️</span>
                        <div>
                            <p class="font-bold text-red-700">스케줄 승인 요청이 반려되었습니다</p>
                            <p id="manager-rejection-detail" class="text-sm text-red-600 mt-1"></p>
                        </div>
                    </div>
                    <button id="manager-rejection-dismiss" class="text-red-700 hover:bg-red-100 px-3 py-1 rounded">확인</button>
                </div>
            ` : ''}

            <!-- 연차 신청 탭 -->
            <div id="employee-leave-tab" class="tab-content">
                <div id="employee-calendar-container" class="bg-white shadow rounded p-4 mb-6"></div>
                
                <div class="bg-white shadow rounded p-4">
                    <h2 class="text-xl font-bold mb-4">내 연차 신청 내역</h2>
                    <div id="my-leave-requests"></div>
                </div>
            </div>

            <!-- 서류 제출 탭 -->
            <div id="employee-docs-tab" class="tab-content hidden">
                <div class="bg-white shadow rounded p-4 mb-4">
                    <h2 class="text-xl font-bold mb-4">서류 제출 요청 <span class="text-sm text-gray-500">(관리자가 요청한 서류)</span></h2>
                    <div id="document-requests-list"></div>
                </div>
                
                <div class="bg-white shadow rounded p-4">
                    <h2 class="text-xl font-bold mb-4">제출한 서류 <span class="text-sm text-gray-500">(내가 제출한 서류 현황)</span></h2>
                    <div id="submitted-docs-list"></div>
                </div>
            </div>

            <!-- 근무 스케줄 탭 (신규) -->
            <div id="employee-work-schedule-tab" class="tab-content hidden bg-white shadow rounded p-4">
                <!-- 모바일 친화적 주간 스케줄 -->
            </div>

            <!-- 진료비 복지 탭 (직원 본인 진료기록·잔액·이행 현황) -->
            <div id="employee-welfare-tab" class="tab-content hidden">
                <h2 class="text-xl font-bold mb-3">💊 내 진료비 복지 현황</h2>
                <div id="my-welfare-content"></div>
            </div>

        </div>
    `;

    _('#employeeLogoutBtn').addEventListener('click', async () => {
        sessionStorage.clear();
        window.location.reload();
    });

    _('#changePasswordBtn')?.addEventListener('click', handleChangePassword);
    _('#changeEmailBtn')?.addEventListener('click', handleChangeEmail);

    _('#tab-leave-btn').addEventListener('click', () => switchEmployeeTab('leave'));
    _('#tab-docs-btn').addEventListener('click', () => switchEmployeeTab('docs'));
    _('#tab-work-schedule-btn').addEventListener('click', () => switchEmployeeTab('workSchedule'));
    _('#tab-welfare-btn')?.addEventListener('click', () => switchEmployeeTab('welfare'));

    if (user.isManager) {
        _('#enterManagerViewBtn')?.addEventListener('click', () => {
            state.viewAs = 'admin';
            sessionStorage.setItem('viewAs', 'admin');
            window.dispatchEvent(new CustomEvent('viewAs:change'));
        });

        await loadManagerRejectionBanner();
        _('#manager-rejection-dismiss')?.addEventListener('click', () => {
            const banner = document.getElementById('manager-rejection-banner');
            if (banner) banner.classList.add('hidden');
            sessionStorage.setItem('mgr_rejection_dismissed_at', Date.now().toString());
        });
    }

    await loadEmployeeData();

    // 미제출 서류 알림은 loadEmployeeData() 내에서 한 번만 표시
    // (내 진료비 복지 현황은 별도 탭 — switchEmployeeTab('welfare') 시 렌더)
}

// 매니저 포털: 가장 최근 반려된 스케줄 승인 요청 표시 (sessionStorage dismiss)
async function loadManagerRejectionBanner() {
    try {
        const dismissedAt = parseInt(sessionStorage.getItem('mgr_rejection_dismissed_at') || '0', 10);
        const { data, error } = await db.from('schedule_confirmations')
            .select('month, rejected_at, rejection_reason, rejected_by')
            .not('rejected_at', 'is', null)
            .order('rejected_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error || !data) return;
        const rejectedTs = new Date(data.rejected_at).getTime();
        if (rejectedTs <= dismissedAt) return;
        const banner = document.getElementById('manager-rejection-banner');
        const detail = document.getElementById('manager-rejection-detail');
        if (banner && detail) {
            const reasonTxt = data.rejection_reason ? ` 사유: "${data.rejection_reason}"` : '';
            detail.textContent = `${data.month} 스케줄 — 반려자: ${data.rejected_by || '관리자'}.${reasonTxt} 수정 후 다시 승인 요청해주세요.`;
            banner.classList.remove('hidden');
        }
    } catch (e) {
        console.error('반려 배너 로드 실패:', e);
    }
}

async function verifyCurrentPassword(inputPass) {
    // 평문 비교 폐기 → 서버 RPC 해시 검증 (캐시 비교 X, admin 강제 초기화 즉시 반영). 2026-06-05
    const { data, error } = await db.rpc('employee_verify_password', {
        p_id: state.currentUser.id,
        p_password: inputPass
    });
    if (error) { console.error('비번 검증 RPC 오류:', error); return false; }
    return data === true;
}

async function handleChangePassword() {
    const currentPass = prompt("현재 비밀번호를 입력해주세요:");
    if (currentPass === null) return;

    const ok = await verifyCurrentPassword(currentPass);
    if (!ok) {
        alert("현재 비밀번호가 일치하지 않습니다.");
        return;
    }

    const rawPass = prompt("새로운 비밀번호를 입력해주세요:");
    if (rawPass === null) return;
    const newPass = rawPass.trim();

    if (!newPass) {
        alert("비밀번호는 공백일 수 없습니다.");
        return;
    }
    if (newPass.length < 4) {
        alert("비밀번호는 4자 이상이어야 합니다.");
        return;
    }

    const { error } = await db.from('employees').update({ password: newPass }).eq('id', state.currentUser.id);

    if (error) {
        alert("비밀번호 변경 실패: " + error.message);
    } else {
        alert("비밀번호가 변경되었습니다. 다시 로그인해주세요.");
        sessionStorage.clear();
        window.location.reload();
    }
}

async function handleChangeEmail() {
    const currentPass = prompt("본인 확인을 위해 현재 비밀번호를 입력해주세요:");
    if (currentPass === null) return;

    const ok = await verifyCurrentPassword(currentPass);
    if (!ok) {
        alert("현재 비밀번호가 일치하지 않습니다.");
        return;
    }

    const rawEmail = prompt(`새 이메일을 입력해주세요${state.currentUser.email ? `\n(현재: ${state.currentUser.email})` : ''}:`);
    if (rawEmail === null) return;
    const newEmail = rawEmail.trim().toLowerCase();

    if (!newEmail) {
        alert("이메일은 공백일 수 없습니다.");
        return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
        alert("올바른 이메일 형식이 아닙니다. (예: name@example.com)");
        return;
    }

    const { error } = await db.from('employees').update({ email: newEmail }).eq('id', state.currentUser.id);

    if (error) {
        alert("이메일 변경 실패: " + error.message);
    } else {
        state.currentUser.email = newEmail;
        alert(`이메일이 변경되었습니다.\n새 이메일: ${newEmail}`);
    }
}

function switchEmployeeTab(tab) {
    state.employee.activeTab = tab;

    // 모든 탭 버튼과 컨텐츠 숨기기/비활성화 처리
    const tabs = {
        'leave': { btn: '#tab-leave-btn', content: '#employee-leave-tab' },
        'docs': { btn: '#tab-docs-btn', content: '#employee-docs-tab' },
        'workSchedule': { btn: '#tab-work-schedule-btn', content: '#employee-work-schedule-tab' },
        'welfare': { btn: '#tab-welfare-btn', content: '#employee-welfare-tab' },
        'leaveList': { btn: '#tab-leave-list-btn', content: '#employee-leave-list-tab' },
        'leaveStatus': { btn: '#tab-leave-status-btn', content: '#employee-leave-status-tab' },
        'schedule': { btn: '#tab-schedule-btn', content: '#employee-schedule-tab' },
        'documentReview': { btn: '#tab-document-review-btn', content: '#employee-document-review-tab' },
        'leaveManagement': { btn: '#tab-leave-management-btn', content: '#employee-leave-management-tab' },
        'employeeManagement': { btn: '#tab-employee-management-btn', content: '#employee-management-tab' },
        'department': { btn: '#tab-department-btn', content: '#employee-department-tab' },
        'form': { btn: '#tab-form-btn', content: '#employee-form-tab' }
    };

    Object.keys(tabs).forEach(key => {
        const t = tabs[key];
        const btnFn = _(t.btn);
        const contentFn = _(t.content);

        if (btnFn && contentFn) {
            if (key === tab) {
                // 활성화
                btnFn.classList.add('border-blue-600', 'text-blue-600');
                btnFn.classList.remove('border-transparent', 'text-gray-500');
                contentFn.classList.remove('hidden');
            } else {
                // 비활성화
                btnFn.classList.remove('border-blue-600', 'text-blue-600');
                btnFn.classList.add('border-transparent', 'text-gray-500');
                contentFn.classList.add('hidden');
            }
        }
    });

    if (tab === 'leaveList') {
        renderManagerLeaveList();
    } else if (tab === 'leaveStatus') {
        renderManagerLeaveStatus();
    } else if (tab === 'schedule') {
        renderManagerScheduleTab();
    } else if (tab === 'workSchedule') {
        renderEmployeeScheduleView();
    } else if (tab === 'welfare') {
        const c = document.getElementById('my-welfare-content');
        if (c) renderMyWelfareSection(c);
    } else if (tab === 'documentReview') {
        renderManagerDocumentReview();
    } else if (tab === 'leaveManagement') {
        renderManagerLeaveManagement();
    } else if (tab === 'employeeManagement') {
        renderManagerEmployeeManagement();
    } else if (tab === 'department') {
        renderManagerDepartment();
    } else if (tab === 'form') {
        renderManagerFormManagement();
    }
}

// =========================================================================================
// 매니저 5개 추가 탭 렌더 함수 (관리자 함수 재사용 + perm.edit 분기)
// =========================================================================================

async function ensureManagementData() {
    if (typeof window.loadAndRenderManagement !== 'function') return;
    const m = state.management;
    const empty = !m || !m.employees?.length || !m.departments?.length;
    if (empty) {
        await window.loadAndRenderManagement().catch(() => {});
    }
}

function applyEditPermission(container, edit) {
    if (!container || edit) return;
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

async function renderManagerDocumentReview() {
    const container = _('#employee-document-review-tab');
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 text-sm">불러오는 중...</p>';
    await ensureManagementData();
    renderDocumentReviewTab(container);
    const perm = getManagerPerm('document_review');
    setTimeout(() => applyEditPermission(container, perm.edit), 50);
}

async function renderManagerLeaveManagement() {
    const container = _('#employee-leave-management-tab');
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 text-sm">불러오는 중...</p>';
    await ensureManagementData();
    container.innerHTML = getLeaveManagementHTML();
    const perm = getManagerPerm('leave_management');
    setTimeout(() => applyEditPermission(container, perm.edit), 50);
}

async function renderManagerEmployeeManagement() {
    const container = _('#employee-management-tab');
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 text-sm">불러오는 중...</p>';
    await ensureManagementData();
    container.innerHTML = getManagementHTML();
    // 매니저 직원 관리: ⚙️ 매니저 권한 토글 버튼은 admin 전용 → 숨김
    container.querySelectorAll('button[onclick^="window.openManagerPermissionModal"]').forEach(b => b.style.display = 'none');
    // 매니저 체크박스도 admin만 변경 가능 → disabled
    container.querySelectorAll('input[id^="manager-"]').forEach(c => c.disabled = true);
    const perm = getManagerPerm('employee_management');
    setTimeout(() => applyEditPermission(container, perm.edit), 50);
}

async function renderManagerDepartment() {
    const container = _('#employee-department-tab');
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 text-sm">불러오는 중...</p>';
    await ensureManagementData();
    container.innerHTML = getDepartmentManagementHTML();
    const perm = getManagerPerm('department');
    setTimeout(() => applyEditPermission(container, perm.edit), 50);
}

async function renderManagerFormManagement() {
    const container = _('#employee-form-tab');
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 text-sm">불러오는 중...</p>';
    await ensureManagementData();
    await renderTemplatesManagement(container);
    const perm = getManagerPerm('form');
    setTimeout(() => applyEditPermission(container, perm.edit), 50);
}

// =========================================================================================
// PC/모바일 분기 스케줄 뷰
// =========================================================================================
async function renderEmployeeScheduleView() {
    const container = _('#employee-work-schedule-tab');
    if (!container) return;

    const isPC = window.innerWidth >= 1024;


    if (isPC) {
        try {
            // PC: 관리자 달력 그리드 (읽기전용)
            if (!state.management) state.management = {};
            const [deptRes, empRes, leaveRes] = await Promise.all([
                db.from('departments').select('*').order('id'),
                db.from('employees').select('*, departments(*)').order('id'),
                db.from('leave_requests').select('*').in('status', ['approved'])
            ]);
            state.management.departments = deptRes.data || [];
            state.management.employees = (empRes.data || []).map(e => ({ ...e, entryDate: e.entryDate || e.entry_date }));
            state.management.leaveRequests = leaveRes.data || [];
            container.style.height = 'auto';
            await renderScheduleManagement(container, true);
        } catch (err) {
            console.error('❌ PC 달력 렌더링 실패, 주간뷰로 대체:', err);
            container.style.height = 'auto';
            await renderEmployeeMobileScheduleList({ selector: '#employee-work-schedule-tab', bypassConfirm: false });
        }
    } else {
        // 모바일/태블릿: 주간 리스트 뷰
        container.style.height = 'auto';
        await renderEmployeeMobileScheduleList({ selector: '#employee-work-schedule-tab', bypassConfirm: false });
    }
}

// =========================================================================================
// [신규] 모바일 친화적 근무 스케줄 리스트 뷰
//  - 주간 뷰
//  - 근무자/휴무자 보기 토글
//  - 네비게이션 줄바꿈 수정
// =========================================================================================

// 부서 색상 매핑 (Admin과 동일)
function getDepartmentColor(departmentId) {
    if (!departmentId) return '#cccccc';
    const colors = ['#4f46e5', '#db2777', '#16a34a', '#f97316', '#0891b2', '#6d28d9', '#ca8a04'];
    return colors[departmentId % colors.length];
}

// 근무 스케줄 부서 필터 — 개인(유저 id)별 마지막 선택을 localStorage 에 영속화.
// 기본값은 '전 부서 선택' 이지만, 한 번 토글한 뒤로는 그 사람이 설정한 그대로 복원.
function _deptFilterStorageKey() {
    const uid = state.currentUser?.id ?? state.currentUser?.name ?? 'anon';
    return `offapp_schedDeptFilter_${uid}`;
}
// 저장값 로드: 저장된 적 없으면 null(→ 기본 전부 선택), 있으면 현존 부서로 필터한 Set
function loadSavedDeptFilter(realDepartments) {
    try {
        const raw = localStorage.getItem(_deptFilterStorageKey());
        if (raw === null) return null;
        const ids = JSON.parse(raw);
        if (!Array.isArray(ids)) return null;
        const valid = new Set(realDepartments.map(d => d.id));
        return new Set(ids.filter(id => valid.has(id)));
    } catch (e) {
        return null;
    }
}
function saveDeptFilter() {
    try {
        localStorage.setItem(_deptFilterStorageKey(), JSON.stringify([...state.employee.scheduleDeptFilter]));
    } catch (e) { /* localStorage 불가 환경(프라이빗 등) 무시 */ }
}

// 렌더 타깃 영속화 — 직원 포털(#employee-work-schedule-tab)과 원장 모바일 조회 페이지가
// 같은 함수를 재사용하되, 주차 이동/필터 토글의 재렌더가 같은 컨테이너로 돌아가도록 모듈 변수에 보존.
let _mobileScheduleTarget = { selector: '#employee-work-schedule-tab', bypassConfirm: false };

export async function renderEmployeeMobileScheduleList(opts) {
    if (opts && opts.selector) {
        _mobileScheduleTarget = { selector: opts.selector, bypassConfirm: !!opts.bypassConfirm };
    }
    const { selector: _msSelector, bypassConfirm: _msBypassConfirm } = _mobileScheduleTarget;
    const container = _(_msSelector);
    if (!container) return;
    // state.employee 미초기화(원장 진입 등) 방어
    state.employee = state.employee || {};
    window._retryScheduleList = renderEmployeeMobileScheduleList;

    // 로딩 인디케이터
    if (!container.innerHTML.includes('animate-spin')) {
        container.innerHTML = '<div class="flex justify-center items-center h-48"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>';
    }

    try {
        // 초기화
        if (!state.employee.scheduleViewDate) state.employee.scheduleViewDate = dayjs().format('YYYY-MM-DD');
        if (!state.employee.scheduleViewMode) state.employee.scheduleViewMode = 'working'; // working | off
        // scheduleDeptFilter 는 부서 목록 fetch 후 "전 부서 선택" 으로 기본 초기화 (전체 버튼 폐지, 선택=표시)

        const currentDate = dayjs(state.employee.scheduleViewDate);

        // 주 시작일 계산 (월요일 기준)
        const dayNum = currentDate.day(); // 0(일) ~ 6(토)
        const diffToMon = dayNum === 0 ? -6 : 1 - dayNum;
        const startOfWeek = currentDate.add(diffToMon, 'day');
        const endOfWeek = startOfWeek.add(6, 'day');

        const startStr = startOfWeek.format('YYYY-MM-DD');
        const endStr = endOfWeek.format('YYYY-MM-DD');
        const monthStr = startOfWeek.format('YYYY-MM');

        // 1. 스케줄 확정 여부 확인
        const { data: confirmData, error: confirmError } = await db.from('schedule_confirmations')
            .select('*')
            .eq('month', monthStr)
            .single();

        if (confirmError && confirmError.code !== 'PGRST116') throw confirmError;

        const isConfirmed = confirmData && confirmData.is_confirmed;

        if (!isConfirmed && !_msBypassConfirm) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full p-6 text-center">
                    <div class="text-4xl mb-4">⏳</div>
                    <h3 class="text-xl font-bold text-gray-700 mb-2">${startOfWeek.format('YYYY년 M월')} 근무 스케줄</h3>
                    <p class="text-gray-500 mb-6">아직 스케줄이 확정되지 않았습니다.<br>관리자가 스케줄을 조정 중입니다.</p>
                    <div class="flex gap-4">
                        <button id="prev-week-btn" class="px-4 py-2 bg-gray-100 rounded hover:bg-gray-200">◀ 지난주</button>
                         <button id="next-week-btn" class="px-4 py-2 bg-gray-100 rounded hover:bg-gray-200">다음주 ▶</button>
                    </div>
                </div>
            `;
            attachNavListeners(container);
            return;
        }

        // 2. 데이터 병렬 로딩 — PC 그리드와 100% 동일하게 보이도록 PC 와 같은 전역 state 를 구성한 뒤
        //    공용 정본 함수 computeDayGridSlots 로 날짜별 배치를 산출한다 (모바일 자체 위치계산 폐기).
        const GRID_SIZE = 32;
        const layoutMonth = startOfWeek.format('YYYY-MM-01'); // PC loadAndRenderScheduleData 와 동일 형식(YYYY-MM-01)
        const [schedulesRes, employeesRes, departmentsRes, holidaysRes, layoutRes, leavesRes] = await Promise.all([
            db.from('schedules').select('*').gte('date', startStr).lte('date', endStr),
            db.from('employees').select('*'),
            db.from('departments').select('id, name').order('id'),
            db.from('company_holidays').select('*').gte('date', startStr).lte('date', endStr),
            db.from('monthly_layouts').select('layout_data').lte('month', layoutMonth).order('month', { ascending: false }).limit(1),
            db.from('leave_requests').select('*').in('status', ['approved'])
        ]);

        if (schedulesRes.error) throw schedulesRes.error;
        if (employeesRes.error) throw employeesRes.error;
        if (departmentsRes.error) throw departmentsRes.error;
        if (holidaysRes.error) throw holidaysRes.error;
        if (layoutRes.error) throw layoutRes.error;
        if (leavesRes.error) throw leavesRes.error;

        const allEmployees = employeesRes.data || [];
        const allDepartments = departmentsRes.data || [];
        // 모바일 부서 필터 버튼 = 테스트 부서 제외한 실제 부서만 (전체 버튼 폐지)
        const realDepartments = allDepartments.filter(d => !(d.name || '').includes('테스트'));
        // 부서 필터 초기화 (미초기화일 때만 → 세션 중 토글 보존).
        // 개인이 저장한 마지막 선택이 있으면 그대로 복원, 없으면 기본 = 전 부서 선택.
        if (!state.employee.scheduleDeptFilter) {
            const saved = loadSavedDeptFilter(realDepartments);
            state.employee.scheduleDeptFilter = (saved !== null)
                ? saved
                : new Set(realDepartments.map(d => d.id));
        }
        const holidays = holidaysRes.data || [];

        const empMap = new Map(allEmployees.map(e => [e.id, e]));
        const deptMap = new Map(allDepartments.map(d => [d.id, d.name]));
        const holidaySet = new Set(holidays.map(h => h.date));

        // ── PC teamLayout 구성 (loadAndRenderScheduleData 와 동일): layout_data[0].members(positional 32칸, 0=빈자리) ──
        let employeeOrder = [];
        const latestLayout = layoutRes.data?.[0];
        if (latestLayout?.layout_data?.length > 0) {
            employeeOrder = [...(latestLayout.layout_data[0].members || [])];
        }
        if (employeeOrder.length === GRID_SIZE) {
            employeeOrder = employeeOrder.map(id => (typeof id === 'number' && id > 0) ? id : 0);
        } else if (employeeOrder.length > 0) {
            employeeOrder = employeeOrder.filter(id => id > 0);
        }

        // ── PC 와 동일한 전역 state 주입 → computeDayGridSlots 가 위치·status·활성직원 전원을 PC와 똑같이 산출 ──
        state.schedule = state.schedule || {};
        state.management = state.management || {};
        state.management.employees = allEmployees;
        state.management.leaveRequests = leavesRes.data || [];
        state.schedule.schedules = (schedulesRes.data || []).map(hydrateScheduleRow);
        state.schedule.companyHolidays = new Set(holidays.map(h => h.date));
        state.schedule.teamLayout = {
            month: layoutMonth,
            data: employeeOrder.length > 0 ? [{ id: 'main', name: '직원 목록', members: employeeOrder }] : []
        };
        if (!state.schedule.activeDepartmentFilters) state.schedule.activeDepartmentFilters = new Set();

        // 3. UI 렌더링
        // 상단 네비게이션 (한 줄로 변경)
        // 3. UI 렌더링
        // 상단 네비게이션 (한 줄로 변경)
        let html = `
            <div class="flex flex-col gap-4 mb-4">
                <!-- 날짜 및 이동 버튼 (Flex Row) -->
                <!-- 날짜 및 이동 버튼 (Grid Layout for Robustness) -->
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:nowrap;" class="bg-white p-2 rounded-lg shadow-sm border">
                    <button id="prev-week-btn" style="flex-shrink:0;" class="p-2 hover:bg-gray-100 rounded-full text-gray-600">‹</button>
                    <span style="display:flex;flex-direction:column;align-items:center;line-height:1.15;">
                        <span style="font-size:11px;color:#9ca3af;font-weight:400;">${startOfWeek.format('YYYY년')}</span>
                        <span style="white-space:nowrap;font-size:14px;font-weight:700;">${startOfWeek.format('MM.DD')} ~ ${endOfWeek.format('MM.DD')}</span>
                    </span>
                    <button id="next-week-btn" style="flex-shrink:0;" class="p-2 hover:bg-gray-100 rounded-full text-gray-600">›</button>
                </div>

                <!-- 보기 모드 & 부서 필터 -->
                <div class="bg-white p-3 rounded-lg shadow-sm border space-y-3">
                    <!-- 근무자/휴무자 탭 -->
                    <div class="flex bg-gray-100 p-1 rounded-lg">
                        <button class="flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${state.employee.scheduleViewMode === 'working' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}" id="view-mode-working">
                            근무자
                        </button>
                        <button class="flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${state.employee.scheduleViewMode === 'off' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500'}" id="view-mode-off">
                            휴무자
                        </button>
                    </div>

                    <!-- 부서 필터 (전체 버튼 폐지, 실제 부서만 · 한 줄 균등 · 기본 전 부서 선택) -->
                    <div class="flex flex-wrap gap-1.5 pb-1">
                        ${realDepartments.map(dept => `
                            <button data-dept="${dept.id}" class="dept-filter-btn flex-1 min-w-[60px] px-2 py-1 text-xs rounded-full border whitespace-nowrap ${state.employee.scheduleDeptFilter.has(dept.id) ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-500 border-gray-300'}">
                                ${dept.name}
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>

            <!-- 스케줄 리스트 -->
            <div class="space-y-3">
        `;

        // 요일별 카드 생성 (일요일 제외 — PC 달력과 동일하게 월~토만 표시)
        for (let i = 0; i < 7; i++) {
            const date = startOfWeek.add(i, 'day');
            if (date.day() === 0) continue; // 일요일 스킵
            const dateStr = date.format('YYYY-MM-DD');
            const isToday = dateStr === dayjs().format('YYYY-MM-DD');
            const isSaturday = date.day() === 6;

            const weekLabel = date.format('ddd'); // 월, 화, 수...
            const dayLabel = date.format('D'); // 1, 2, 3...

            // 날짜 색상
            let dayColorClass = 'text-gray-800';
            if (isSaturday) dayColorClass = 'text-blue-500';

            // 휴일 확인
            const isHoliday = holidaySet.has(dateStr);

            // ── PC 정본 함수로 32칸 배치 산출 (활성직원 전원·위치·status 가 PC와 100% 동일) ──
            //    부서필터는 applyDeptFilter:false 로 끄고(전원 배치 받기), 모바일 자체 필터를 표시 단계에서 적용.
            const gridSlots = computeDayGridSlots(dateStr, { applyDeptFilter: false });

            // ── 콤팩트 렌더 (2026-06-07) ──
            //  - 열(4열=팀 배치) 위치는 그대로 보존 (행 내부 빈칸 = spacer)
            //  - 한 명도 없는 행은 통째로 접음 → 진료실/경영지원실 사이 빈 행(공백) 제거
            //  - 그날 보여줄 카드가 하나도 없으면(전원 휴무 등) "휴무" 한 칸만
            const viewMode = state.employee.scheduleViewMode;
            const deptFilter = state.employee.scheduleDeptFilter;

            // 32칸 가시성 선계산 (부서/뷰모드 필터 반영). 위치(p)는 그대로 유지.
            const cells = [];
            for (let p = 0; p < GRID_SIZE; p++) {
                const slot = gridSlots[p];
                const emp = slot ? empMap.get(slot.employee_id) : null;
                let hide = !slot || !emp;
                if (!hide) {
                    // 부서 필터 (선택된 부서만 표시; 기본=전 부서 선택). 미선택 부서(테스트 포함)는 숨김.
                    if (!deptFilter.has(emp.department_id)) hide = true;
                    // 뷰모드: 근무자 탭 = 근무만 / 휴무자 탭 = 휴무+연차
                    if (!hide) {
                        const isWorking = slot.status === '근무';
                        if (viewMode === 'working' && !isWorking) hide = true;
                        if (viewMode === 'off' && isWorking) hide = true;
                    }
                }
                cells[p] = hide ? null : { emp, slot };
            }

            // 행(4칸) 단위로 렌더하되, 전부 빈 행은 건너뛴다(공백 접기). 행 내부 빈칸은 열 위치 보존용 spacer.
            let rowsHtml = '';
            let anyVisible = false;
            for (let r = 0; r < GRID_SIZE / 4; r++) {
                const rowCells = cells.slice(r * 4, r * 4 + 4);
                if (rowCells.every(c => !c)) continue; // 빈 행 접기
                anyVisible = true;
                rowsHtml += `<div class="grid grid-cols-4 gap-1">`;
                for (const c of rowCells) {
                    if (!c) { rowsHtml += `<div></div>`; continue; } // 빈칸 spacer (열 위치 보존)
                    const deptColor = getDepartmentColor(c.emp.department_id);
                    const isLeave = c.slot.status === '연차';
                    // 연차 = PC(.event-leave)와 동일하게 골드크림 배경 + 골드 점선 + 골드 글자 (배지 없이 색으로만 구분)
                    const cardStyle = isLeave ? ' style="background-color:var(--color-primary-light);border-color:var(--color-gold-dark);border-style:dashed;"' : '';
                    rowsHtml += `
                        <div class="emp-sched-card flex items-center bg-gray-50 border rounded px-1 py-0.5 min-w-0"${cardStyle}>
                            <span class="w-1 h-1 rounded-full mr-1 flex-shrink-0" style="background-color: ${deptColor};"></span>
                            <span class="emp-sched-name font-medium ${isLeave ? '' : 'text-gray-700'}"${isLeave ? ' style="color:var(--color-gold-dark);"' : ''}>${c.emp.name}</span>
                        </div>
                    `;
                }
                rowsHtml += `</div>`;
            }

            let content;
            if (!anyVisible) {
                const label = viewMode === 'off' ? '휴무자 없음' : '휴무';
                content = `<div class="inline-flex items-center bg-gray-50 border rounded px-2 py-0.5 text-[10px] text-gray-400">${label}</div>`;
            } else {
                content = `<div class="space-y-1">${rowsHtml}</div>`;
            }

            html += `
                <div class="flex gap-2 rounded-lg ${isToday ? 'today-row' : ''}"${isToday ? ' style="background-color:#f5edd4;"' : ''}>
                    <!-- 날짜 컬럼 (폭 축소 → 네임카드 영역 확대) -->
                    <div class="flex flex-col items-center justify-start pt-1 w-10 flex-shrink-0">
                        <span class="text-[10px] uppercase ${dayColorClass} font-bold">${weekLabel.toUpperCase()}</span>
                        <span class="text-base font-bold ${isToday ? 'bg-blue-600 text-white w-7 h-7 flex items-center justify-center rounded-full' : dayColorClass + ' leading-none'}">${dayLabel}</span>
                        ${isHoliday ? '<span class="text-[9px] text-red-500 mt-0.5">휴</span>' : ''}
                    </div>
                    
                    <!-- 내용 컬럼 -->
                    <div class="flex-grow pb-3 border-b border-gray-100 last:border-0 min-w-0 pt-1">
                         ${content}
                    </div>
                </div>
            `;
        }

        html += `
                </div> <!-- space-y-3 -->
        `;

        container.innerHTML = html;
        attachNavListeners(container, currentDate);

    } catch (error) {
        console.error('스케줄 리스트 렌더링 오류:', error);
        container.innerHTML = `<div class="p-4 text-red-600 text-center">
            <p class="font-bold">스케줄을 불러오지 못했습니다.</p>
            <p class="text-sm mt-2">${error.message}</p>
            <button onclick="window._retryScheduleList && window._retryScheduleList()" class="mt-4 px-4 py-2 bg-gray-200 rounded text-sm">다시 시도</button>
        </div>`;
    }
}

function attachNavListeners(container, currentDate = dayjs()) {
    container.querySelector('#prev-week-btn')?.addEventListener('click', () => {
        state.employee.scheduleViewDate = currentDate.subtract(1, 'week').format('YYYY-MM-DD');
        renderEmployeeMobileScheduleList();
    });

    container.querySelector('#next-week-btn')?.addEventListener('click', () => {
        state.employee.scheduleViewDate = currentDate.add(1, 'week').format('YYYY-MM-DD');
        renderEmployeeMobileScheduleList();
    });

    container.querySelector('#today-btn')?.addEventListener('click', () => {
        state.employee.scheduleViewDate = dayjs().format('YYYY-MM-DD');
        renderEmployeeMobileScheduleList();
    });

    container.querySelector('#view-mode-working')?.addEventListener('click', () => {
        state.employee.scheduleViewMode = 'working';
        renderEmployeeMobileScheduleList();
    });

    container.querySelector('#view-mode-off')?.addEventListener('click', () => {
        state.employee.scheduleViewMode = 'off';
        renderEmployeeMobileScheduleList();
    });

    // 부서 필터 버튼 (토글 방식, 복수 선택 — 전체 버튼 폐지, 선택된 부서만 표시)
    container.querySelectorAll('.dept-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const deptId = parseInt(btn.dataset.dept);
            if (state.employee.scheduleDeptFilter.has(deptId)) {
                state.employee.scheduleDeptFilter.delete(deptId);
            } else {
                state.employee.scheduleDeptFilter.add(deptId);
            }
            saveDeptFilter(); // 개인 선택을 localStorage 에 영속화
            renderEmployeeMobileScheduleList();
        });
    });

    requestAnimationFrame(() => {
        const todayEl = container.querySelector('.today-row');
        if (todayEl) {
            todayEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });
}



async function loadEmployeeData() {
    try {
        const userId = state.currentUser.id;

        const [requestsRes, docRequestsRes, submittedDocsRes] = await Promise.all([
            db.from('leave_requests').select('*').eq('employee_id', userId).order('created_at', { ascending: false }),
            db.from('document_requests').select('*').eq('employee_id', userId).order('created_at', { ascending: false }),
            db.from('submitted_documents').select('*').eq('employee_id', userId).order('created_at', { ascending: false })
        ]);

        if (requestsRes.error) throw requestsRes.error;

        const requests = requestsRes.data || [];
        state.employee.documentRequests = docRequestsRes.data || [];
        state.employee.submittedDocuments = submittedDocsRes.data || [];

        const offset = state.currentUser.periodOffset || 0;

        // 현재 주기(offset=0) 기준 계산
        const baseCurrentDetails = getLeaveDetails(state.currentUser);

        // offset 만큼 이동한 기준일(simDate) 생성
        const simDate = dayjs(baseCurrentDetails.periodStart).add(offset, 'year').add(1, 'day').toDate();

        // 타겟 주기 계산 (offset !== 0 인 과거/미래 주기는 수동 이월분을 미반영하여 순수 발생량만 계측)
        const targetUser = { ...state.currentUser, carried_over_leave: offset === 0 ? state.currentUser.carried_over_leave : 0 };
        const leaveDetails = (offset === 0) ? baseCurrentDetails : getLeaveDetails(targetUser, simDate);
        const pStart = dayjs(leaveDetails.periodStart);
        const pEnd = dayjs(leaveDetails.periodEnd);

        const approved = requests.filter(r => r.status === 'approved');

        // --- 작년도(타겟 주기의 직전 주기) 연차 당겨쓰기(초과분) 추출 범위 산출 ---
        const lastYearStart = pStart.subtract(1, 'year');
        const lastYearEnd = pEnd.subtract(1, 'year');
        const lastYearDetails = getLeaveDetails({ ...state.currentUser, carried_over_leave: 0 }, lastYearStart.add(1, 'day').toDate());

        let lastYearDates = [];
        approved.forEach(req => {
            (req.dates || []).forEach(dateStr => {
                if (isLeaveInPeriod(req, dateStr, lastYearStart, lastYearEnd)) {
                    lastYearDates.push({
                        date: dateStr,
                        type: (req.reason && req.reason.includes('수동')) ? 'manual' : 'formal',
                        requestId: req.id,
                        reason: req.reason || '',
                        leaveType: req.leave_type || 'full', // 반차(0.5일) 식별 — 당겨쓰기 분도 0.5로 집계
                        isBorrowedFromPast: true
                    });
                }
            });
        });

        lastYearDates.sort((a, b) => new Date(a.date) - new Date(b.date));
        let borrowedPastDates = [];
        if (lastYearDates.length > lastYearDetails.final) {
            borrowedPastDates = lastYearDates.slice(lastYearDetails.final);
        }

        // --- 금년 정상 사용분 추출 ---
        let currentDates = approved.flatMap(req => {
            return (req.dates || [])
                .filter(dateStr => isLeaveInPeriod(req, dateStr, pStart, pEnd))
                .map(dateStr => ({
                    date: dateStr,
                    type: (req.reason && req.reason.includes('수동')) ? 'manual' : 'formal',
                    requestId: req.id,
                    reason: req.reason || '',
                    leaveType: req.leave_type || 'full'
                }));
        });
        currentDates.sort((a, b) => new Date(a.date) - new Date(b.date));

        // 전체 사용 배열 조립 및 저장
        const usedDates = [...borrowedPastDates, ...currentDates];
        state.currentUser.usedDates = usedDates;

        // 반차는 0.5일로 집계 (오전반차 2번 ≠ 연차 1일)
        const usedDays = usedDates.reduce((sum, d) => sum + (d.leaveType === 'am_half' || d.leaveType === 'pm_half' ? 0.5 : 1), 0);

        // 수동 마이너스 이월값 방어 후 잔여 산출
        let actualCarriedOverCnt = leaveDetails.carriedOverCnt;
        if (actualCarriedOverCnt < 0) actualCarriedOverCnt = 0;
        const finalSansManual = leaveDetails.final - leaveDetails.carriedOverCnt;
        const newFinalLeaves = finalSansManual + actualCarriedOverCnt;

        _('#used-leaves').textContent = `${usedDays}일`;
        _('#remaining-leaves').textContent = `${newFinalLeaves - usedDays}일`;

        // 렌더링 당시의 오프셋 반영용 UI 업데이트 (상단 요약 박스에도 오프셋 주기 라벨 추가를 원할시 추가 작업, 여기서는 잔여수 그대로 표기)
        _('#final-leaves').textContent = `${newFinalLeaves}일`; // id 추가했던 확정연차 업데이트 (타겟 주기의 순수 분량)

        // 인라인 연차 박스 컨테이너 렌더링
        renderEmployeeLeaveGrid(newFinalLeaves, actualCarriedOverCnt, usedDays, state.currentUser.usedDates, offset, pStart, pEnd);

        const pending = requests.filter(r => r.status === 'pending');
        renderMyLeaveRequests(requests);
        initializeEmployeeCalendar(approved, pending);
        renderDocumentRequests();
        renderSubmittedDocuments();
        updateDocumentBadge();

        const pendingCount = state.employee.documentRequests.filter(req => req.status === 'pending').length;
        if (pendingCount > 0) {
            setTimeout(() => {
                alert(`미제출 서류가 ${pendingCount}건 있습니다!\n\n"서류 제출" 탭에서 확인해주세요.`);
            }, 500);
        }
    } catch (error) {
        console.error('직원 데이터 로딩 오류:', error);
        alert('데이터를 불러오는 중 오류가 발생했습니다: ' + error.message);
    }
}

function updateDocumentBadge() {
    const pendingCount = state.employee.documentRequests.filter(req => req.status === 'pending').length;
    const tabBadge = _('#doc-tab-badge');
    if (tabBadge) {
        if (pendingCount > 0) {
            tabBadge.textContent = pendingCount;
            tabBadge.classList.remove('hidden');
        } else {
            tabBadge.classList.add('hidden');
        }
    }

    // 대시보드 알림 배너
    const banner = _('#doc-alert-banner');
    const detail = _('#doc-alert-detail');
    if (banner) {
        if (pendingCount > 0) {
            banner.classList.remove('hidden');
            if (detail) detail.textContent = `미제출 서류 ${pendingCount}건 — 서류를 제출하지 않으면 연차 신청이 제한됩니다. 클릭하여 확인하세요.`;
        } else {
            banner.classList.add('hidden');
        }
    }
}

function renderDocumentRequests() {
    const container = _('#document-requests-list');
    if (!container) return;

    const requests = state.employee.documentRequests;

    if (requests.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">서류 제출 요청이 없습니다.</p>';
        return;
    }

    const pendingRequests = requests.filter(req => req.status === 'pending');

    if (pendingRequests.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">대기 중인 서류 요청이 없습니다. 모든 요청이 처리되었습니다.</p>';
        return;
    }

    const rows = pendingRequests.map(req => {
        let statusBadge = '<span class="bg-yellow-200 text-yellow-800 text-xs font-medium px-2.5 py-0.5 rounded-full">제출 대기</span>';
        let actionButton = `<button onclick="window.openDocSubmissionModal(${req.id})" class="text-sm bg-blue-600 text-white px-4 py-1 rounded hover:bg-blue-600 font-bold">작성하기</button>`;

        const docType = req.type || '일반 서류';

        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-3">${docType}</td>
                <td class="p-3 text-sm text-gray-600">${req.message || '-'}</td>
                <td class="p-3">${dayjs(req.created_at).format('YYYY-MM-DD')}</td>
                <td class="p-3">${statusBadge}</td>
                <td class="p-3 text-center">${actionButton}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left text-xs">서류 유형</th>
                    <th class="p-3 text-left text-xs">요청 사유</th>
                    <th class="p-3 text-left text-xs">요청일</th>
                    <th class="p-3 text-left text-xs">상태</th>
                    <th class="p-3 text-center text-xs">관리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function renderSubmittedDocuments() {
    const container = _('#submitted-docs-list');
    if (!container) return;

    const docs = state.employee.submittedDocuments;

    if (docs.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">제출한 서류가 없습니다.</p>';
        return;
    }

    const rows = docs.map(doc => {
        let statusBadge = '';

        switch (doc.status) {
            case 'submitted':
                statusBadge = '<span class="bg-yellow-200 text-yellow-800 text-xs font-medium px-2.5 py-0.5 rounded-full">검토 대기</span>';
                break;
            case 'approved':
                statusBadge = '<span class="bg-green-200 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded-full">승인됨</span>';
                break;
            case 'rejected':
                statusBadge = '<span class="bg-red-200 text-red-800 text-xs font-medium px-2.5 py-0.5 rounded-full">반려됨</span>';
                break;
        }

        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-3">${doc.template_name || '일반 서류'}</td>
                <td class="p-3">${dayjs(doc.created_at).format('YYYY-MM-DD HH:mm')}</td>
                <td class="p-3">${statusBadge}</td>
                <td class="p-3 text-center">
                    <button onclick="window.viewSubmittedDocument(${doc.id})" class="text-sm bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600">내용 보기</button>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left text-xs">서식명</th>
                    <th class="p-3 text-left text-xs">제출일시</th>
                    <th class="p-3 text-left text-xs">상태</th>
                    <th class="p-3 text-center text-xs">관리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

window.viewSubmittedDocument = function (docId) {
    const doc = state.employee.submittedDocuments.find(d => d.id === docId);
    if (!doc) {
        alert('서류를 찾을 수 없습니다.');
        return;
    }

    const content = doc.submission_data?.text || doc.text || '내용 없음';
    const attachmentHtml = doc.attachment_url ?
        `<div class="mb-4"><strong>첨부파일:</strong> <a href="${doc.attachment_url}" target="_blank" class="text-blue-600 hover:underline">파일 보기</a></div>` : '';

    const modalHTML = `
        <div class="modal-overlay" id="view-submitted-doc-modal">
            <div class="modal-content-lg" style="max-height: 90vh; overflow-y: auto;">
                <div class="flex justify-between items-center border-b pb-3 mb-4">
                    <h2 class="text-2xl font-bold">${doc.template_name || '서류'} 내용</h2>
                    <button id="close-view-submitted-doc-modal" class="text-3xl">&times;</button>
                </div>
                <div class="bg-white border-2 border-gray-800 p-6">
                    <div class="text-center mb-6">
                        <h1 class="text-2xl font-bold mb-2">${doc.template_name || '서류'}</h1>
                        <div class="text-xs text-gray-600">제출자: ${doc.employee_name}</div>
                        <div class="text-xs text-gray-600">제출일시: ${dayjs(doc.created_at).format('YYYY-MM-DD HH:mm')}</div>
                        <div class="text-xs text-gray-600">상태: 
                            ${doc.status === 'submitted' ? '검토 대기' :
            doc.status === 'approved' ? '승인됨' :
                doc.status === 'rejected' ? '반려됨' : doc.status}
                        </div>
                    </div>
                    ${attachmentHtml}
                    <div class="mb-4 whitespace-pre-wrap border p-4 rounded" style="line-height: 1.8;">${content}</div>
                    ${doc.signature ? `<div class="text-right"><img src="${doc.signature}" alt="서명" class="inline-block border-2 border-gray-800" style="width: 180px; height: 90px;"></div>` : ''}
                </div>
                <div class="flex justify-end pt-4 mt-4 border-t">
                    <button id="close-view-submitted-doc-btn" class="px-6 py-2 bg-gray-300 rounded hover:bg-gray-400">닫기</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    _('#close-view-submitted-doc-modal')?.addEventListener('click', () => {
        _('#view-submitted-doc-modal')?.remove();
    });
    _('#close-view-submitted-doc-btn')?.addEventListener('click', () => {
        _('#view-submitted-doc-modal')?.remove();
    });
};

function renderMyLeaveRequests(requests) {
    const container = _('#my-leave-requests');

    if (requests.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-4">신청 내역이 없습니다.</p>';
        return;
    }

    const statusBadges = {
        pending: '<span class="bg-yellow-200 text-yellow-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">대기중</span>',
        approved: '<span class="bg-green-200 text-green-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">승인됨</span>',
        rejected: '<span class="bg-red-200 text-red-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">반려됨</span>'
    };

    const rows = requests.map(req => {
        const dates = req.dates || [];
        let dateDisplay = '';

        if (dates.length > 0) {
            const firstDate = dayjs(dates[0]);
            const parts = [firstDate.format('YYYY-MM-DD')];

            for (let i = 1; i < dates.length; i++) {
                const currentDate = dayjs(dates[i]);
                const prevDate = dayjs(dates[i - 1]);

                if (currentDate.year() === prevDate.year() && currentDate.month() === prevDate.month()) {
                    parts.push(currentDate.format('DD'));
                } else if (currentDate.year() === prevDate.year()) {
                    parts.push(currentDate.format('MM-DD'));
                } else {
                    parts.push(currentDate.format('YYYY-MM-DD'));
                }
            }

            dateDisplay = parts.join(', ');
        }

        const halfLabel = req.leave_type === 'am_half' ? ' (오전반차)' : req.leave_type === 'pm_half' ? ' (오후반차)' : '';
        if (halfLabel) dateDisplay += `<span class="text-[10px] text-amber-600">${halfLabel}</span>`;

        return `
            <tr class="border-b">
                <td class="p-3">${dateDisplay}</td>
                <td class="p-3">${dayjs(req.created_at).format('YYYY-MM-DD')} <span class="text-[10px] text-gray-400">${dayjs(req.created_at).format('HH:mm')}</span></td>
                <td class="p-3">${statusBadges[req.status] || req.status}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left">신청 날짜</th>
                    <th class="p-3 text-left">신청 일시</th>
                    <th class="p-3 text-left">상태</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

let selectedDatesForLeave = [];
let employeeCalendarInstance = null;
let leaveBlockedDates = new Set(); // 연차 신청 불가일 (매니저가 스케줄 그리드에서 지정)

function initializeEmployeeCalendar(approvedRequests, pendingRequests = []) {
    const container = _('#employee-calendar-container');

    if (!container) return;

    // 연차 신청 불가일 로드 (app_settings.leave_blocked_dates) — 로드 후 달력 마커 갱신
    db.from('app_settings').select('value').eq('key', 'leave_blocked_dates').maybeSingle()
        .then(({ data }) => {
            const arr = data && data.value;
            leaveBlockedDates = new Set(Array.isArray(arr) ? arr : []);
            if (employeeCalendarInstance) employeeCalendarInstance.refetchEvents();
        })
        .catch(() => { /* 조회 실패 시 차단 없음 */ });

    if (employeeCalendarInstance) {
        try {
            employeeCalendarInstance.destroy();
        } catch (e) {
        }
        employeeCalendarInstance = null;
    }

    const approvedDates = approvedRequests.flatMap(r => r.dates || []);
    const pendingDates = pendingRequests.flatMap(r => r.dates || []);
    selectedDatesForLeave.length = 0;

    container.innerHTML = '';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'flex justify-between items-center mb-4';
    buttonContainer.innerHTML = `
        <h2 class="text-xl font-bold cal-title">연차 신청 달력 <span class="text-sm text-gray-500 cal-title-hint">(날짜를 클릭하여 선택/해제)</span></h2>
        <div class="flex gap-2">
            <span id="selected-dates-count" class="text-sm text-gray-600 self-center">선택된 날짜: 0일</span>
            <button id="clear-selection-btn" class="px-3 py-1 text-sm bg-gray-300 rounded hover:bg-gray-400">선택 취소</button>
            <button id="submit-leave-request-btn" class="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 font-bold">연차 신청하기</button>
        </div>
    `;

    const calendarEl = document.createElement('div');
    calendarEl.id = 'employee-calendar';

    container.appendChild(buttonContainer);
    container.appendChild(calendarEl);

    if (typeof FullCalendar === 'undefined') {
        alert('달력 라이브러리가 로드되지 않았습니다.');
        return;
    }

    employeeCalendarInstance = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        headerToolbar: {
            left: 'today',
            center: 'prev title next',
            right: ''
        },
        height: 'auto',
        locale: 'ko',
        selectable: false,
        editable: false,
        events: function (info, successCallback) {
            const isMobile = window.innerWidth < 640;
            const approvedTitle = isMobile ? '승인' : '연차 (승인됨)';
            const pendingTitle = isMobile ? '대기' : '승인 대기중';
            const selectedTitle = isMobile ? '선택' : '선택됨';
            const events = [
                ...approvedDates.map(date => ({
                    title: approvedTitle,
                    start: date,
                    allDay: true,
                    color: '#10b981',
                    textColor: '#ffffff',
                    classNames: ['approved-leave']
                })),
                ...pendingDates.map(date => ({
                    title: pendingTitle,
                    start: date,
                    allDay: true,
                    color: '#f59e0b',
                    textColor: '#ffffff',
                    classNames: ['pending-leave']
                })),
                ...selectedDatesForLeave.map(date => ({
                    title: selectedTitle,
                    start: date,
                    allDay: true,
                    color: '#3b82f6',
                    textColor: '#ffffff',
                    classNames: ['selected-date']
                })),
                ...Array.from(leaveBlockedDates).map(date => ({
                    title: isMobile ? '신청불가' : '연차 신청 불가',
                    start: date,
                    allDay: true,
                    color: '#9ca3af',
                    textColor: '#ffffff',
                    classNames: ['leave-blocked-day']
                }))
            ];
            successCallback(events);
        },
        dateClick: function (info) {
            const dateStr = info.dateStr;

            if (leaveBlockedDates.has(dateStr)) {
                alert('연차 신청 불가일로 지정된 날짜입니다.\n해당 날짜는 연차를 신청할 수 없습니다.');
                return;
            }
            if (approvedDates.includes(dateStr)) {
                alert('이미 승인된 연차가 있는 날짜입니다.');
                return;
            }
            if (pendingDates.includes(dateStr)) {
                alert('이미 승인 대기중인 연차가 있는 날짜입니다.');
                return;
            }

            const index = selectedDatesForLeave.indexOf(dateStr);
            if (index > -1) {
                selectedDatesForLeave.splice(index, 1);
            } else {
                selectedDatesForLeave.push(dateStr);
            }

            updateSelectionUI();
            employeeCalendarInstance.refetchEvents();
        }
    });

    function updateSelectionUI() {
        const count = selectedDatesForLeave.length;
        const countEl = _('#selected-dates-count');
        if (countEl) countEl.textContent = `선택된 날짜: ${count}일`;
    }

    employeeCalendarInstance.render();
    updateSelectionUI();

    const clearBtn = _('#clear-selection-btn');
    const submitBtn = _('#submit-leave-request-btn');

    if (clearBtn) {
        clearBtn.onclick = () => {
            selectedDatesForLeave.length = 0;
            updateSelectionUI();
            employeeCalendarInstance.refetchEvents();
        };
    }

    if (submitBtn) {
        submitBtn.onclick = () => {
            if (selectedDatesForLeave.length === 0) {
                alert('날짜를 선택해주세요.');
                return;
            }
            openLeaveFormModal([...selectedDatesForLeave]);
        };
    }
}

function openLeaveFormModal(dates) {
    _('#form-applicant-name').textContent = state.currentUser.name;
    // 날짜별 leave_type 관리 (기본 full)
    if (!state.employee.leaveTypes) state.employee.leaveTypes = {};
    dates.forEach(d => { if (!state.employee.leaveTypes[d]) state.employee.leaveTypes[d] = 'full'; });

    _('#form-selected-dates').innerHTML = dates.sort().map(d => {
        const lt = state.employee.leaveTypes[d] || 'full';
        const halfLabel = lt === 'am_half' ? ' 오전' : lt === 'pm_half' ? ' 오후' : '';
        const bgClass = lt === 'full' ? 'bg-blue-100 text-blue-800' : 'bg-yellow-100 text-yellow-800';
        return `<div class="inline-flex items-center ${bgClass} rounded mr-2 mb-2">
            <span class="px-2 py-1">${d}${halfLabel}</span>
            <select data-date="${d}" class="leave-type-select bg-transparent text-xs py-1 cursor-pointer focus:outline-none" style="width:16px; opacity:0.4; padding:0;">
                <option value="full" ${lt==='full'?'selected':''}></option>
                <option value="am_half" ${lt==='am_half'?'selected':''}>오전</option>
                <option value="pm_half" ${lt==='pm_half'?'selected':''}>오후</option>
            </select>
        </div>`;
    }).join('');

    // 드롭다운 변경 시 leaveType 업데이트 + 리렌더
    _('#form-selected-dates').querySelectorAll('.leave-type-select').forEach(sel => {
        sel.addEventListener('change', () => {
            state.employee.leaveTypes[sel.dataset.date] = sel.value;
            openLeaveFormModal([...state.employee.selectedDates]);
        });
    });
    _('#form-reason').value = '';

    // 당겨쓰기 계산 로직
    const requestDays = dates.length;
    // 현재 잔여 연차 계산 (UI에서 가져오거나 다시 계산)
    // 안전하게 다시 계산 권장
    const leaveDetails = getLeaveDetails(state.currentUser);
    const pStart = dayjs(leaveDetails.periodStart);
    const pEnd = dayjs(leaveDetails.periodEnd);

    // 이미 승인된 연차 중 '이번 기간'에 해당하는 것만 사용량으로 간주
    // (메모리 상 leaveRequests가 없을 수도 있으니, 간단히 textContent 파싱하거나, 전역 state 사용)
    // state.employee.leaveRequests 가 loadEmployeeData에서 세팅됨을 가정할 수 없으므로(UI만 그렸을 수도),
    // 화면의 #remaining-leaves 텍스트를 파싱하는 건 위험.
    // --> loadEmployeeData 스코프 변수라 접근 불가.
    // 하지만 renderEmployeePortal에서 loadEmployeeData를 부르니, 전역에 저장하는 게 좋음.
    // 일단 여기서는 'UI에 렌더링된 값'을 신뢰하거나, DB를 다시 조회해야 함. 
    // -> 성능상 UI 값 파싱이 빠름. 단, 정확성을 위해 state.employee 에 저장된 데이터를 활용하자. 
    // (renderEmployeePortal에서 requests를 state에 저장 안 함... my-leave-requests에 바로 그림)
    // **수정**: loadEmployeeData에서 state.employee.myRequests = requests; 로 저장해두자.

    // 임시: DB 조회 없이 UI 텍스트 파싱 (빠른 구현)
    const remainingText = _('#remaining-leaves').textContent.replace('일', '');
    const currentRemaining = parseFloat(remainingText) || 0;

    const projectedRemaining = currentRemaining - requestDays;
    const borrowingSection = _('#borrowing-agreement-section');
    const borrowingAmountSpan = _('#borrowing-amount');
    const borrowingCheck = _('#borrowing-agreement-check');

    if (projectedRemaining < 0) {
        borrowingSection.classList.remove('hidden');
        borrowingAmountSpan.textContent = Math.abs(projectedRemaining);
        borrowingCheck.checked = false; // 항상 체크 해제 상태로 시작
    } else {
        borrowingSection.classList.add('hidden');
        borrowingCheck.checked = false;
    }

    state.employee.selectedDates = dates;
    show('#leave-form-modal');

    // 모달이 보인 후 canvas 초기화 (크기 정확히 잡기 위해 requestAnimationFrame 사용)
    requestAnimationFrame(() => {
        const canvas = _('#signature-canvas');
        if (canvas) {
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width;
            canvas.height = rect.height;
            if (!window.signaturePad) {
                window.signaturePad = new SignaturePad(canvas, {
                    penColor: '#000000',
                    backgroundColor: 'rgba(255, 255, 255, 0)'
                });
            } else {
                window.signaturePad.clear();
            }
        }
    });
}

window.openLeaveFormModal = openLeaveFormModal;

export function closeLeaveFormModal() {
    hide('#leave-form-modal');
    state.employee.selectedDates = [];
}

export async function handleSubmitLeaveRequest() {
    const dates = state.employee.selectedDates;
    const reason = _('#form-reason').value.trim();
    const signatureData = window.signaturePad?.toDataURL();

    if (!dates || dates.length === 0) {
        alert('날짜를 선택해주세요.');
        return;
    }

    // 연차 신청 불가일 방어 (달력 선택 단계에서 1차 차단하지만 안전망)
    const blockedSelected = dates.filter(d => leaveBlockedDates.has(d));
    if (blockedSelected.length > 0) {
        alert('연차 신청 불가일이 포함되어 있습니다:\n' + blockedSelected.join(', ') + '\n\n해당 날짜를 제외하고 신청해주세요.');
        return;
    }

    if (!signatureData || window.signaturePad.isEmpty()) {
        alert('서명을 해주세요.');
        return;
    }

    // 미제출 서류 체크
    const { data: pendingRequests, error: checkError } = await db.from('document_requests')
        .select('*')
        .eq('employee_id', state.currentUser.id)
        .eq('status', 'pending');

    if (pendingRequests && pendingRequests.length > 0) {
        alert('⚠️ 미제출 서류가 있습니다.\n\n서류를 먼저 제출해야 연차 신청이 가능합니다.\n\n"서류 제출" 탭에서 요청된 서류를 확인해주세요.');
        return;
    }

    // 연차 신청 마감일수 — 연차일 기준 N일 전까지 신청. 그보다 임박(과거 포함)하면 사유서 필요.
    // admin 설정값(app_settings.leave_notice_days), 기본 7일.
    let noticeDays = 7;
    try {
        const { data: nd } = await db.from('app_settings').select('value').eq('key', 'leave_notice_days').maybeSingle();
        if (nd && nd.value != null && !isNaN(Number(nd.value))) noticeDays = Number(nd.value);
    } catch (_) { /* 설정 조회 실패 시 기본 7일 유지 */ }

    const cutoff = dayjs().add(noticeDays, 'day').format('YYYY-MM-DD');
    const lateDates = dates.filter(d => d < cutoff);   // 임박(과거 포함) — 사유서 필요
    const normalDates = dates.filter(d => d >= cutoff); // 여유 — 사유서 불요
    const hasLateDates = lateDates.length > 0;

    // 임박 + 여유 혼합 신청 차단 (한 신청서를 한 유형으로 통일)
    if (hasLateDates && normalDates.length > 0) {
        alert(`⚠️ 신청기간(${noticeDays}일)이 임박한 날짜와 여유 있는 날짜를 동시에 신청할 수 없습니다.\n\n각각 따로 신청해주세요.`);
        return;
    }

    // 당겨쓰기 동의 체크 확인
    const borrowingSection = _('#borrowing-agreement-section');
    const borrowingCheck = _('#borrowing-agreement-check');
    if (!borrowingSection.classList.contains('hidden')) {
        if (!borrowingCheck.checked) {
            alert('당겨쓰기 동의사항에 체크해주세요.');
            return;
        }
        // 사유에 당겨쓰기 명시 (선택사항, 하지만 명시적으로 남기는 게 좋음)
        // reason += ' [당겨쓰기 확인됨]'; 
    }

    try {
        // 반차와 연차를 분리하여 INSERT
        const leaveTypes = state.employee.leaveTypes || {};
        const fullDates = dates.filter(d => (leaveTypes[d] || 'full') === 'full');
        const halfDates = dates.filter(d => leaveTypes[d] === 'am_half' || leaveTypes[d] === 'pm_half');

        const inserts = [];
        if (fullDates.length > 0) {
            inserts.push({
                employee_id: state.currentUser.id,
                employee_name: state.currentUser.name,
                dates: fullDates,
                reason: reason || null,
                signature: signatureData,
                status: 'pending',
                leave_type: 'full',
                created_at: new Date().toISOString()
            });
        }
        // 반차는 개별 INSERT (각각 다른 leave_type)
        for (const d of halfDates) {
            inserts.push({
                employee_id: state.currentUser.id,
                employee_name: state.currentUser.name,
                dates: [d],
                reason: reason || null,
                signature: signatureData,
                status: 'pending',
                leave_type: leaveTypes[d],
                created_at: new Date().toISOString()
            });
        }

        const { error } = await db.from('leave_requests').insert(inserts);
        if (error) throw error;
        state.employee.leaveTypes = {}; // 초기화

        // 신청기간(N일)이 지난 임박 날짜가 포함되어 있으면 서류 제출 요청 자동 생성
        if (hasLateDates) {
            const lateDateStr = lateDates.join(', ');
            await db.from('document_requests').insert({
                employee_id: state.currentUser.id,
                document_name: state.currentUser.name,
                type: '사유서',
                message: `${lateDateStr} 연차 신청기간(${noticeDays}일) 경과 — 사유서 제출 요청`,
                note: `${lateDateStr} 사유서`,
                status: 'pending',
                created_at: new Date().toISOString()
            });
            alert(`연차 신청이 완료되었습니다.\n\n⚠️ 신청기간(${noticeDays}일 전)이 지난 날짜(${lateDateStr})가 포함되어 있어\n사유서 제출이 필요합니다.\n\n"서류 제출" 탭에서 사유서를 작성해주세요.\n서류 미제출 시 추가 연차 신청이 제한됩니다.`);
        } else {
            alert('연차 신청이 완료되었습니다.');
        }

        closeLeaveFormModal();
        renderEmployeePortal();
        selectedDatesForLeave.length = 0;
    } catch (error) {
        console.error('연차 신청 오류:', error);
        alert('연차 신청 중 오류가 발생했습니다: ' + error.message);
    }
}

function renderManagerLeaveStatus() {
    const container = _('#employee-leave-status-tab');
    if (!container) return;
    container.innerHTML = getLeaveStatusHTML();
}

async function renderManagerLeaveList() {
    const container = _('#employee-leave-list-tab');
    if (!container) return;
    container.innerHTML = getLeaveListHTML();
    setTimeout(() => {
        if (typeof window.renderLeaveCalendar === 'function') {
            window.renderLeaveCalendar('#employee-leave-list-tab #leave-calendar-container');
        }
    }, 100);
}

async function renderManagerScheduleTab() {
    const container = _('#employee-schedule-tab');
    if (!container) return;
    await renderScheduleManagement(container, false, true); // isReadOnly=false, isManager=true
}

window.openDocSubmissionModal = async function (requestId) {
    const request = state.employee.documentRequests.find(req => req.id === requestId);
    if (!request) {
        alert('요청을 찾을 수 없습니다.');
        return;
    }

    state.docSubmission.currentRequestId = requestId;

    const today = dayjs().format('YYYY년 MM월 DD일');

    // 해당 서류 유형이 파일 첨부 필수인지 확인
    const isAttachmentRequired = await checkIfAttachmentRequired(request.type);

    const modalHTML = `
        <div id="temp-doc-submission-modal" class="modal-overlay">
            <div class="modal-content-lg" style="max-height: 90vh; overflow-y: auto;">
                <div class="flex justify-between items-center border-b pb-3 mb-4 sticky top-0 bg-white z-10">
                    <h2 class="text-2xl font-bold">${request.type || '서류'} 제출</h2>
                    <button id="close-temp-doc-modal" class="text-3xl">&times;</button>
                </div>
                
                <!-- 공문서 형식 -->
                <div class="bg-white border-2 border-gray-800 p-6" style="min-height: auto;">
                    <div class="text-center mb-6">
                        <h1 class="text-2xl font-bold mb-2">${request.type || '서류'}</h1>
                        <div class="text-xs text-gray-600">문서번호: DOC-${requestId}-${dayjs().format('YYYYMMDD')}</div>
                    </div>
                    
                    <table class="w-full mb-4 border border-gray-800 text-sm" style="border-collapse: collapse;">
                        <tr>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold" style="width: 100px;">제출자</td>
                            <td class="border border-gray-800 px-3 py-2">${state.currentUser.name}</td>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold" style="width: 100px;">소속</td>
                            <td class="border border-gray-800 px-3 py-2">${state.currentUser.departments?.name || '부서 미지정'}</td>
                        </tr>
                        <tr>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold">제출일</td>
                            <td class="border border-gray-800 px-3 py-2" colspan="3">${today}</td>
                        </tr>
                        <tr>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold">사유</td>
                            <td class="border border-gray-800 px-3 py-2" colspan="3">${request.message || '-'}</td>
                        </tr>
                    </table>
                    
                    ${isAttachmentRequired ? `
                    <div class="mb-4">
                        <div class="font-bold mb-2 text-red-600">🔎 파일 첨부 (필수)</div>
                        <input type="file" id="doc-attachment" class="w-full p-2 border-2 border-red-300 rounded" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" required>
                        <div class="text-xs text-gray-600 mt-1">지원 형식: PDF, DOC, DOCX, JPG, PNG (최대 10MB)</div>
                    </div>
                    ` : ''}
                    
                    <div class="mb-4">
                        <div class="font-bold mb-2">내용</div>
                        <textarea id="doc-content" rows="8" class="w-full p-3 border-2 border-gray-800 text-sm" style="resize: none; line-height: 1.6;" placeholder="서류 내용을 작성하세요..."></textarea>
                    </div>
                    
                    <div class="flex justify-end items-end mb-4">
                        <div class="text-right">
                            <div class="mb-2 font-bold text-sm">제출자 서명</div>
                            <div class="border-2 border-gray-800 bg-gray-50" style="width: 180px; height: 90px; position: relative;">
                                <canvas id="doc-signature-canvas" width="180" height="90" style="cursor: crosshair;"></canvas>
                                <button type="button" id="clear-doc-signature" class="absolute top-1 right-1 text-xs bg-white border px-2 py-0.5 rounded hover:bg-gray-100">지우기</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="text-center text-xs text-gray-600">
                        위와 같이 서류를 제출합니다.
                    </div>
                </div>
                
                <div class="flex justify-end space-x-3 pt-4 mt-4 border-t sticky bottom-0 bg-white">
                    <button id="cancel-temp-doc-btn" class="px-6 py-2 bg-gray-300 rounded hover:bg-gray-400">취소</button>
                    <button id="submit-temp-doc-btn" class="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-bold">제출하기</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const canvas = document.getElementById('doc-signature-canvas');
    window.docSignaturePad = new SignaturePad(canvas, {
        backgroundColor: 'rgb(249, 250, 251)',
        penColor: 'rgb(0, 0, 0)'
    });

    document.getElementById('clear-doc-signature').addEventListener('click', () => {
        window.docSignaturePad.clear();
    });

    document.getElementById('close-temp-doc-modal').addEventListener('click', closeDocSubmissionModal);
    document.getElementById('cancel-temp-doc-btn').addEventListener('click', closeDocSubmissionModal);
    document.getElementById('submit-temp-doc-btn').addEventListener('click', handleDocumentSubmit);
};

async function checkIfAttachmentRequired(docType) {
    try {
        const { data: templates, error } = await db.from('document_templates')
            .select('requires_attachment')
            .eq('template_name', docType)
            .single();

        if (error || !templates) return false;
        return templates.requires_attachment || false;
    } catch (error) {
        console.error('서식 정보 확인 실패:', error);
        return false;
    }
}

function closeDocSubmissionModal() {
    const modal = _('#temp-doc-submission-modal');
    if (modal) modal.remove();
    state.docSubmission.currentRequestId = null;
}

async function handleDocumentSubmit() {
    const content = _('#doc-content')?.value.trim();
    const requestId = state.docSubmission.currentRequestId;
    const attachmentInput = _('#doc-attachment');

    if (!content) {
        alert('서류 내용을 작성해주세요.');
        return;
    }

    if (!window.docSignaturePad || window.docSignaturePad.isEmpty()) {
        alert('서명을 해주세요.');
        return;
    }

    if (attachmentInput && attachmentInput.hasAttribute('required') && !attachmentInput.files[0]) {
        alert('파일 첨부가 필수입니다.');
        return;
    }

    const request = state.employee.documentRequests.find(req => req.id === requestId);
    if (!request) {
        alert('요청 정보를 찾을 수 없습니다.');
        return;
    }

    const signatureData = window.docSignaturePad.toDataURL();

    const submitBtn = _('#submit-temp-doc-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '제출 중...';
    }

    try {
        let attachmentUrl = null;

        if (attachmentInput && attachmentInput.files[0]) {
            const file = attachmentInput.files[0];

            if (file.size > 10 * 1024 * 1024) {
                alert('파일 크기는 10MB 이하여야 합니다.');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '제출하기'; }
                return;
            }

            const fileName = `${state.currentUser.id}_${Date.now()}_${file.name}`;
            const { data: uploadData, error: uploadError } = await db.storage
                .from('document-attachments')
                .upload(fileName, file);

            if (uploadError) {
                console.error('파일 업로드 실패:', uploadError);
                alert('파일 업로드에 실패했습니다. 다시 시도해주세요.');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '제출하기'; }
                return;
            }

            const { data: urlData } = db.storage
                .from('document-attachments')
                .getPublicUrl(fileName);

            attachmentUrl = urlData.publicUrl;
        }

        const { data, error } = await db
            .from('submitted_documents')
            .insert({
                employee_id: state.currentUser.id,
                employee_name: state.currentUser.name,
                template_name: request.type || '일반 서류',
                submission_data: { text: content },
                signature: signatureData,
                attachment_url: attachmentUrl,
                status: 'submitted',
                related_issue_id: requestId
            })
            .select();

        if (error) {
            throw new Error(`${error.message}`);
        }

        const { error: updateError } = await db
            .from('document_requests')
            .update({ status: 'submitted' })
            .eq('id', requestId);

        const badge = document.getElementById('doc-tab-badge');
        if (badge) {
            const current = parseInt(badge.innerText) || 0;
            if (current > 0) badge.innerText = current - 1;
            if (current - 1 <= 0) badge.classList.add('hidden');
        }

        alert('서류가 제출되었습니다.');
        closeDocSubmissionModal();
        await loadEmployeeData();
    } catch (error) {
        console.error('서류 제출 실패:', error);
        alert('서류 제출에 실패했습니다.\n\n오류 내용: ' + error.message);

        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '제출하기';
        }
    }
}

window.changeMyLeavePeriod = function (delta) {
    if (!state.currentUser.periodOffset) state.currentUser.periodOffset = 0;
    state.currentUser.periodOffset += delta;
    loadEmployeeData(); // 다시 로딩하여 해당 주기로 렌더링
};

function renderEmployeeLeaveGrid(finalLeaves, carriedCnt, usedCnt, usedDatesArr, offset, periodStart, periodEnd) {
    const container = document.getElementById('employee-leave-grid-container');
    if (!container) return;

    // 사용 엔트리 = 반차도 각각 한 칸 (오전반차 2번을 "1일 연차" 한 칸으로 합치지 않음)
    const usedEntries = usedDatesArr || [];
    const isCurrentPeriod = offset === 0;
    const periodLabel = `${periodStart.format('YY.MM.DD')} ~`;
    const labelColor = isCurrentPeriod ? 'bg-gray-100 text-gray-600 border-gray-200' : 'bg-blue-100 text-blue-700 font-bold border-blue-200';

    let gridHTML = `
        <style>
            .leave-grid-container {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
                gap: 4px;
            }
            @media (min-width: 640px) {
                .leave-grid-container {
                    grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
                }
            }
            .leave-box {
                height: 30px;
                border: 1px solid #e5e7eb; border-radius: 4px;
                display: flex; align-items: center; justify-content: center;
                font-size: 11px; background-color: #ffffff; color: #9ca3af;
                position: relative;
            }
            .leave-box.type-regular { border-color: #93c5fd; color: #3b82f6; background-color: #eff6ff; }
            .leave-box.type-regular.used { background-color: #93c5fd; color: #1e40af; font-weight: bold; }
            .leave-box.type-carried { border-color: #d8b4fe; color: #a855f7; background-color: #faf5ff; }
            .leave-box.type-carried.used { background-color: #d8b4fe; color: #6b21a8; font-weight: bold; }
            .leave-box.type-borrowed { border-color: #fca5a5; color: #ef4444; background-color: #fef2f2; font-weight: bold; }
            .leave-box.type-borrowed.used { background-color: #fca5a5; color: #991b1b; }
            .leave-box.manual-entry::after {
                content: ''; position: absolute; top: 2px; right: 2px;
                width: 4px; height: 4px; border-radius: 50%; background-color: #eab308;
            }
            /* 반차 대각선 카드: 오전=좌상 삼각형, 오후=우하 삼각형, 날짜 작게 따로 */
            .leave-box.split { position: relative; padding: 0; overflow: hidden; background-color: #ffffff; }
            .leave-box.split .half-am, .leave-box.split .half-pm {
                position: absolute; font-size: 8px; line-height: 1; font-weight: bold; color: #1f2937; z-index: 1; white-space: nowrap;
            }
            .leave-box.split .half-am { top: 2px; left: 3px; }
            .leave-box.split .half-pm { bottom: 2px; right: 3px; }
            .leave-box.split .empty-half { color: #d1d5db; font-weight: normal; }
            .leave-box:hover { transform: translateY(-1px); box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
        </style>
        <div class="flex items-center justify-center gap-2 mb-2">
            <button onclick="window.changeMyLeavePeriod(-1)" class="p-1 text-gray-400 hover:text-blue-600 focus:outline-none transition-colors" title="이전 주기">◀</button>
            <div class="text-xs px-2 py-1 border rounded whitespace-nowrap ${labelColor}" title="해당 주기 기준일">${periodLabel}</div>
            <button onclick="window.changeMyLeavePeriod(1)" class="p-1 text-gray-400 hover:text-blue-600 focus:outline-none transition-colors" title="다음 주기">▶</button>
        </div>
        <div class="leave-grid-container">
    `;

    // 소진 순서: 이월 -> 금년 -> 당겨쓰기. 소진 위치 판정은 '일수 누적'(반차=0.5)으로.
    const bucketFor = (dayPos) => {
        if (dayPos < carriedCnt) return 'carried';
        if (dayPos < finalLeaves) return 'regular';
        return 'borrowed'; // 한도 초과 = 당겨쓰기
    };

    let boxHTML = '';

    // 1) 사용 칸 구성 (종일=꽉찬 카드, 반차=오전 좌상·오후 우하 대각선 합침, 날짜 각각 작게)
    const fillColorOf = { carried: '#d8b4fe', regular: '#93c5fd', borrowed: '#fca5a5' };
    const byDate = (a, b) => new Date(a.date || a) - new Date(b.date || b);

    const borrowedPast = usedEntries.filter(u => u.isBorrowedFromPast);
    const current = usedEntries.filter(u => !u.isBorrowedFromPast);
    const fullsCur = current.filter(u => (u.leaveType || 'full') === 'full').sort(byDate);
    const amsCur = current.filter(u => u.leaveType === 'am_half').sort(byDate);
    const pmsCur = current.filter(u => u.leaveType === 'pm_half').sort(byDate);

    const cards = [];
    borrowedPast.forEach(u => {
        const lt = u.leaveType || 'full';
        if (lt === 'am_half') cards.push({ kind: 'pair', am: u, pm: null, dayVal: 0.5, sortDate: u.date });
        else if (lt === 'pm_half') cards.push({ kind: 'pair', am: null, pm: u, dayVal: 0.5, sortDate: u.date });
        else cards.push({ kind: 'full', full: u, dayVal: 1, sortDate: u.date });
    });
    const curCards = [];
    fullsCur.forEach(f => curCards.push({ kind: 'full', full: f, dayVal: 1, sortDate: f.date }));
    const pairN = Math.max(amsCur.length, pmsCur.length);
    for (let k = 0; k < pairN; k++) {
        const am = amsCur[k] || null, pm = pmsCur[k] || null;
        curCards.push({ kind: 'pair', am, pm, dayVal: (am ? 0.5 : 0) + (pm ? 0.5 : 0), sortDate: (am ? am.date : pm.date) });
    }
    curCards.sort((a, b) => new Date(a.sortDate) - new Date(b.sortDate));
    cards.push(...curCards);

    let cumDays = 0;
    cards.forEach(card => {
        const boxType = bucketFor(cumDays);
        if (card.kind === 'full') {
            const u = card.full;
            let boxClass = `leave-box type-${boxType} used`;
            if (u.type === 'manual') boxClass += ' manual-entry';
            const typeTitle = boxType === 'borrowed' ? '당겨쓰기(초과)' : '연차사용';
            boxHTML += `<div class="${boxClass}" title="${typeTitle}: ${u.date} ${u.reason || ''}">${dayjs(u.date).format('M.D')}</div>`;
        } else {
            const am = card.am, pm = card.pm;
            const amFill = am ? fillColorOf[boxType] : '#ffffff';
            const pmFill = pm ? fillColorOf[boxType] : '#ffffff';
            const bg = `linear-gradient(to bottom right, ${amFill} 0 calc(50% - 0.4px), #9ca3af calc(50% - 0.4px) calc(50% + 0.4px), ${pmFill} calc(50% + 0.4px) 100%)`;
            const manual = (am && am.type === 'manual') || (pm && pm.type === 'manual');
            const amSpan = am ? `<span class="half-am" title="오전반차: ${am.date}">${dayjs(am.date).format('M.D')}</span>` : `<span class="half-am empty-half">·</span>`;
            const pmSpan = pm ? `<span class="half-pm" title="오후반차: ${pm.date}">${dayjs(pm.date).format('M.D')}</span>` : `<span class="half-pm empty-half">·</span>`;
            const titleParts = [];
            if (am) titleParts.push(`오전반차 ${am.date}`);
            if (pm) titleParts.push(`오후반차 ${pm.date}`);
            boxHTML += `<div class="leave-box split type-${boxType}${manual ? ' manual-entry' : ''}" style="background:${bg};" title="${titleParts.join(' / ')}">${amSpan}${pmSpan}</div>`;
        }
        cumDays += card.dayVal;
    });

    // 2) 미사용 권리 칸: 남은 일수만큼 빈 박스 (반차가 점유한 0.5 슬롯은 올림 처리)
    const usedWholeSlots = Math.ceil(cumDays - 1e-9);
    for (let i = usedWholeSlots; i < finalLeaves; i++) {
        const boxType = bucketFor(i);
        const boxLabel = boxType === 'carried' ? `이${i + 1}` : (i + 1);
        const dataAttrs = `title="${boxType === 'carried' ? '이월 연차' : '금년 연차'} (미사용)"`;
        boxHTML += `<div class="leave-box type-${boxType}" ${dataAttrs}>${boxLabel}</div>`;
    }

    // 3) 한도를 다 채웠으면 당겨쓰기 여유칸 1개
    if (usedWholeSlots >= finalLeaves) {
        let boxClass = `leave-box type-borrowed border-dashed border-2 cursor-pointer text-gray-400 font-bold`;
        boxClass = boxClass.replace('bg-fef2f2', 'bg-white').replace('border-fca5a5', 'border-gray-300').replace('text-ef4444', 'text-gray-400');
        boxHTML += `<div class="${boxClass}" title="추가 연차(당겨쓰기) 등록 가능">+</div>`;
    }

    gridHTML += boxHTML + `
        </div>
        <div class="flex flex-wrap gap-3 mt-2 text-xs text-gray-500 justify-end">
            <span class="flex items-center gap-1"><span class="w-3 h-3 bg-purple-200 border border-purple-400 rounded"></span>이월 연차</span>
            <span class="flex items-center gap-1"><span class="w-3 h-3 bg-blue-200 border border-blue-400 rounded"></span>금년 연차</span>
            <span class="flex items-center gap-1"><span class="w-3 h-3 bg-red-200 border border-red-400 rounded"></span>올해 당겨쓰기</span>
            <span class="flex items-center gap-1"><span class="w-3 h-3 bg-white border border-gray-200 rounded relative"><span class="w-1.5 h-1.5 bg-yellow-500 rounded-full absolute top-[1px] right-[1px]"></span></span>수동 차감건</span>
        </div>
    `;

    container.innerHTML = gridHTML;
}

