// =========================================================================================
// 원장(최고관리자) 전용 — 모바일 조회 페이지 (READ-ONLY)
//   PC 의 #admin-portal 은 데스크톱 전용이라 모바일에서 깨짐. 원장은 로그인 즉시 관리자 화면이라
//   모바일에서 전혀 못 보던 문제를 해결하기 위한 "조회 전용" 모바일 대시보드.
//   - 모든 변경(승인/반려/편집/확정)은 PC 에서만. 이 페이지는 보기만.
//   - 4탭: 스케줄 조회 / 연차 승인 대기 / 연차 목록·현황 / 복지 현황
//   - 기존 읽기전용 렌더를 최대한 재사용 (짜집기 회피).
// =========================================================================================
import { state, db, isVisibleIn } from './state.js?v=20260610i';
import { _ } from './utils.js';
import { buildLeaveMonthSectionsHTML } from './management.js?v=20260610i';
import { renderEmployeeMobileScheduleList } from './employee-portal-final.js?v=20260610i';
import { getLeaveDetails, isLeaveInPeriod } from './leave-utils.js?v=20260610i';
import { loadConfig, loadAllRecords, computeRemaining, elapsedMonthList, formatNum } from './welfare.js';

const TABS = [
    { id: 'schedule', label: '📅 스케줄' },
    { id: 'pending', label: '⏳ 승인 대기' },
    { id: 'leave', label: '📋 연차 목록·현황' },
    { id: 'welfare', label: '💙 복지' },
];

export async function renderMobileAdminPortal() {
    const root = _('#mobile-admin-portal');
    if (!root) return;
    state.mobileAdmin = state.mobileAdmin || { activeTab: 'schedule' };

    const userName = state.currentUser?.name || '원장';
    root.innerHTML = `
        <div class="min-h-screen bg-gray-50">
            <header style="background:#1a1a1a;color:#fff;" class="px-3 py-3 flex items-center justify-between gap-2 flex-nowrap sticky top-0 z-20 shadow">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="ma-title font-bold">👑 ${userName}</span>
                    <span class="ma-badge px-2 py-0.5 rounded-full" style="background:#b8860b;color:#fff;">모바일 조회</span>
                </div>
                <button id="ma-logout" class="ma-logout rounded border border-gray-500 text-gray-200 hover:bg-gray-700">로그아웃</button>
            </header>

            <nav id="ma-tabs" class="flex flex-nowrap bg-white border-b sticky z-10 shadow-sm" style="top:48px;">
                ${TABS.map(t => `
                    <button data-ma-tab="${t.id}" class="ma-tab transition-colors"
                            style="${t.id === state.mobileAdmin.activeTab ? 'border-color:#b8860b;color:#b8860b;' : 'border-color:transparent;color:#6b7280;'}">
                        ${t.label}
                    </button>`).join('')}
            </nav>

            <main id="ma-content" class="p-3"></main>

            <div class="ma-fs-xs text-center text-gray-400 py-4">조회 전용 화면입니다. 승인·편집은 PC에서 하세요.</div>
        </div>
    `;

    root.querySelector('#ma-logout')?.addEventListener('click', async () => {
        try { await db.auth.signOut(); } catch (e) { /* noop */ }
        sessionStorage.removeItem('viewAs');
        location.reload();
    });

    root.querySelectorAll('.ma-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            state.mobileAdmin.activeTab = btn.dataset.maTab;
            renderMobileAdminPortal();
        });
    });

    await renderActiveTab();
}

async function renderActiveTab() {
    const content = _('#ma-content');
    if (!content) return;
    content.innerHTML = `<div class="flex justify-center items-center py-16"><div class="animate-spin rounded-full h-8 w-8 border-b-2" style="border-color:#b8860b;"></div></div>`;
    try {
        switch (state.mobileAdmin.activeTab) {
            case 'schedule': return await renderScheduleTab(content);
            case 'pending': return await renderPendingTab(content);
            case 'leave': return await renderLeaveTab(content);
            case 'welfare': return await renderWelfareTab(content);
        }
    } catch (err) {
        console.error('모바일 관리자 탭 렌더 오류:', err);
        content.innerHTML = `<div class="p-4 text-center text-red-600 text-sm"><p class="font-bold">불러오지 못했습니다.</p><p class="mt-1">${err.message}</p></div>`;
    }
}

