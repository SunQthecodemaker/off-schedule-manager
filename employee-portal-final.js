import { state, db } from './state.js';
import { _, show, hide, resizeGivenCanvas } from './utils.js';
import { getLeaveDetails } from './leave-utils.js';
import { renderScheduleManagement } from './schedule.js';
import { getLeaveListHTML } from './management.js';

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
    } else if (user.entryDate) {
        const today = dayjs();
        const entryAnniversaryThisYear = dayjs(user.entryDate).year(today.year());
        const nextAnniversary = today.isAfter(entryAnniversaryThisYear)
            ? entryAnniversaryThisYear.add(1, 'year')
            : entryAnniversaryThisYear;
        renewalDateText = nextAnniversary.format('YYYY-MM-DD');
        renewalDateShort = nextAnniversary.format('YY-MM-DD');
    }

    portal.innerHTML = `
        <div class="max-w-full mx-auto">
            <div class="flex justify-between items-center mb-6">
                <h1 class="text-3xl font-bold">${user.isManager ? '매니저 포털' : '직원 포털'}</h1>
                <div class="text-right">
                    <p class="text-gray-700 text-sm font-semibold">${user.name}님 (${departmentName})</p>
                    <div class="mt-1 flex gap-2 justify-end">
                        <button id="changePasswordBtn" class="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded transition-colors">비밀번호 변경</button>
                        <button id="employeeLogoutBtn" class="px-3 py-1 text-sm bg-gray-300 hover:bg-gray-400 rounded transition-colors">로그아웃</button>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-4 gap-2 sm:gap-4 mb-6">
                <div class="bg-blue-100 p-2 sm:p-4 rounded shadow flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-sm text-gray-700 whitespace-nowrap">확정 연차</p>
                    <p class="text-xl sm:text-2xl font-bold">${leaveDetails.final}일</p>
                </div>
                <div class="bg-green-100 p-2 sm:p-4 rounded shadow flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-sm text-gray-700 whitespace-nowrap">사용 연차</p>
                    <p class="text-xl sm:text-2xl font-bold" id="used-leaves">계산 중...</p>
                </div>
                <div class="bg-yellow-100 p-2 sm:p-4 rounded shadow flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-sm text-gray-700 whitespace-nowrap">잔여 연차</p>
                    <p class="text-xl sm:text-2xl font-bold" id="remaining-leaves">계산 중...</p>
                </div>
                <div class="bg-purple-100 p-2 sm:p-4 rounded shadow flex flex-col items-center justify-center text-center">
                    <p class="text-[10px] sm:text-sm text-gray-700 font-semibold whitespace-nowrap">갱신일</p>
                    <p class="text-xl sm:text-2xl font-medium whitespace-nowrap">${renewalDateShort || renewalDateText}</p>
                </div>
            </div>

            <!-- 탭 버튼 -->
            <div class="flex border-b mb-4 overflow-x-auto whitespace-nowrap">
                <button id="tab-leave-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-blue-600 text-blue-600">연차 신청</button>
                <button id="tab-docs-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700 relative">
                    서류 제출
                    <span id="doc-tab-badge" class="hidden absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">0</span>
                </button>
                <button id="tab-work-schedule-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700">
                    📅 근무 스케줄
                </button>
                ${user.isManager ? `
                    <button id="tab-leave-list-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700">연차 신청 목록 (매니저)</button>
                    <button id="tab-schedule-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700">스케줄 관리 (매니저)</button>
                ` : ''}
            </div>

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
            <div id="employee-work-schedule-tab" class="tab-content hidden h-[800px] bg-white shadow rounded p-4">
                <!-- 여기에 모바일 친화적 스케줄 리스트가 렌더링됩니다 -->
            </div>

            ${user.isManager ? `
                <div id="employee-leave-list-tab" class="tab-content hidden"></div>
                <div id="employee-schedule-tab" class="tab-content hidden"></div>
            ` : ''}
        </div>
    `;

    _('#employeeLogoutBtn').addEventListener('click', async () => {
        sessionStorage.clear();
        window.location.reload();
    });

    _('#changePasswordBtn')?.addEventListener('click', handleChangePassword);

    _('#tab-leave-btn').addEventListener('click', () => switchEmployeeTab('leave'));
    _('#tab-docs-btn').addEventListener('click', () => switchEmployeeTab('docs'));
    _('#tab-work-schedule-btn').addEventListener('click', () => switchEmployeeTab('workSchedule'));

    if (user.isManager) {
        _('#tab-leave-list-btn')?.addEventListener('click', () => switchEmployeeTab('leaveList'));
        _('#tab-schedule-btn')?.addEventListener('click', () => switchEmployeeTab('schedule'));
    }

    await loadEmployeeData();
}

