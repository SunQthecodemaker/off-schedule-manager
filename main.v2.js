import { state, db } from './state.js?v=20260612c';
import { _, _all, show, hide } from './utils.js';
import { renderScheduleManagement } from './schedule.js?v=20260612c';
import { assignManagementEventHandlers, getManagementHTML, getDepartmentManagementHTML, getLeaveListHTML, getLeaveManagementHTML, handleBulkRegister, getLeaveStatusHTML, addLeaveStatusEventListeners, formatLeaveChange } from './management.js?v=20260612c';
import { renderDocumentReviewTab, renderTemplatesManagement } from './documents.js?v=20260612c';
import { renderEmployeePortal, getManagerPerm } from './employee-portal-final.js?v=20260612c';
import { renderMobileAdminPortal } from './mobile-admin.js?v=20260612c';
import { loadPendingChanges, approvePendingChange, rejectPendingChange, approveAllPending, rejectAllPending } from './staging.js?v=20260612c';
import { renderWelfareTab } from './welfare-ui.js?v=20260612c';

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
// 매니저 staging 대기건(pending_changes) 의 메뉴별 분리 표시
// - 상단 배너: 메뉴별 요약 칩 (클릭 시 해당 탭 점프)
// - 탭 배지: 각 탭 버튼에 대기 수 빨간 배지
// - 탭 안 리스트: 현재 탭의 대기건만 "내가 승인할 항목" 으로 노출 + 행별 승인/반려
// admin 전용 (매니저는 제출자라 표시 안 함).
// =========================================================================================
const ENTITY_TO_TAB = {
    leave_request: 'leaveList', leave_approval: 'leaveList',
    leave_management: 'leaveManagement',
    document: 'submittedDocs', document_request: 'submittedDocs',
    employee: 'management', department: 'department',
    form_template: 'templates',
    welfare_record: 'welfare', welfare_fulfillment: 'welfare',
};
const ENTITY_LABEL = {
    employee: '직원', department: '부서', leave_management: '연차관리',
    leave_request: '연차', leave_approval: '연차결재',
    document: '서류', document_request: '서류요청', form_template: '서식',
    welfare_record: '복지', welfare_fulfillment: '복지이행',
};
const ACTION_LABEL = { create: '생성', update: '수정', delete: '삭제' };
// 상단 요약 칩 / 탭 전체승인 라벨 (탭 id 기준)
const TAB_SUMMARY_LABEL = {
    leaveList: '연차', leaveManagement: '연차관리', submittedDocs: '서류',
    management: '직원', department: '부서', templates: '서식', welfare: '복지',
};

let _pendingCache = [];
async function loadPendingCache() {
    _pendingCache = await loadPendingChanges();
    return _pendingCache;
}
function getPendingForTab(tabId) {
    return _pendingCache.filter(it => ENTITY_TO_TAB[it.entity_type] === tabId);
}
function isAdminView() {
    return !(state.userRole !== 'admin' && state.currentUser?.isManager);
}
// 승인/반려 후: 캐시 갱신 + 배너·탭·콘텐츠 재렌더 (외부에서도 호출 가능)
async function refreshPending() {
    if (!isAdminView()) return;
    await loadPendingCache();
    renderManagementTabs();
    renderManagementContent();
    renderApprovalBanner();
}

