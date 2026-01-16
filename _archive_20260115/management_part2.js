
        <div class="flex flex-wrap gap-2 mb-4 items-center">
            <div class="flex gap-2">
                <button onclick="window.filterLeaveList('all')" id="filter-all" class="filter-btn active px-3 py-1 text-sm rounded bg-blue-600 text-white">전체 (${filteredRequests.length})</button>
                <button onclick="window.filterLeaveList('pending')" id="filter-pending" class="filter-btn px-3 py-1 text-sm rounded bg-gray-200">최종 대기중 (${filteredRequests.filter(r => (r.final_manager_status || 'pending') === 'pending').length})</button>
                <button onclick="window.filterLeaveList('approved')" id="filter-approved" class="filter-btn px-3 py-1 text-sm rounded bg-gray-200">최종 승인됨 (${filteredRequests.filter(r => (r.final_manager_status || 'pending') === 'approved').length})</button>
                <button onclick="window.filterLeaveList('rejected')" id="filter-rejected" class="filter-btn px-3 py-1 text-sm rounded bg-gray-200">반려됨 (${filteredRequests.filter(r => (r.final_manager_status || 'pending') === 'rejected').length})</button>
            </div>
            <div class="flex gap-2 items-center ml-4">
                <label class="text-sm font-semibold">직원:</label>
                <select id="employee-filter" onchange="window.filterByEmployee(this.value)" class="text-sm border rounded px-2 py-1">
                    <option value="all">전체 직원</option>
                    ${employeeOptions}
                </select>
            </div>
        </div>
        
        <div class="mb-8">
            <table class="min-w-full text-sm border">
                <thead class="bg-gray-100">
                    <tr>
                        <th class="p-2 text-left text-xs font-semibold">직원</th>
                        <th class="p-2 text-left text-xs font-semibold">신청날짜</th>
                        <th class="p-2 text-center text-xs font-semibold">일수</th>
                        <th class="p-2 text-center text-xs font-semibold">결재현황</th>
                        <th class="p-2 text-center text-xs font-semibold">처리</th>
                    </tr>
                </thead>
                <tbody id="leave-table-body">${rows}</tbody>
            </table>
        </div>
        
        <div>
            <h3 class="text-md font-semibold mb-2">📅 연차 현황 달력</h3>
            <div class="flex flex-wrap gap-2 mb-2 items-center">
                <div class="flex gap-2">
                    <button onclick="window.filterLeaveCalendar('pending')" id="cal-filter-pending" class="cal-filter-btn active px-3 py-1 text-sm rounded bg-yellow-500 text-white">대기중</button>
                    <button onclick="window.filterLeaveCalendar('approved')" id="cal-filter-approved" class="cal-filter-btn px-3 py-1 text-sm rounded bg-gray-200">승인됨</button>
                    <button onclick="window.filterLeaveCalendar('all')" id="cal-filter-all" class="cal-filter-btn px-3 py-1 text-sm rounded bg-gray-200">전체</button>
                </div>
                <div class="flex gap-2 items-center ml-4">
                    <label class="text-sm font-semibold">직원:</label>
                    <select id="calendar-employee-filter" onchange="window.filterCalendarByEmployee(this.value)" class="text-sm border rounded px-2 py-1">
                        <option value="all">전체 직원</option>
                        ${employeeOptions}
                    </select>
                </div>
            </div>
            <div id="leave-calendar-container"></div>
        </div>
`;
}

// 목록 필터 상태
let currentListStatus = 'all';
let currentListEmployee = 'all';

// 목록 필터
window.filterLeaveList = function (status) {
    currentListStatus = status;
    applyListFilters();

    const buttons = document.querySelectorAll('.filter-btn');
    buttons.forEach(btn => {
        btn.classList.remove('active', 'bg-blue-600', 'text-white');
        btn.classList.add('bg-gray-200');
    });

    const activeBtn = _(`#filter - ${ status } `);
    if (activeBtn) {
        activeBtn.classList.add('active', 'bg-blue-600', 'text-white');
        activeBtn.classList.remove('bg-gray-200');
    }
};