// 연차 탭이 쓸 직원·신청 데이터 적재 (스케줄 탭이 employees 를 부서조인 없이 덮어쓰므로 매번 보장)
async function ensureLeaveData() {
    state.management = state.management || {};
    const [empRes, leaveRes, deptRes] = await Promise.all([
        db.from('employees').select('*, departments(*)').order('id'),
        db.from('leave_requests').select('*').order('created_at', { ascending: false }),
        db.from('departments').select('*').order('id'),
    ]);
    if (empRes.error) throw empRes.error;
    if (leaveRes.error) throw leaveRes.error;
    state.management.employees = (empRes.data || []).map(e => ({ ...e, entryDate: e.entryDate || e.entry_date }));
    state.management.leaveRequests = leaveRes.data || [];
    state.management.departments = deptRes.data || [];
}

// ── 탭 1) 스케줄 조회 — 직원포털 모바일 주간뷰 재사용 (확정 게이트 우회: 원장은 작성중인 달도 봄) ──
async function renderScheduleTab(content) {
    content.innerHTML = `<div id="ma-schedule"></div>`;
    await renderEmployeeMobileScheduleList({ selector: '#ma-schedule', bypassConfirm: true });
}

// ── 탭 2) 연차 승인 대기 (최종 미처리 = pending) — 목록만, 액션 없음 ──
async function renderPendingTab(content) {
    await ensureLeaveData();
    const { employees, leaveRequests } = state.management;
    const nameMap = {};
    employees.forEach(emp => {
        if (!isVisibleIn('leave_review', emp)) return;
        nameMap[emp.id] = emp.name + (emp.resignation_date ? ' (퇴사)' : '');
    });

    // 각 신청을 (그 신청의 첫 날짜) 기준 오름차순 — 가까운 일정부터
    const pending = leaveRequests
        .filter(r => nameMap[r.employee_id] && ((r.final_manager_status || 'pending') === 'pending'))
        .map(r => {
            const dates = [...(r.dates || [])].sort();
            return { r, dates, first: dates[0] || '9999' };
        })
        .sort((a, b) => a.first.localeCompare(b.first));

    if (pending.length === 0) {
        content.innerHTML = `<div class="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm">✅ 승인 대기 중인 연차가 없습니다.</div>`;
        return;
    }

    const rows = pending.map(({ r, dates }) => {
        const middle = r.middle_manager_status;
        const middleTag = middle === 'approved'
            ? '<span class="ma-fs-xs text-green-600">매니저 승인</span>'
            : middle === 'rejected'
                ? '<span class="ma-fs-xs text-red-500">매니저 반려</span>'
                : '<span class="ma-fs-xs text-gray-400">매니저 대기</span>';
        const datesText = dates.map(d => `${parseInt(d.substring(5, 7), 10)}/${parseInt(d.substring(8, 10), 10)}`).join(', ');
        const isHalf = r.leave_type === 'am_half' || r.leave_type === 'pm_half';
        const dayCount = dates.length * (isHalf ? 0.5 : 1); // 반차는 0.5일
        const halfLabel = r.leave_type === 'am_half' ? ' · 오전반차' : r.leave_type === 'pm_half' ? ' · 오후반차' : '';
        return `
            <div class="bg-white rounded-lg border p-3 flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <div class="ma-fs-sm font-semibold">${nameMap[r.employee_id]}</div>
                    <div class="ma-fs-xs text-gray-600 mt-0.5">${datesText} <span class="text-gray-400">(${dayCount}일${halfLabel})</span></div>
                    <div class="mt-1">${middleTag}</div>
                </div>
                <span class="ma-fs-xs px-2 py-1 rounded-full ma-nowrap" style="background:#fef3c7;color:#b45309;">대기</span>
            </div>`;
    }).join('');

    content.innerHTML = `
        <div class="mb-2 ma-fs-xs text-gray-500">최종 승인 대기 <b style="color:#b8860b;">${pending.length}</b>건</div>
        <div class="space-y-2">${rows}</div>`;
}