async function loadManagementData() {
    try {
        const monthStart = dayjs(state.schedule.currentDate).startOf('month').format('YYYY-MM-DD');
        const monthEnd = dayjs(state.schedule.currentDate).endOf('month').format('YYYY-MM-DD');

        const [requestsRes, employeesRes, templatesRes, docsRes, issuesRes, departmentsRes, docRequestsRes, settingsRes, schedulesRes, holidaysRes, noticeDaysRes, blockedDatesRes, settingsAdminRes, pendingLeaveRes] = await Promise.all([
            db.from('leave_requests').select('*').order('created_at', { ascending: false }),
            db.from('employees').select('*, departments(*)').order('id'),
            db.from('document_templates').select('*').order('created_at', { ascending: false }),
            db.from('submitted_documents').select('*').order('created_at', { ascending: false }),
            db.from('issues').select('*').order('created_at', { ascending: false }),
            db.from('departments').select('*').order('id'),
            db.from('document_requests').select('*').order('created_at', { ascending: false }),
            db.from('app_settings').select('value').eq('key', 'show_test_employees').maybeSingle(),
            db.from('schedules').select('*').gte('date', monthStart).lte('date', monthEnd),
            db.from('company_holidays').select('date').gte('date', monthStart).lte('date', monthEnd),
            db.from('app_settings').select('value').eq('key', 'leave_notice_days').maybeSingle(),
            db.from('app_settings').select('value').eq('key', 'leave_blocked_dates').maybeSingle(),
            db.from('app_settings').select('value').eq('key', 'show_test_employees_admin').maybeSingle(),
            db.from('pending_changes').select('*').eq('status', 'pending').eq('entity_type', 'leave_management').order('created_at', { ascending: true })
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
        state.management.pendingLeaveChanges = (pendingLeaveRes && !pendingLeaveRes.error) ? (pendingLeaveRes.data || []) : [];
        state.showTestEmployees = !!(settingsRes && settingsRes.data && settingsRes.data.value === true);
        // 최고관리자 본인 화면 토글: 저장된 값 없으면 기본 ON (현행 admin-항상-노출 동작 유지)
        state.showTestEmployeesAdmin = (settingsAdminRes && settingsAdminRes.data)
            ? settingsAdminRes.data.value === true
            : true;

        // 연차 신청 마감일수 (기본 7) — admin 설정
        const ndVal = noticeDaysRes && noticeDaysRes.data && noticeDaysRes.data.value;
        state.leaveNoticeDays = (ndVal != null && !isNaN(Number(ndVal))) ? Number(ndVal) : 7;

        // 연차 신청 불가일 목록 (jsonb 배열) — 스케줄 그리드에서 매니저가 지정
        const bdVal = blockedDatesRes && blockedDatesRes.data && blockedDatesRes.data.value;
        state.schedule.leaveBlockedDates = new Set(Array.isArray(bdVal) ? bdVal : []);

        // 보는 달 스케줄 미리 로드 (대시보드 평균 직원수/원장수 계산). 스케줄 탭 진입 시 populateMonthData 가 calendar-range 로 다시 채움.
        if (!schedulesRes.error) {
            state.schedule.schedules = (schedulesRes.data || []).map(r => ({
                ...r,
                is_annual_leave: r.is_annual_leave ?? false
            }));
        }
        // 보는 달 등록 휴일 로드 (대시보드 근무일수 계산용 — 일요일과 함께 제외)
        if (!holidaysRes.error) {
            state.schedule.companyHolidays = new Set((holidaysRes.data || []).map(h => h.date));
        }
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
        case 'welfare':
            renderWelfareTab(container);
            setTimeout(applyEditPermissionForManagerView, 100);
            break;
        default:
            container.innerHTML = `<p>${activeTab} 탭의 콘텐츠가 준비되지 않았습니다.</p>`;
    }
    renderTabPending();
}

// #admin-tabs 와 #admin-content 사이에 현재 탭의 staging 대기건 리스트를 노출.
// #admin-content 와 형제(별도 컨테이너)라 콘텐츠 innerHTML 교체에 영향받지 않음.
function renderTabPending() {
    const content = _('#admin-content');
    if (!content) return;
    let host = document.getElementById('tab-pending-container');
    if (!host) {
        host = document.createElement('div');
        host.id = 'tab-pending-container';
        content.parentNode.insertBefore(host, content);
        host.addEventListener('click', onPendingSectionClick);
    }
    host.innerHTML = isAdminView() ? renderTabPendingSection(state.management.activeTab) : '';
}

// 대상 직원명 해석: create 는 payload.employee_id, employee/leave_management update·delete 는 entity_id.
function pendingTargetName(it, empMap) {
    if (it.payload && it.payload.employee_id && empMap[it.payload.employee_id]) return empMap[it.payload.employee_id];
    if ((it.entity_type === 'employee' || it.entity_type === 'leave_management') && empMap[it.entity_id]) return empMap[it.entity_id];
    return '';
}

function renderTabPendingSection(tabId) {
    const items = getPendingForTab(tabId);
    if (!items.length) return '';
    const empMap = {};
    (state.management.employees || []).forEach(e => { empMap[e.id] = e.name; });

    const rows = items.map(it => {
        const creator = empMap[it.created_by] || `매니저 #${it.created_by}`;
        const time = dayjs(it.created_at).format('MM-DD HH:mm');
        const target = pendingTargetName(it, empMap);
        const summary = summarizeChange(it);
        const actCls = it.action === 'delete' ? 'bg-red-100 text-red-700'
            : it.action === 'create' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700';
        return `
            <div class="flex items-start gap-2 py-2 border-b border-yellow-200 last:border-b-0" data-pending-id="${it.id}">
                <span class="px-1.5 py-0.5 rounded text-xs shrink-0 ${actCls}">${ACTION_LABEL[it.action] || it.action}</span>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-semibold">${creator}${target ? ` <span class="text-gray-400">→</span> ${target}` : ''} <span class="text-gray-400 font-normal text-xs ml-1">${time}</span></div>
                    <div class="text-sm text-gray-700 whitespace-pre-wrap break-words">${summary}</div>
                </div>
                <div class="shrink-0 whitespace-nowrap">
                    <button data-pending-action="approve" data-id="${it.id}" class="px-2 py-1 bg-green-500 text-white text-xs rounded">✅ 승인</button>
                    <button data-pending-action="reject" data-id="${it.id}" class="px-2 py-1 bg-red-500 text-white text-xs rounded ml-1">❌ 반려</button>
                </div>
            </div>`;
    }).join('');

    return `
        <div class="mb-4 bg-yellow-50 border-2 border-yellow-400 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2 gap-2 flex-wrap">
                <p class="font-bold text-yellow-800">⏳ 내가 승인할 항목 (${items.length}건)</p>
                <div class="flex gap-2">
                    <button data-pending-action="approve-all-tab" data-tab="${tabId}" class="px-3 py-1 bg-green-600 text-white text-xs rounded font-bold">이 메뉴 전체 승인</button>
                    <button data-pending-action="reject-all-tab" data-tab="${tabId}" class="px-3 py-1 bg-red-600 text-white text-xs rounded">전체 반려</button>
                </div>
            </div>
            ${rows}
        </div>`;
}

async function onPendingSectionClick(e) {
    const btn = e.target.closest('button[data-pending-action]');
    if (!btn) return;
    const act = btn.dataset.pendingAction;

    if (act === 'approve') {
        if (!confirm('이 변경을 승인하여 실제 데이터에 반영하시겠습니까?')) return;
        const r = await approvePendingChange(parseInt(btn.dataset.id, 10));
        if (!r.ok) return alert('승인 실패: ' + r.error);
    } else if (act === 'reject') {
        const reason = prompt('반려 사유를 입력하세요:');
        if (!reason) return;
        const r = await rejectPendingChange(parseInt(btn.dataset.id, 10), reason);
        if (!r.ok) return alert('반려 실패: ' + r.error);
    } else if (act === 'approve-all-tab') {
        const tab = btn.dataset.tab;
        const list = getPendingForTab(tab);
        if (!list.length) return;
        if (!confirm(`${TAB_SUMMARY_LABEL[tab] || tab} 대기 ${list.length}건을 모두 승인하시겠습니까?\n실제 데이터에 즉시 반영됩니다.`)) return;
        let ok = 0, fail = 0; const errs = [];
        for (const it of list) {
            const r = await approvePendingChange(it.id);
            if (r.ok) ok++; else { fail++; errs.push(`#${it.id}: ${r.error}`); }
        }
        alert(`승인 ${ok}건 완료${fail ? `, ${fail}건 실패\n${errs.join('\n')}` : ''}`);
    } else if (act === 'reject-all-tab') {
        const tab = btn.dataset.tab;
        const list = getPendingForTab(tab);
        if (!list.length) return;
        const reason = prompt(`${TAB_SUMMARY_LABEL[tab] || tab} 대기 ${list.length}건을 모두 반려합니다.\n반려 사유를 입력하세요:`);
        if (!reason) return;
        let ok = 0, fail = 0;
        for (const it of list) {
            const r = await rejectPendingChange(it.id, reason);
            if (r.ok) ok++; else fail++;
        }
        alert(`반려 ${ok}건 완료${fail ? `, ${fail}건 실패` : ''}`);
    } else {
        return;
    }

    await window.loadAndRenderManagement?.();
    await refreshPending();
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
    welfare: 'welfare',
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
        { id: 'welfare', text: '복지' },
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

    container.innerHTML = tabs.map(tab => {
        const cnt = isManagerView ? 0 : getPendingForTab(tab.id).length;
        const badge = cnt
            ? ` <span class="ml-1 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 bg-red-500 text-white rounded-full text-xs align-middle">${cnt}</span>`
            : '';
        return `<button data-tab="${tab.id}" class="main-tab-btn px-3 py-2 text-sm ${tab.id === state.management.activeTab ? 'active' : ''}">${tab.text}${badge}</button>`;
    }).join('');
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
    // admin-summary 카드 영역은 관리자 포털 화면에만 존재. 직원 포털에서 schedule 탭이 데이터 갱신 시
    // window.refreshAdminSummary 가 호출되더라도 element 가 없으면 무해하게 skip.
    const summaryEl = _('#admin-summary');
    if (!summaryEl) return;

    const { employees, leaveRequests, departments } = state.management;
    const schedules = state.schedule.schedules || [];
    const holidays = state.schedule.companyHolidays || new Set();
    const currentDate = state.schedule.currentDate || dayjs().format('YYYY-MM-DD');
    const monthStr = dayjs(currentDate).format('YYYY-MM');
    const monthLabel = dayjs(currentDate).format('M월');

    // 보는 달 근무 행. 일요일과 등록된 공휴일·자체휴일은 무조건 제외 (주간 검수 로직과 동일 기준).
    // 잔존 일요일 데이터가 DB에 남아있어도 근무일수가 부풀려지지 않음.
    const workSchedules = schedules.filter(s => {
        if (typeof s.date !== 'string' || !s.date.startsWith(monthStr)) return false;
        if (s.status !== '근무' || s.is_annual_leave) return false;
        if (holidays.has(s.date)) return false;
        if (dayjs(s.date).day() === 0) return false; // 일요일 제외
        return true;
    });

    // 근무일수: 근무자가 1명 이상 있는 날의 distinct count
    const workDays = new Set(workSchedules.map(s => s.date)).size;

    // 부서명 매핑
    const deptIdToName = {};
    departments.forEach(d => { deptIdToName[d.id] = d.name; });
    const empIdToDeptName = {};
    employees.forEach(e => { empIdToDeptName[e.id] = deptIdToName[e.department_id] || ''; });

    // 부서별 근무 사람-일 수 합계 (기공실 제외)
    let staffCount = 0, doctorCount = 0;
    workSchedules.forEach(s => {
        const dept = empIdToDeptName[s.employee_id];
        if (dept === '진료실' || dept === '경영지원실') staffCount++;
        else if (dept === '원장') doctorCount++;
    });
    const avgStaff = workDays > 0 ? (staffCount / workDays).toFixed(1) : '0.0';
    const avgDoctor = workDays > 0 ? (doctorCount / workDays).toFixed(1) : '0.0';

    // 승인 대기
    const pending = leaveRequests.filter(r => r.status === 'pending').length;

    // 이달 연차 사용일수: 승인된 신청의 dates 중 보는 달 일수 (반차는 0.5일)
    let monthLeaveUsed = 0;
    leaveRequests.forEach(req => {
        if (req.status !== 'approved') return;
        const perDay = (req.leave_type === 'am_half' || req.leave_type === 'pm_half') ? 0.5 : 1;
        (req.dates || []).forEach(d => {
            if (typeof d === 'string' && d.startsWith(monthStr)) monthLeaveUsed += perDay;
        });
    });

    summaryEl.innerHTML = `
        <div class="dash-card"><p>${monthLabel} 근무일수</p><p class="text-xl font-bold">${workDays}일</p></div>
        <div class="dash-card"><p>평균 직원수</p><p class="text-xl font-bold">${avgStaff}명</p></div>
        <div class="dash-card dash-card-accent"><p>평균 원장수</p><p class="text-xl font-bold">${avgDoctor}명</p></div>
        <div class="dash-card dash-card-warn"><p>승인 대기</p><p class="text-xl font-bold">${pending}건</p></div>
        <div class="dash-card dash-card-dark"><p>${monthLabel} 연차 사용</p><p class="text-xl font-bold">${monthLeaveUsed}일</p></div>
    `;
}

// 다른 모듈(스케줄 탭 navigate 후 등)에서 호출 가능
window.refreshAdminSummary = renderAdminSummary;

async function renderAdminPortal() {
    const portal = _('#admin-portal');
    const isManagerView = state.userRole !== 'admin' && state.currentUser?.isManager;
    const title = isManagerView ? '매니저 화면' : '최고 관리자 포털';
    const backBtn = isManagerView
        ? `<button id="exitManagerViewBtn" class="px-3 py-1 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded transition-colors">← 직원 화면으로</button>`
        : '';

    // 테스트 직원 가시성 — 관리자/매니저 각각 독립 토글. admin 화면에서만 노출(둘 다 관리자가 설정).
    const testToggle = !isManagerView
        ? `<div class="px-3 py-1 text-xs bg-yellow-50 border border-yellow-300 rounded flex items-center gap-2">
              <span class="font-semibold">테스트 직원 보기</span>
              <label class="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" id="testEmpToggleAdmin" ${state.showTestEmployeesAdmin ? 'checked' : ''}><span>관리자</span>
              </label>
              <label class="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" id="testEmpToggle" ${state.showTestEmployees ? 'checked' : ''}><span>매니저</span>
              </label>
           </div>`
        : '';

    portal.innerHTML = `
        <div class="max-w-full mx-auto">
             <div class="flex justify-between items-center mb-4">
                <h1 class="text-3xl font-bold">${title}</h1>
                <div class="text-right">
                    <p id="admin-welcome-msg" class="text-gray-700 text-sm font-semibold">${state.currentUser.name}님${isManagerView ? '' : ', 환영합니다.'}</p>
                    <div class="mt-1 flex gap-2 justify-end flex-wrap items-center">
                        ${testToggle}
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
    // 테스트 직원 토글 공통 핸들러 — app_settings 키에 upsert + 재조회 검증, 실패 시 원복.
    // applyState(next): state 에 반영, 반환값은 직전 값(원복용).
    const bindTestToggle = (selector, key, applyState) => {
        _(selector)?.addEventListener('change', async (e) => {
            const next = !!e.target.checked;
            const prev = applyState(next);
            try {
                // upsert 로 변경 — UPDATE 실패(키 없음/RLS) 시 즉시 가시화
                const { data, error } = await db.from('app_settings')
                    .upsert({ key, value: next, updated_at: new Date().toISOString() }, { onConflict: 'key' })
                    .select();
                if (error) throw error;
                if (!data || data.length === 0) {
                    throw new Error('UPDATE 가 0 행에 영향 — RLS 또는 키 미존재 의심');
                }
                // 영속화 확인 — 즉시 재조회로 더블 체크
                const { data: verify, error: verr } = await db.from('app_settings')
                    .select('value').eq('key', key).maybeSingle();
                if (verr) throw verr;
                if (!verify || verify.value !== next) {
                    throw new Error(`저장 후 재조회 값 불일치 — 기대 ${next}, 실제 ${verify?.value}`);
                }
            } catch (err) {
                console.error('app_settings update 실패:', err);
                alert('설정 저장 실패: ' + (err.message || err) + '\n콘솔 확인 후 다시 시도해주세요.');
                // 토글 상태 원복
                applyState(prev);
                e.target.checked = prev;
                return;
            }
            renderManagementContent();
        });
    };
    // 매니저 화면 노출 토글
    bindTestToggle('#testEmpToggle', 'show_test_employees', (v) => {
        const prev = state.showTestEmployees;
        state.showTestEmployees = v;
        return prev;
    });
    // 관리자 본인 화면 노출 토글
    bindTestToggle('#testEmpToggleAdmin', 'show_test_employees_admin', (v) => {
        const prev = state.showTestEmployeesAdmin;
        state.showTestEmployeesAdmin = v;
        return prev;
    });
    portal.addEventListener('click', (e) => {
        if (e.target.id === 'open-bulk-register-btn') {
            _('#bulk-employee-data').value = '';
            _('#bulk-register-result').innerHTML = '';
            show('#bulk-register-modal');
        }
    });

    await loadManagementData();
    if (!isManagerView) await loadPendingCache();
    renderAdminSummary();
    renderManagementTabs();
    renderManagementContent();
    if (!isManagerView) renderApprovalBanner();
}

// =========================================================================================
// 매니저 임시저장 승인 배너 (관리자 포털 상단)
// =========================================================================================
// 상단 배너: 메뉴별 요약 칩(클릭 시 탭 점프) + 전체 승인/반려. _pendingCache 동기 참조.
function renderApprovalBanner() {
    const container = _('#approval-banner-container');
    if (!container) return;

    const items = _pendingCache;
    if (!items.length) {
        container.innerHTML = '';
        return;
    }

    const byTab = {};
    items.forEach(it => {
        const tab = ENTITY_TO_TAB[it.entity_type] || 'management';
        byTab[tab] = (byTab[tab] || 0) + 1;
    });
    const chips = Object.keys(byTab).map(tab =>
        `<button data-jump-tab="${tab}" class="px-2.5 py-1 bg-white border border-yellow-400 rounded text-sm text-yellow-800 hover:bg-yellow-100">${TAB_SUMMARY_LABEL[tab] || tab} <b>${byTab[tab]}</b></button>`
    ).join('');

    container.innerHTML = `
        <div class="mb-4 bg-yellow-50 border-2 border-yellow-400 rounded-lg p-4 flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-3 flex-wrap">
                <span class="text-2xl">⏳</span>
                <span class="font-bold text-yellow-800">승인 대기 ${items.length}건</span>
                <div class="flex gap-2 flex-wrap">${chips}</div>
            </div>
            <div class="flex gap-2">
                <button id="approve-all-pending-btn" class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-bold">전체 승인</button>
                <button id="reject-all-pending-btn" class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">전체 반려</button>
            </div>
        </div>
    `;

    container.querySelectorAll('[data-jump-tab]').forEach(btn => {
        btn.onclick = () => {
            state.management.activeTab = btn.dataset.jumpTab;
            renderManagementTabs();
            renderManagementContent();
            renderAdminSummary();
        };
    });

    _('#approve-all-pending-btn').onclick = async () => {
        if (!confirm(`임시저장된 ${items.length}건을 모두 승인하시겠습니까?\n실제 데이터에 즉시 반영됩니다.`)) return;
        const r = await approveAllPending();
        let msg = `승인 ${r.success}건 완료`;
        if (r.failed) msg += `, ${r.failed}건 실패\n${r.errors.join('\n')}`;
        alert(msg);
        await window.loadAndRenderManagement?.();
        await refreshPending();
    };

    _('#reject-all-pending-btn').onclick = async () => {
        const reason = prompt(`임시저장된 ${items.length}건을 모두 반려합니다.\n반려 사유를 입력하세요:`);
        if (!reason) return;
        const r = await rejectAllPending(reason);
        alert(`반려 ${r.success}건 완료${r.failed ? `, ${r.failed}건 실패` : ''}`);
        await refreshPending();
    };
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

const LEAVE_TYPE_LABEL = { full: '종일', am_half: '오전반차', pm_half: '오후반차' };

// 연차 수동등록·삭제(leave_request) 를 사람말로. dates → M/D, leave_type → 한글,
// reason 의 [TARGET_PERIOD: YYYY-MM-DD] 는 'YYYY-MM 차감' 으로 분리.
function formatLeaveRequest(item) {
    const p = item.payload || {};
    const dates = Array.isArray(p.dates)
        ? p.dates.map(d => (dayjs(d).isValid() ? dayjs(d).format('M/D') : d)).join(', ')
        : '';
    const typeLabel = LEAVE_TYPE_LABEL[p.leave_type] || (p.leave_type || '');
    let reason = p.reason || '';
    let period = '';
    const m = reason.match(/\[TARGET_PERIOD:\s*([0-9-]+)\]/);
    if (m) { period = m[1].slice(0, 7); reason = reason.replace(m[0], '').trim(); }
    const verb = item.action === 'delete' ? '취소' : item.action === 'update' ? '변경' : '추가';
    const head = [dates, typeLabel].filter(Boolean).join(' ');
    const parts = [];
    parts.push(`${head} ${verb}`.trim());
    if (period) parts.push(`${period} 차감`);
    if (reason) parts.push(reason);
    return parts.join(' · ');
}

// 매니저 [중간 승인]/[중간 반려] → admin 결재 대상(leave_approval).
function formatLeaveApproval(item) {
    const p = item.payload || {};
    if (p.decision === 'approved') return '연차신청 승인';
    if (p.decision === 'rejected') return '연차신청 반려' + (p.reason ? ` · 사유: ${p.reason}` : '');
    return '연차신청 결재';
}

function summarizeChange(item) {
    if (!item.payload) return '-';
    // 연차 관리 변경은 한글 diff 로 (formatLeaveChange 공유)
    if (item.entity_type === 'leave_management') {
        const empMap = {};
        (state.management.employees || []).forEach(e => { empMap[e.id] = e.name; });
        const who = empMap[item.entity_id] ? `[${empMap[item.entity_id]}] ` : '';
        return who + formatLeaveChange(item).join('\n');
    }
    if (item.entity_type === 'leave_request') return formatLeaveRequest(item);
    if (item.entity_type === 'leave_approval') return formatLeaveApproval(item);

    const keys = Object.keys(item.payload).slice(0, 6);
    return keys.map(k => {
        const v = item.payload[k];
        const s = (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
        return `${k}: ${s.length > 40 ? s.slice(0, 40) + '…' : s}`;
    }).join(' / ');
}

// 다른 모듈(staging 승인 후, 매니저 페이지 등)에서 호출 가능 — 캐시 갱신 + 배너·탭·콘텐츠 재렌더
window.refreshApprovalBanner = refreshPending;
window.refreshPendingUI = refreshPending;

const handleManagementTabClick = (e) => {
    if (e.target.matches('.main-tab-btn')) {
        state.management.activeTab = e.target.dataset.tab;
        renderManagementTabs();
        renderManagementContent();
        renderAdminSummary();
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

// 모듈 로드 시점(뷰포트 메타 변경 전)의 실제 기기 폭 캡처 — 이후 width=1280 강제로
// innerWidth 가 바뀌어도 불변. 좁은 기기(모바일/태블릿) 판별 단일 기준.
const IS_SMALL_DEVICE = window.innerWidth < 1024;

// #admin-portal(데스크톱 전용)을 좁은 기기에서 띄울 때만 PC 폭(1280) 강제 → 축소된 데스크톱 뷰.
// 그 외(모바일 전용 페이지·직원포털·로그인·실제 PC)는 반응형 device-width.
function applyViewport(mode) {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    meta.setAttribute('content', mode === 'desktop' ? 'width=1280' : 'width=device-width, initial-scale=1.0');
}

function render() {
    _all('.page-section').forEach(el => el.classList.add('hidden'));

    // body 배경 클래스 — 페르소나 인지용
    document.body.classList.remove('mode-employee', 'mode-admin');

    const user = state.currentUser;
    const isManager = !!(user && user.isManager);
    const viewAs = state.viewAs || 'employee';
    let viewportMode = 'responsive';

    if (state.userRole === 'admin') {
        document.body.classList.add('mode-admin');
        if (IS_SMALL_DEVICE) {
            // 원장(최고관리자) 모바일 → 전용 조회 페이지 (읽기전용, 반응형)
            show('#mobile-admin-portal');
            renderMobileAdminPortal();
        } else {
            show('#admin-portal');
            renderAdminPortal();
        }
    } else if (state.userRole === 'employee' && isManager && viewAs === 'admin') {
        // 매니저가 매니저 화면 진입 → admin-portal 재사용 + perm 필터.
        // 매니저 화면은 데스크톱 전용이라 모바일이면 PC 레이아웃(1280) 강제 = 축소뷰(핀치줌 가능).
        document.body.classList.add('mode-admin');
        show('#admin-portal');
        renderAdminPortal();
        if (IS_SMALL_DEVICE) viewportMode = 'desktop';
    } else if (state.userRole === 'employee') {
        document.body.classList.add('mode-employee');
        show('#employee-portal');
        renderEmployeePortal();
    } else {
        show('#login-screen');
    }

    applyViewport(viewportMode);
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
        // 비번 평문 비교 폐기 → 서버 RPC(해시 비교, password 제외 반환). 2026-06-05
        const { data: employee, error } = await db.rpc('employee_login', {
            p_name: name,
            p_password: password
        });

        if (error || !employee) {
            if (error) console.error('로그인 RPC 오류:', error);
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

async function handleForgotPassword() {
    const rawName = prompt("등록된 이름을 입력해주세요:\n(임시 비밀번호를 등록된 이메일로 발송합니다)");
    if (rawName === null) return;
    const name = rawName.trim();
    if (!name) {
        alert("이름을 입력해주세요.");
        return;
    }

    const btn = _('#forgotPasswordBtn');
    if (btn) { btn.disabled = true; btn.textContent = '발송 중...'; }

    try {
        const url = `${db.supabaseUrl}/functions/v1/send-password-reset`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'apikey': db.supabaseKey,
                'Authorization': `Bearer ${db.supabaseKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name }),
        });
        const data = await resp.json().catch(() => ({}));

        if (resp.ok && data.success) {
            alert(`임시 비밀번호를 발송했습니다.\n\n등록된 이메일: ${data.masked_email}\n\n메일을 확인 후 임시 비밀번호로 로그인하시고,\n[비밀번호 변경] 버튼으로 본인 비밀번호로 바꿔주세요.`);
        } else {
            alert(data.error || `오류가 발생했습니다 (${resp.status}). 잠시 후 다시 시도해주세요.`);
        }
    } catch (e) {
        console.error('비번 분실 발송 오류:', e);
        alert("네트워크 오류. 잠시 후 다시 시도해주세요.");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '비밀번호 잊으셨나요?'; }
    }
}

function main() {
    _('#employeeLoginForm').addEventListener('submit', handleEmployeeLogin);
    _('#adminLoginForm').addEventListener('submit', handleAdminLogin);
    _('#goToOwnerLoginBtn').addEventListener('click', () => { hide('#employeeLoginContainer'); show('#ownerLoginContainer'); });
    _('#goToEmployeeLoginBtn').addEventListener('click', () => { show('#employeeLoginContainer'); hide('#ownerLoginContainer'); });
    _('#forgotPasswordBtn')?.addEventListener('click', handleForgotPassword);
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