// 직원별 필터 (목록)
window.filterByEmployee = function (employeeId) {
    currentListEmployee = employeeId;
    applyListFilters();
};

// 목록 필터 적용
function applyListFilters() {
    const rows = document.querySelectorAll('.leave-row');

    rows.forEach(row => {
        const statusMatch = currentListStatus === 'all' || row.dataset.status === currentListStatus;
        const employeeMatch = currentListEmployee === 'all' || row.dataset.employeeId === currentListEmployee;

        row.style.display = (statusMatch && employeeMatch) ? '' : 'none';
    });
}

// 달력 필터 상태
let currentCalendarFilter = 'pending';
let currentCalendarEmployee = 'all';

window.filterLeaveCalendar = function (status) {
    currentCalendarFilter = status;

    const buttons = document.querySelectorAll('.cal-filter-btn');
    buttons.forEach(btn => {
        btn.classList.remove('active', 'bg-yellow-500', 'bg-green-500', 'bg-blue-600', 'text-white');
        btn.classList.add('bg-gray-200');
    });

    const activeBtn = _(`#cal - filter - ${ status } `);
    if (activeBtn) {
        if (status === 'pending') {
            activeBtn.classList.add('active', 'bg-yellow-500', 'text-white');
        } else if (status === 'approved') {
            activeBtn.classList.add('active', 'bg-green-500', 'text-white');
        } else {
            activeBtn.classList.add('active', 'bg-blue-600', 'text-white');
        }
        activeBtn.classList.remove('bg-gray-200');
    }

    window.renderLeaveCalendar();
};

// 직원별 필터 (달력)
window.filterCalendarByEmployee = function (employeeId) {
    currentCalendarEmployee = employeeId;
    window.renderLeaveCalendar();
};

// 연차 신청 달력 렌더링
window.renderLeaveCalendar = function (containerSelector) {
    // 선택자가 전달되지 않으면 기본값 사용, 전달되면 해당 선택자 사용
    const targetSelector = containerSelector || '#leave-calendar-container';

    // 우선 지정된 선택자로 찾기
    let container = document.querySelector(targetSelector);

    // 찾지 못했고 선택자가 기본값인 경우, 현재 활성화된 포털 내에서 찾기 시도
    if (!container && !containerSelector) {
        const visibleContainer = document.querySelector('#employee-portal:not(.hidden) #leave-calendar-container') ||
            document.querySelector('#admin-portal:not(.hidden) #leave-calendar-container');
        if (visibleContainer) container = visibleContainer;
    }

    if (!container) {
        console.warn('Calendar container not found. Selector:', targetSelector);
        return;
    }

    const { leaveRequests, employees } = state.management;

    const employeeNameMap = employees.reduce((map, emp) => {
        map[emp.id] = emp.name;
        return map;
    }, {});

    // 필터링
    let filteredRequests = leaveRequests.filter(req => req.status !== 'rejected');

    if (currentCalendarFilter !== 'all') {
        filteredRequests = filteredRequests.filter(req => req.status === currentCalendarFilter);
    }

    if (currentCalendarEmployee !== 'all') {
        filteredRequests = filteredRequests.filter(req => req.employee_id === parseInt(currentCalendarEmployee));
    }

    // FullCalendar 이벤트 생성
    const events = [];
    filteredRequests.forEach(req => {
        const employeeName = employeeNameMap[req.employee_id] || '알 수 없음';
        const color = req.status === 'pending' ? '#fbbf24' : '#10b981';
        const borderColor = req.status === 'pending' ? '#f59e0b' : '#059669';

        req.dates?.forEach(date => {
            events.push({
                title: employeeName,
                start: date,
                allDay: true,
                backgroundColor: color,
                borderColor: borderColor,
                extendedProps: {
                    requestId: req.id,
                    employeeId: req.employee_id,
                    employeeName: employeeName,
                    reason: req.reason,
                    createdAt: req.created_at,
                    status: req.status
                }
            });
        });
    });

    // 달력이 이미 있으면 제거
    container.innerHTML = '';
    const calendarEl = document.createElement('div');
    container.appendChild(calendarEl);

    if (typeof FullCalendar === 'undefined') {
        container.innerHTML = '<p class="text-red-600 text-center py-4">달력 라이브러리를 로드할 수 없습니다.</p>';
        return;
    }

    const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        headerToolbar: {
            left: 'today',
            center: 'prev title next',
            right: ''
        },
        locale: 'ko',
        events: events,
        eventClick: function (info) {
            const props = info.event.extendedProps;

            if (props.status === 'approved') {
                alert(`이미 승인된 연차입니다.\n\n직원: ${ props.employeeName } \n날짜: ${ info.event.start.toLocaleDateString('ko-KR') } `);
                return;
            }

            const message = `직원: ${ props.employeeName }
날짜: ${ info.event.start.toLocaleDateString('ko-KR') }
사유: ${ props.reason || '없음' }
신청일: ${ dayjs(props.createdAt).format('YYYY-MM-DD HH:mm') }

승인하시겠습니까 ? `;

            if (confirm(message)) {
                window.handleLeaveApproval(props.requestId, 'approved');
            }
        },
        height: 'auto'
    });

    calendar.render();
};