// ── 탭 3) 연차 목록·현황 — 직원별 잔여 요약 + 월별 신청 목록(읽기전용) ──
async function renderLeaveTab(content) {
    await ensureLeaveData();
    const { employees, leaveRequests } = state.management;

    // 직원별 잔여 현황 (현재 주기 기준)
    const statusRows = employees
        .filter(emp => isVisibleIn('leave_review', emp) && !emp.resignation_date)
        .map(emp => {
            const d = getLeaveDetails(emp);
            const pStart = d.periodStart, pEnd = d.periodEnd;
            const used = leaveRequests
                .filter(r => r.employee_id === emp.id && r.status === 'approved')
                .reduce((sum, r) => {
                    const perDay = (r.leave_type === 'am_half' || r.leave_type === 'pm_half') ? 0.5 : 1; // 반차 0.5일
                    return sum + (r.dates || []).filter(ds => isLeaveInPeriod(r, ds, pStart, pEnd)).length * perDay;
                }, 0);
            const remaining = d.final - used;
            return { name: emp.name, dept: emp.departments?.name || emp.dept || '-', final: d.final, used, remaining };
        })
        .sort((a, b) => (a.dept || '').localeCompare(b.dept || '') || a.name.localeCompare(b.name));

    const statusTable = `
        <div class="bg-white rounded-lg border overflow-hidden mb-4">
            <div class="px-3 py-2 bg-gray-50 border-b ma-fs-sm font-semibold">직원별 잔여 연차 (현재 주기)</div>
            <table class="min-w-full">
                <thead class="bg-gray-50 text-gray-500">
                    <tr><th class="py-1.5 px-2 text-left">직원</th><th class="py-1.5 px-2 text-left">부서</th>
                        <th class="py-1.5 px-2 text-center">확정</th><th class="py-1.5 px-2 text-center">사용</th>
                        <th class="py-1.5 px-2 text-center">잔여</th></tr>
                </thead>
                <tbody>
                    ${statusRows.map(s => `
                        <tr class="border-b last:border-0">
                            <td class="py-1.5 px-2 font-medium">${s.name}</td>
                            <td class="py-1.5 px-2 text-gray-500">${s.dept}</td>
                            <td class="py-1.5 px-2 text-center">${s.final}</td>
                            <td class="py-1.5 px-2 text-center">${s.used}</td>
                            <td class="py-1.5 px-2 text-center font-bold ${s.remaining <= 0 ? 'text-red-600' : ''}" style="${s.remaining > 0 ? 'color:#b8860b;' : ''}">${s.remaining}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;

    const thisMonth = dayjs().format('YYYY-MM');
    const listHTML = buildLeaveMonthSectionsHTML(thisMonth, true);

    content.innerHTML = statusTable + `<div class="ma-fs-sm font-semibold mb-2 px-1">연차 신청 목록</div>` + listHTML;
}

// ── 탭 4) 복지 현황 — 진료비 복지 진행 목록 (읽기전용) ──
async function renderWelfareTab(content) {
    const [cfg, records] = await Promise.all([loadConfig(), loadAllRecords()]);
    const ids = records.map(r => r.id);
    let fulfillByRec = {};
    if (ids.length) {
        const { data } = await db.from('welfare_monthly_fulfillment').select('*').in('record_id', ids);
        (data || []).forEach(f => { (fulfillByRec[f.record_id] ??= []).push(f); });
    }

    // 진행중 우선, 정산완료는 뒤로
    const ordered = [...records].sort((a, b) => {
        const ax = a.status === 'Settled' ? 1 : 0, bx = b.status === 'Settled' ? 1 : 0;
        if (ax !== bx) return ax - bx;
        return dayjs(b.created_at).valueOf() - dayjs(a.created_at).valueOf();
    });

    if (ordered.length === 0) {
        content.innerHTML = `<div class="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm">등록된 복지 기록이 없습니다.</div>`;
        return;
    }

    const cards = ordered.map(r => {
        const fulfills = fulfillByRec[r.id] || [];
        const { remaining, fulfilledMonths } = computeRemaining(r, fulfills, cfg);
        const possible = elapsedMonthList(r.start_date).length;
        const badge = r.status === 'Settled'
            ? '<span class="px-2 py-0.5 rounded text-white ma-fs-xs ma-nowrap" style="background:#6b7280;">정산완료</span>'
            : '<span class="px-2 py-0.5 rounded text-white ma-fs-xs ma-nowrap" style="background:#16a34a;">진행중</span>';
        return `
            <div class="bg-white rounded-lg border p-3 ${r.status === 'Settled' ? 'opacity-60' : ''}">
                <div class="flex items-center justify-between gap-2">
                    <span class="ma-fs-sm font-semibold truncate">${r.employee?.name || '-'}</span>
                    ${badge}
                </div>
                <div class="ma-fs-xs text-gray-600 mt-1">${r.relation_type}${r.patient_name ? ' (' + r.patient_name + ')' : ''} · ${r.treatment_details || '-'}</div>
                <div class="flex justify-between gap-1 ma-fs-xs mt-2 pt-2 border-t">
                    <span class="text-gray-500 ma-nowrap">총 진료비 <b class="text-gray-700">${formatNum(r.total_fee)}</b></span>
                    <span class="text-gray-500 ma-nowrap">잔여 <b style="color:#b8860b;">${formatNum(remaining)}</b></span>
                    <span class="text-gray-500 ma-nowrap">이행 <b class="text-gray-700">${fulfilledMonths}/${possible}</b></span>
                </div>
            </div>`;
    }).join('');

    content.innerHTML = `<div class="space-y-2">${cards}</div>`;
}