async function handleChangePassword() {
    const currentPass = prompt("현재 비밀번호를 입력해주세요:");
    if (currentPass === null) return;

    if (currentPass !== state.currentUser.password) {
        alert("현재 비밀번호가 일치하지 않습니다.");
        return;
    }

    const newPass = prompt("새로운 비밀번호를 입력해주세요:");
    if (newPass === null) return;

    if (!newPass.trim()) {
        alert("비밀번호는 공백일 수 없습니다.");
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

function switchEmployeeTab(tab) {
    state.employee.activeTab = tab;

    // 모든 탭 버튼과 컨텐츠 숨기기/비활성화 처리
    const tabs = {
        'leave': { btn: '#tab-leave-btn', content: '#employee-leave-tab' },
        'docs': { btn: '#tab-docs-btn', content: '#employee-docs-tab' },
        'workSchedule': { btn: '#tab-work-schedule-btn', content: '#employee-work-schedule-tab' },
        'leaveList': { btn: '#tab-leave-list-btn', content: '#employee-leave-list-tab' },
        'schedule': { btn: '#tab-schedule-btn', content: '#employee-schedule-tab' }
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
    } else if (tab === 'schedule') {
        renderManagerScheduleTab();
    } else if (tab === 'workSchedule') {
        renderEmployeeMobileScheduleList();
    }
}

// =========================================================================================
// [신규] 모바일 친화적 근무 스케줄 리스트 뷰 (주간 뷰 & 확정 확인)
// =========================================================================================

async function renderEmployeeMobileScheduleList() {
    const container = _('#employee-work-schedule-tab');
    if (!container) return;

    container.innerHTML = '<div class="flex justify-center items-center h-48"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>';

    try {
        if (!state.employee.scheduleViewDate) {
            state.employee.scheduleViewDate = dayjs().format('YYYY-MM-DD');
        }

        const currentDate = dayjs(state.employee.scheduleViewDate);

        // 주 시작일 계산 (월요일 기준)
        const dayNum = currentDate.day(); // 0(일) ~ 6(토)
        const diffToMon = dayNum === 0 ? -6 : 1 - dayNum;
        const startOfWeek = currentDate.add(diffToMon, 'day');
        const endOfWeek = startOfWeek.add(6, 'day');

        const startStr = startOfWeek.format('YYYY-MM-DD');
        const endStr = endOfWeek.format('YYYY-MM-DD');
        const monthQueryDate = dayjs(endStr).date() < 7 ? startOfWeek : currentDate;
        // 주의: 월이 걸쳐있는 주간의 경우, 확정 여부를 어느 달 기준으로 할지가 모호함.
        // 여기서는 "이번 주의 시작일이 속한 달"을 기준으로 하거나 "현재 보고있는 날짜가 속한 달"을 기준으로 함.
        // 가장 안전한건 startOfWeek 기준 월
        const monthStr = startOfWeek.format('YYYY-MM');

        // 1. 스케줄 확정 여부 확인
        const { data: confirmData, error: confirmError } = await db.from('schedule_confirmations')
            .select('*')
            .eq('month', monthStr)
            .single();

        if (confirmError && confirmError.code !== 'PGRST116') throw confirmError;

        const isConfirmed = confirmData && confirmData.is_confirmed;

        if (!isConfirmed) {
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

            container.querySelector('#prev-week-btn').addEventListener('click', () => {
                state.employee.scheduleViewDate = currentDate.subtract(1, 'week').format('YYYY-MM-DD');
                renderEmployeeMobileScheduleList();
            });
            container.querySelector('#next-week-btn').addEventListener('click', () => {
                state.employee.scheduleViewDate = currentDate.add(1, 'week').format('YYYY-MM-DD');
                renderEmployeeMobileScheduleList();
            });
            return;
        }

        // 2. 스케줄 데이터 가져오기
        const { data: schedules, error: scheduleError } = await db.from('schedules')
            .select(`
                *,
                employees (id, name, department_id, departments(id, name))
            `)
            .gte('date', startStr)
            .lte('date', endStr)
            .eq('status', '근무')
            .order('sort_order', { ascending: true });

        if (scheduleError) throw scheduleError;

        // 3. 휴무일 데이터 가져오기
        const { data: holidays, error: holidayError } = await db.from('company_holidays')
            .select('*')
            .gte('date', startStr)
            .lte('date', endStr);

        if (holidayError) throw holidayError;

        const holidaySet = new Set(holidays?.map(h => h.date) || []);

        // 4. 날짜별 그룹화
        const scheduleByDate = {};
        for (let i = 0; i < 7; i++) {
            const date = startOfWeek.add(i, 'day').format('YYYY-MM-DD');
            scheduleByDate[date] = [];
        }

        schedules.forEach(item => {
            if (scheduleByDate[item.date]) {
                scheduleByDate[item.date].push(item);
            }
        });

        // 5. UI 렌더링
        let html = `
            <div class="flex flex-col h-full max-h-full">
                <!-- 상단 네비게이션 -->
                <div class="flex flex-col border-b pb-2 mb-2">
                     <div class="flex justify-between items-center px-2">
                        <button id="prev-week-btn" class="p-2 hover:bg-gray-100 rounded-full text-lg">◀</button>
                        <div class="text-center">
                            <h2 class="text-lg font-bold text-gray-800">${startOfWeek.format('M월 D일')} ~ ${endOfWeek.format('M월 D일')}</h2>
                            <p class="text-xs text-gray-500">${currentDate.format('YYYY년')}</p>
                        </div>
                        <button id="next-week-btn" class="p-2 hover:bg-gray-100 rounded-full text-lg">▶</button>
                    </div>
                    <div class="flex justify-center mt-1">
                         <button id="today-btn" class="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full font-bold border border-blue-100">이번주 보기</button>
                    </div>
                </div>

                <!-- 주간 리스트 -->
                <div class="flex-grow overflow-y-auto space-y-3 px-1" id="mobile-schedule-list-container">
        `;

        Object.keys(scheduleByDate).sort().forEach(dateStr => {
            const dayObj = dayjs(dateStr);
            const items = scheduleByDate[dateStr];
            const isToday = dateStr === dayjs().format('YYYY-MM-DD');
            const isHoliday = holidaySet.has(dateStr);
            const dayOfWeek = dayObj.day();

            let dayColorClass = 'text-gray-900';
            // let dateBgClass = 'bg-gray-100'; // unused
            if (dayOfWeek === 0) dayColorClass = 'text-red-600';
            if (dayOfWeek === 6) dayColorClass = 'text-blue-600';
            if (isHoliday) dayColorClass = 'text-red-600';

            const dayLabel = dayObj.format('D');
            const weekLabel = dayObj.format('ddd');

            // 내용 구성
            let content = '';
            if (isHoliday) {
                content = `<div class="p-3 bg-red-50 text-red-600 rounded text-center text-sm font-bold">🟥 회사 휴무일</div>`;
            } else if (items.length === 0) {
                content = `<div class="py-4 text-gray-300 text-center text-xs">휴무 / 스케줄 없음</div>`;
            } else {
                const cards = items.map(item => {
                    const emp = item.employees;
                    const deptId = emp.department_id;
                    const color = getDepartmentColor(deptId);

                    return `
                        <div class="flex items-center p-2 mb-1 last:mb-0 bg-white border border-gray-100 rounded shadow-sm">
                            <span class="w-2.5 h-2.5 rounded-full mr-2 flex-shrink-0" style="background-color: ${color};"></span>
                            <span class="font-medium text-sm text-gray-700 truncate">${emp.name}</span>
                            <span class="text-xs text-gray-400 ml-auto whitespace-nowrap px-2">${emp.departments?.name || ''}</span>
                        </div>
                    `;
                }).join('');
                content = `<div class="w-full">${cards}</div>`;
            }

            html += `
                <div class="flex gap-3 ${isToday ? 'bg-blue-50/50 rounded-lg p-1' : ''}">
                    <!-- 날짜 컬럼 -->
                    <div class="flex flex-col items-center justify-start pt-1 w-12 flex-shrink-0">
                        <span class="text-xs ${dayColorClass} font-medium">${weekLabel}</span>
                        <span class="text-xl font-bold ${dayColorClass} ${isToday ? 'bg-blue-600 text-white w-8 h-8 flex items-center justify-center rounded-full mt-1' : 'mt-1'}">${dayLabel}</span>
                    </div>
                    
                    <!-- 내용 컬럼 -->
                    <div class="flex-grow pb-3 border-b border-gray-100 last:border-0">
                         ${content}
                    </div>
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;

        container.innerHTML = html;

        container.querySelector('#prev-week-btn').addEventListener('click', () => {
            state.employee.scheduleViewDate = currentDate.subtract(1, 'week').format('YYYY-MM-DD');
            renderEmployeeMobileScheduleList();
        });

        container.querySelector('#next-week-btn').addEventListener('click', () => {
            state.employee.scheduleViewDate = currentDate.add(1, 'week').format('YYYY-MM-DD');
            renderEmployeeMobileScheduleList();
        });

        container.querySelector('#today-btn').addEventListener('click', () => {
            state.employee.scheduleViewDate = dayjs().format('YYYY-MM-DD');
            renderEmployeeMobileScheduleList();
        });

        requestAnimationFrame(() => {
            const todayEl = container.querySelector('.bg-blue-50');
            if (todayEl) {
                todayEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });

    } catch (error) {
        console.error('스케줄 리스트 렌더링 오류:', error);
        container.innerHTML = `<div class="p-4 text-red-600 text-center">
            <p class="font-bold">스케줄을 불러오지 못했습니다.</p>
            <p class="text-sm mt-2">${error.message}</p>
            <button onclick="renderEmployeeMobileScheduleList()" class="mt-4 px-4 py-2 bg-gray-200 rounded text-sm">다시 시도</button>
        </div>`;
    }
}

function getDepartmentColor(departmentId) {
    if (!departmentId) return '#cccccc';
    const colors = ['#4f46e5', '#db2777', '#16a34a', '#f97316', '#0891b2', '#6d28d9', '#ca8a04'];
    return colors[departmentId % colors.length];
}

async function loadEmployeeData() {
    try {
        const userId = state.currentUser.id;

        const [requestsRes, docRequestsRes, submittedDocsRes] = await Promise.all([
            db.from('leave_requests').select('*').eq('employee_id', userId).order('created_at', { ascending: false }),
            db.from('document_requests').select('*').eq('employeeId', userId).order('created_at', { ascending: false }),
            db.from('submitted_documents').select('*').eq('employee_id', userId).order('created_at', { ascending: false })
        ]);

        if (requestsRes.error) throw requestsRes.error;

        const requests = requestsRes.data || [];
        state.employee.documentRequests = docRequestsRes.data || [];
        state.employee.submittedDocuments = submittedDocsRes.data || [];

        const approved = requests.filter(r => r.status === 'approved');
        const usedDays = approved.reduce((sum, r) => sum + (r.dates?.length || 0), 0);
        const leaveDetails = getLeaveDetails(state.currentUser);

        _('#used-leaves').textContent = `${usedDays}일`;
        _('#remaining-leaves').textContent = `${leaveDetails.final - usedDays}일`;

        renderMyLeaveRequests(requests);
        initializeEmployeeCalendar(approved);
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
        let actionButton = `<button onclick="window.openDocSubmissionModal(${req.id})" class="text-sm bg-blue-600 text-white px-4 py-1 rounded hover:bg-blue-600 font-bold">작성하기</button>`; // blue-600 color fix

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

        return `
            <tr class="border-b">
                <td class="p-3">${dateDisplay}</td>
                <td class="p-3">${dayjs(req.created_at).format('YYYY-MM-DD')}</td>
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

function initializeEmployeeCalendar(approvedRequests) {
    const container = _('#employee-calendar-container');

    if (!container) return;

    if (employeeCalendarInstance) {
        try {
            employeeCalendarInstance.destroy();
        } catch (e) {
            console.log('기존 달력 제거 중 에러:', e);
        }
        employeeCalendarInstance = null;
    }

    const approvedDates = approvedRequests.flatMap(r => r.dates || []);
    selectedDatesForLeave.length = 0;

    container.innerHTML = '';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'flex justify-between items-center mb-4';
    buttonContainer.innerHTML = `
        <h2 class="text-xl font-bold">연차 신청 달력 <span class="text-sm text-gray-500">(날짜를 클릭하여 선택/해제)</span></h2>
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
            const events = [
                ...approvedDates.map(date => ({
                    title: '연차 (승인됨)',
                    start: date,
                    allDay: true,
                    color: '#10b981',
                    textColor: '#ffffff',
                    classNames: ['approved-leave']
                })),
                ...selectedDatesForLeave.map(date => ({
                    title: '선택됨',
                    start: date,
                    allDay: true,
                    color: '#3b82f6',
                    textColor: '#ffffff',
                    classNames: ['selected-date']
                }))
            ];
            successCallback(events);
        },
        dateClick: function (info) {
            const dateStr = info.dateStr;

            if (approvedDates.includes(dateStr)) {
                alert('이미 승인된 연차가 있는 날짜입니다.');
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
    _('#form-selected-dates').innerHTML = dates.sort().map(d =>
        `<span class="inline-block bg-blue-100 text-blue-800 px-2 py-1 rounded mr-2 mb-2">${d}</span>`
    ).join('');
    _('#form-reason').value = '';

    const canvas = _('#signature-canvas');
    if (canvas) {
        resizeGivenCanvas(canvas, window.signaturePad);
        if (!window.signaturePad) {
            window.signaturePad = new SignaturePad(canvas);
        }
        window.signaturePad.clear();
    }

    state.employee.selectedDates = dates;
    show('#leave-form-modal');
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

    if (!signatureData || window.signaturePad.isEmpty()) {
        alert('서명을 해주세요.');
        return;
    }

    const { data: pendingRequests, error: checkError } = await db.from('document_requests')
        .select('*')
        .eq('employeeId', state.currentUser.id)
        .eq('status', 'pending');

    if (pendingRequests && pendingRequests.length > 0) {
        alert('⚠️ 미제출 서류가 있습니다.\n\n서류를 먼저 제출해야 연차 신청이 가능합니다.\n\n"서류 제출" 탭에서 요청된 서류를 확인해주세요.');
        return;
    }

    try {
        const { error } = await db.from('leave_requests').insert({
            employee_id: state.currentUser.id,
            employee_name: state.currentUser.name,
            dates: dates,
            reason: reason || null,
            signature: signatureData,
            status: 'pending',
            created_at: new Date().toISOString()
        });

        if (error) throw error;

        alert('연차 신청이 완료되었습니다.');
        closeLeaveFormModal();
        renderEmployeePortal();
        selectedDatesForLeave.length = 0;
    } catch (error) {
        console.error('연차 신청 오류:', error);
        alert('연차 신청 중 오류가 발생했습니다: ' + error.message);
    }
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
    await renderScheduleManagement(container);
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
                return;
            }

            const fileName = `${state.currentUser.id}_${Date.now()}_${file.name}`;
            const { data: uploadData, error: uploadError } = await db.storage
                .from('document-attachments')
                .upload(fileName, file);

            if (uploadError) {
                console.error('파일 업로드 실패:', uploadError);
                alert('파일 업로드에 실패했습니다. 다시 시도해주세요.');
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