// 중간 승인 처리 (매니저)
window.handleMiddleApproval = async function (requestId, status) {
    const currentUser = state.currentUser;

    if (!currentUser.isManager) {
        alert('매니저 권한이 없습니다.');
        return;
    }

    if (status === 'rejected') {
        const reason = prompt('반려 사유를 입력해주세요:');
        if (!reason) return;
    }

    const confirmed = confirm(status === 'approved' ? '중간 승인하시겠습니까?' : '반려하시겠습니까?');
    if (!confirmed) return;

    try {
        const updateData = {
            middle_manager_id: currentUser.id,
            middle_manager_status: status,
            middle_approved_at: new Date().toISOString()
        };

        // 반려 시 최종 상태도 반려로 변경
        if (status === 'rejected') {
            updateData.final_manager_status = 'rejected';
            updateData.status = 'rejected';
        }

        const { error } = await db.from('leave_requests')
            .update(updateData)
            .eq('id', requestId);

        if (error) throw error;

        alert(status === 'approved' ? '중간 승인이 완료되었습니다.' : '반려되었습니다.');
        await window.loadAndRenderManagement();

    } catch (error) {
        console.error('중간 승인 처리 오류:', error);
        alert('처리 중 오류가 발생했습니다: ' + error.message);
    }
};

// 최종 승인 처리 (관리자)
window.handleFinalApproval = async function (requestId, status) {
    const currentUser = state.currentUser;

    if (currentUser.role !== 'admin') {
        alert('관리자 권한이 없습니다.');
        return;
    }

    if (status === 'rejected') {
        const reason = prompt('반려 사유를 입력해주세요:');
        if (!reason) return;
    }

    const confirmed = confirm(status === 'approved' ? '최종 승인하시겠습니까?' : '반려하시겠습니까?');
    if (!confirmed) return;

    try {
        const updateData = {
            final_manager_id: currentUser.id,
            final_manager_status: status,
            final_approved_at: new Date().toISOString(),
            status: status // 기존 status 필드도 업데이트
        };

        // 매니저 승인을 건너뛴 경우
        const { data: request } = await db.from('leave_requests')
            .select('middle_manager_status')
            .eq('id', requestId)
            .single();

        if (request && request.middle_manager_status !== 'approved' && request.middle_manager_status !== 'rejected') {
            updateData.middle_manager_status = 'skipped';
        }

        const { error } = await db.from('leave_requests')
            .update(updateData)
            .eq('id', requestId);

        if (error) throw error;

        alert(status === 'approved' ? '최종 승인이 완료되었습니다.' : '반려되었습니다.');
        await window.loadAndRenderManagement();

    } catch (error) {
        console.error('최종 승인 처리 오류:', error);
        alert('처리 중 오류가 발생했습니다: ' + error.message);
    }
};

// 기존 함수 (하위 호환성)
window.handleLeaveApproval = async function (requestId, status) {
    try {
        const { error } = await db.from('leave_requests')
            .update({ status })
            .eq('id', requestId);

        if (error) throw error;

        alert(status === 'approved' ? '승인되었습니다.' : '반려되었습니다.');
        await window.loadAndRenderManagement();

    } catch (error) {
        console.error('연차 처리 오류:', error);
        alert('처리 중 오류가 발생했습니다: ' + error.message);
    }
}

// =========================================================================================
// 대량 등록
// =========================================================================================

export async function handleBulkRegister() {
    const data = _('#bulk-employee-data').value.trim();
    const resultDiv = _('#bulk-register-result');
    const registerBtn = _('#submit-bulk-register-btn');
    if (!data) {
        resultDiv.textContent = '등록할 데이터를 입력해주세요.';
        return;
    }

    registerBtn.disabled = true;
    resultDiv.innerHTML = '등록 중...';

    const { departments } = state.management;
    const departmentNameToIdMap = new Map(departments.map(d => [d.name, d.id]));

    const lines = data.split('\n');
    const employeesToInsert = [];
    const errors = [];

    lines.forEach((line, index) => {
        const [name, entryDate, email, password, departmentName] = line.split('\t').map(s => s.trim());
        if (!name || !entryDate || !password || !departmentName) {
            errors.push(`- ${ index + 1 }번째 줄: 필수 항목(이름, 입사일, 비밀번호, 부서명)이 누락되었습니다.`);
            return;
        }

        const department_id = departmentNameToIdMap.get(departmentName);
        if (!department_id) {
            errors.push(`- ${ index + 1 }번째 줄(${ name }): 존재하지 않는 부서명입니다. ('${departmentName}')`);
            return;
        }

        employeesToInsert.push({ name, entryDate, email, password, department_id });
    });

    if (employeesToInsert.length > 0) {
        const { error } = await db.from('employees').insert(employeesToInsert);
        if (error) {
            errors.push(`데이터베이스 저장 실패: ${ error.message } `);
        }
    }

    let resultMessage = `총 ${ lines.length }건 중 ${ employeesToInsert.length }건 성공 / ${ errors.length }건 실패\n\n`;
    if (errors.length > 0) {
        resultMessage += "실패 사유:\n" + errors.join('\n');
    }

    resultDiv.textContent = resultMessage;
    registerBtn.disabled = false;

    if (errors.length === 0) {
        alert('모든 직원이 성공적으로 등록되었습니다.');
        await window.loadAndRenderManagement();
    }
}
// =========================================================================================
// 연차 관리 HTML (새로운 탭)
// =========================================================================================

export function getLeaveManagementHTML() {
    const { employees, leaveRequests } = state.management;

    const headers = [
        { name: '이름', width: '8%' },
        { name: '입사일', width: '8%' },
        { name: '근무일수', width: '7%' },
        { name: '연차 기준일', width: '9%' },
        { name: '다음 갱신일', width: '9%' },
        { name: '법정', width: '5%' },
        { name: '전년 이월', width: '7%' }, // 명칭 변경: 이월 -> 전년 이월
        { name: '조정', width: '7%' },
        { name: '확정', width: '5%' },
        { name: '사용', width: '5%' },
        { name: '잔여', width: '5%' },
        { name: '갱신 안내 (이월 예정)', width: '15%' }, // 명칭 변경: 이월 예정 -> 갱신 안내
        { name: '관리', width: '10%' }
    ];

    const headerHtml = headers.map(h => `< th class="p-2 text-left text-xs font-semibold" style = "width: ${h.width};" > ${ h.name }</th > `).join('');

    const rows = employees.map(emp => {
        const leaveData = getLeaveDetails(emp);

        // 중요: 현재 연차 주기에 해당하는 승인된 연차만 합산
        const pStart = dayjs(leaveData.periodStart);
