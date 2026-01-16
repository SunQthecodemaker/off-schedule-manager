color: #a855f7; /* text-purple-500 */
background - color: #faf5ff; /* bg-purple-50 */
            }
            .leave - box.type - carried.used {
    background - color: #d8b4fe;
    color: #6b21a8;
}

            /* 일반 연차 스타일 (파랑) */
            .leave - box.type - regular {
    border - color: #93c5fd; /* blue-300 */
    color: #3b82f6; /* blue-500 */
    background - color: #eff6ff; /* blue-50 */
}
            .leave - box.type - regular.used {
    background - color: #93c5fd;
    color: #1e40af;
}

            /* 당겨쓰기/초과 연차 스타일 (빨강) */
            .leave - box.type - borrowed {
    border - color: #fca5a5; /* red-300 */
    color: #ef4444; /* red-500 */
    background - color: #fef2f2; /* red-50 */
    font - weight: bold;
}
            .leave - box.type - borrowed.used {
    background - color: #fca5a5;
    color: #991b1b;
}

            /* 수동 등록 표시 (빗금 등) - 여기선 간단히 테두리로 구분 */
            .leave - box.manual - entry {
    position: relative;
}
            .leave - box.manual - entry::after {
    content: '';
    position: absolute;
    top: 2px; right: 2px;
    width: 4px; height: 4px;
    border - radius: 50 %;
    background - color: #eab308; /* yellow-500 */
}
        </style >
    <div class="leave-status-container">
        <div class="flex justify-between items-center mb-4">
            <h2 class="text-2xl font-bold">연차 현황</h2>
            <div class="flex gap-2">
                <select id="dept-filter" class="border rounded px-3 py-2">
                    <option value="">전체 부서</option>
                    ${departments.map(dept => `<option value="${dept}">${dept}</option>`).join('')}
                </select>
                <select id="sort-filter" class="border rounded px-3 py-2">
                    <option value="name">이름순</option>
                    <option value="remaining-asc">잔여 적은 순</option>
                    <option value="remaining-desc">잔여 많은 순</option>
                    <option value="usage-desc">사용률 높은 순</option>
                </select>
            </div>
        </div>

        <div class="leave-status-table-wrapper overflow-x-auto">
            <table class="leave-status-table min-w-full text-sm border">
                <thead class="bg-gray-100">
                    <tr>
                        <th class="p-2 w-20 text-center">이름</th>
                        <th class="p-2 w-24 text-center">부서</th>
                        <th class="p-2 w-24 text-center">입사일</th>
                        <th class="p-2 w-16 text-center">확정</th>
                        <th class="p-2 w-16 text-center">사용</th>
                        <th class="p-2 w-16 text-center">잔여</th>
                        <th class="p-2 text-left pl-4">
                            <div class="flex items-center gap-4">
                                <span>연차 사용 현황</span>
                                <div class="flex gap-2 text-xs font-normal">
                                    <span class="flex items-center gap-1"><span class="w-3 h-3 bg-purple-200 border border-purple-400 rounded"></span>이월</span>
                                    <span class="flex items-center gap-1"><span class="w-3 h-3 bg-blue-200 border border-blue-400 rounded"></span>금년</span>
                                    <span class="flex items-center gap-1"><span class="w-3 h-3 bg-red-200 border border-red-400 rounded"></span>당겨쓰기(초과)</span>
                                </div>
                            </div>
                        </th>
                    </tr>
                </thead>
                <tbody id="leave-status-tbody">
                    ${employeeLeaveData.map(emp => getLeaveStatusRow(emp)).join('')}
                </tbody>
            </table>
        </div>
    </div>
`;
}



function getLeaveStatusRow(emp) {
    const deptName = emp.dept || emp.departments?.name || '-';

    // 그리드 생성 로직
    // 확정 연차 개수
    const finalLeaves = emp.leaveDetails.final;
    const carriedCnt = emp.leaveDetails.carriedOverCnt || 0; // 이월된 개수
    const usedCnt = emp.usedDays; // 총 사용 개수

    // 그리드 총 칸 수 = Max(확정 연차, 실제 사용량)
    // 당겨쓰기를 표현하기 위해 사용량이 더 많으면 그만큼 더 그린다.
    const totalBoxes = Math.max(finalLeaves, usedCnt);

    let gridHTML = '<div class="leave-grid-container">';

    for (let i = 0; i < totalBoxes; i++) {
        const isUsed = i < usedCnt; // 앞에서부터 순차적으로 채움
        const boxIndex = i + 1;

        // 연차 소진 순서 로직: 이월 -> 금년 -> 당겨쓰기 
        // 1. 이월 연차 구간
        let boxType = 'regular'; // default
        let boxLabel = boxIndex;

        if (i < carriedCnt) {
            boxType = 'carried';
            boxLabel = `이${ boxIndex } `; // 이1, 이2 ...
        } else if (i < finalLeaves) {
            // 금년 연차 구간
            // 이월이 2개라면, i=2는 3번째 칸이지만 금년 연차로는 1번째임.
            // boxLabel = boxIndex - carriedCnt; (옵션: 금년 연차만 1부터 다시 셀지, 통산으로 할지)
            // 통산 번호로 유지하는 게 깔끔함. 대신 색상으로 구분.
            boxType = 'regular';
        } else {
            // 초과(당겨쓰기) 구간
            boxType = 'borrowed';
            boxLabel = `- ${ boxIndex - finalLeaves } `; // -1, -2 ...
        }

        let boxClass = `leave - box type - ${ boxType } `;
        let dataAttrs = '';
        let displayText = boxLabel;

        if (isUsed) {
            boxClass += ' used';
            const usedDateObj = emp.usedDates[i];

            // 데이터가 있을 때만 (혹시 모를 인덱스 에러 방지)
            if (usedDateObj) {
                const dateVal = usedDateObj.date || usedDateObj;
                const type = usedDateObj.type || 'formal';
                const requestId = usedDateObj.requestId || '';

                displayText = dayjs(dateVal).format('M.D');

                if (type === 'manual') {
                    boxClass += ' manual-entry';
                }

                dataAttrs = `data - request - id="${requestId}" data - type="${type}" title = "${boxType === 'borrowed' ? '당겨쓰기(초과)' : '연차사용'}: ${dateVal}"`;
            }
        }
        // 미사용 상태 (빈칸)
        else {
            dataAttrs = `title = "${boxType === 'carried' ? '이월 연차 (미사용)' : '금년 연차 (미사용)'}"`;
        }


        gridHTML += `< div class="${boxClass}" ${ dataAttrs }> ${ displayText }</div > `;
    }
    gridHTML += '</div>';

    return `
    < tr class="leave-status-row border-b hover:bg-gray-50" data - employee - id="${emp.id}" data - dept="${deptName}" data - remaining="${emp.remainingDays}" data - usage="${emp.usagePercent}" >
            <td class="p-2 text-center font-semibold">${emp.name}</td>
            <td class="p-2 text-center text-gray-600">${deptName}</td>
            <td class="p-2 text-center text-gray-500">${dayjs(emp.entryDate).format('YY.MM.DD')}</td>
            <td class="p-2 text-center font-bold">${emp.leaveDetails.final}</td>
            <td class="p-2 text-center text-blue-600">${emp.usedDays}</td>
            <td class="p-2 text-center font-bold ${emp.remainingDays <= 3 ? 'text-red-600' : 'text-green-600'}">${emp.remainingDays}</td>
            <td class="p-2 text-left pl-4" style="max-width: 800px; overflow-x: auto;">
                ${gridHTML}
            </td>
        </tr >
    `;
}

export function addLeaveStatusEventListeners() {
    const deptFilter = document.getElementById('dept-filter');
    const sortFilter = document.getElementById('sort-filter');

    if (deptFilter) {
        deptFilter.addEventListener('change', filterAndSortLeaveStatus);
    }

    if (sortFilter) {
        sortFilter.addEventListener('change', filterAndSortLeaveStatus);
    }

    // 수동 연차 등록 (더블클릭) 및 신청서 조회 (단일 클릭)
    const leaveStatusContainer = document.querySelector('.leave-status-table-wrapper');
    if (leaveStatusContainer) {
        leaveStatusContainer.addEventListener('dblclick', handleLeaveBoxDblClick);
        leaveStatusContainer.addEventListener('click', handleLeaveBoxClick);
    }
}

async function handleLeaveBoxClick(e) {
    const box = e.target.closest('.leave-box');
    if (!box) return;

    // 사용된 연차인지 확인
    if (!box.classList.contains('used')) return;

    const requestId = box.dataset.requestId;
    const type = box.dataset.type;

    if (!requestId) return;

    if (type === 'manual') {
        const request = state.management.leaveRequests.find(r => r.id == requestId);
        if (request) {
            const confirmMsg = `[관리자 수동 등록 건]\n\n` +
                `등록일: ${ dayjs(request.created_at).format('YYYY-MM-DD') } \n` +
                `대상일: ${ request.dates.join(', ') } \n` +
                `사유: ${ request.reason } \n\n` +
                `이 연차 내역을 삭제하시겠습니까 ? `;

            if (confirm(confirmMsg)) {
                try {
                    const { error } = await db.from('leave_requests').delete().eq('id', requestId);
                    if (error) throw error;
                    alert('삭제되었습니다.');
                    await window.loadAndRenderManagement();
                } catch (err) {
                    console.error(err);
                    alert('삭제 중 오류가 발생했습니다: ' + err.message);
                }
            }
        }
    } else {
        window.viewLeaveApplication(requestId);
    }
}

window.viewLeaveApplication = function (requestId) {
    const request = state.management.leaveRequests.find(r => r.id == requestId);
    if (!request) {
        alert('신청 정보를 찾을 수 없습니다.');
        return;
    }

    const employee = state.management.employees.find(e => e.id === request.employee_id);
    const deptName = employee?.departments?.name || employee?.dept || '-';
    // const submissionDate = dayjs(request.created_at).format('YYYY년 MM월 DD일');
    const submissionDate = request.created_at ? dayjs(request.created_at).format('YYYY년 MM월 DD일') : dayjs(request.dates[0]).format('YYYY년 MM월 DD일');

    const leaveDates = (request.dates || []).join(', ');
    const daysCount = request.dates?.length || 0;

    // 서명 이미지 처리
    const signatureHtml = request.signature
        ? `< img src = "${request.signature}" alt = "서명" style = "max-width: 150px; max-height: 80px;" > `
        : `< span class="text-gray-400 italic text-sm" > (서명 없음)</span > `;

    const modalHTML = `
    < div id = "view-leave-app-modal" class="modal-overlay" >
        <div class="modal-content" style="max-width: 700px;">
            <div class="flex justify-end no-print">
                <button id="close-leave-app-modal" class="text-3xl text-gray-500 hover:text-gray-800">&times;</button>
            </div>

            <div class="p-8 bg-white print-area">
                <div class="text-center mb-10">
                    <h1 class="text-3xl font-extrabold border-2 border-black inline-block px-8 py-2">연 차 신 청 서</h1>
                </div>

                <div class="flex justify-end mb-6">
                    <table class="border border-black text-center text-sm" style="width: 200px;">
                        <tr>
                            <th class="border border-black bg-gray-100 p-1 w-1/2">매니저</th>
                            <th class="border border-black bg-gray-100 p-1 w-1/2">관리자</th>
                        </tr>
                        <tr style="height: 60px;">
                            <td class="border border-black align-middle">
                                ${request.middle_manager_status === 'approved' ? '<span class="text-red-600 font-bold border-2 border-red-600 rounded-full p-1 text-xs">승인</span>' : (request.middle_manager_status === 'skipped' ? '-' : '')}
                            </td>
                            <td class="border border-black align-middle">
                                ${request.final_manager_status === 'approved' ? '<span class="text-red-600 font-bold border-2 border-red-600 rounded-full p-1 text-xs">승인</span>' : ''}
                            </td>
                        </tr>
                    </table>
                </div>

                <table class="w-full border-collapse border-2 border-black mb-6">
                    <tr>
                        <th class="border border-black bg-gray-100 p-3 w-32">성 명</th>
                        <td class="border border-black p-3">${request.employee_name}</td>
                        <th class="border border-black bg-gray-100 p-3 w-32">소 속</th>
                        <td class="border border-black p-3">${deptName}</td>
                    </tr>
                    <tr>
                        <th class="border border-black bg-gray-100 p-3">신청 기간</th>
                        <td class="border border-black p-3" colspan="3">
                            ${leaveDates} <span class="text-sm text-gray-600 ml-2">(총 ${daysCount}일)</span>
                        </td>
                    </tr>
                    <tr>
                        <th class="border border-black bg-gray-100 p-3">사 유</th>
                        <td class="border border-black p-3 h-32 align-top" colspan="3">${request.reason || '-'}</td>
                    </tr>
                </table>

                <div class="text-center mt-12 mb-8">
                    <p class="text-lg mb-4">위와 같이 연차를 신청하오니 허가하여 주시기 바랍니다.</p>
                    <p class="text-lg font-bold">${submissionDate}</p>
                </div>

                <div class="flex justify-end items-center mt-8">
                    <span class="text-lg mr-4">신청인: </span>
                    <span class="text-lg font-bold mr-4">${request.employee_name}</span>
                    <div class="border-b border-black pb-1 min-w-[100px] text-center">
                        ${signatureHtml}
                    </div>
                </div>
            </div>

            <div class="flex justify-center mt-6 gap-2 no-print">
                <button id="print-leave-app-btn" class="bg-gray-800 text-white px-6 py-2 rounded hover:bg-black">인쇄하기</button>
                <button id="ok-leave-app-btn" class="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700">확인</button>
            </div>
        </div>
        </div >

    <style>
        @media print {
            body * {
                visibility: hidden;
            }
                .print - area, .print - area * {
                    visibility: visible;
                }
                    .print - area {
            position: absolute;
        left: 0;
        top: 0;
        width: 100%;
                }
        .no-print {
            display: none !important;
                }
            }
    </style>
`;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    _('#close-leave-app-modal').addEventListener('click', () => _('#view-leave-app-modal').remove());
    _('#ok-leave-app-btn').addEventListener('click', () => _('#view-leave-app-modal').remove());
    _('#print-leave-app-btn').addEventListener('click', () => window.print());
};

async function handleLeaveBoxDblClick(e) {
    const box = e.target.closest('.leave-box');
    if (!box) return;

    if (box.classList.contains('used')) return;

    const tr = box.closest('tr');
    if (!tr) return;

    // dataset.employeeId 사용 (getLeaveStatusRow에서 추가한 속성)
    let employeeId = tr.dataset.employeeId;

    // 만약 data-employee-id가 없다면 (기존 렌더링 된 요소일 경우) 이름으로 찾기 fallback
    if (!employeeId) {
        const nameCell = tr.querySelector('td:first-child');
        if (nameCell) {
            const name = nameCell.textContent.trim();
            const employee = state.management.employees.find(e => e.name === name);
            if (employee) employeeId = employee.id;
        }
    }

    if (!employeeId) {
        alert('직원 정보를 찾을 수 없습니다.');
        return;
    }

    const employee = state.management.employees.find(e => e.id == employeeId);
    if (!employee) return;

    // 날짜 입력 받기
    const defaultDate = dayjs().format('YYYY-MM-DD');
    const inputDate = prompt(`[${ employee.name }] 직원의 연차를 수동으로 등록하시겠습니까 ?\n등록할 날짜를 입력해주세요(YYYY - MM - DD): `, defaultDate);

    if (inputDate === null) return;

    // 날짜 유효성 검사
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
        alert('올바른 날짜 형식이 아닙니다 (YYYY-MM-DD)');
        return;
    }

    if (confirm(`${ employee.name }님의 ${ inputDate } 연차를 '관리자 수동 등록'으로 처리하시겠습니까 ? `)) {
        try {
            const { error } = await db.from('leave_requests').insert({
                employee_id: employee.id,
                employee_name: employee.name,
                dates: [inputDate],
                reason: '관리자 수동 등록',
                status: 'approved',
                final_manager_id: state.currentUser.id,
                final_manager_status: 'approved',
                final_approved_at: new Date().toISOString()
            });

            if (error) throw error;

            alert('수동 등록이 완료되었습니다.');
            await window.loadAndRenderManagement();
        } catch (err) {
            console.error(err);
            alert('등록 중 오류가 발생했습니다: ' + err.message);
        }
    }
}


function filterAndSortLeaveStatus() {
    const deptFilter = document.getElementById('dept-filter').value;
    const sortFilter = document.getElementById('sort-filter').value;
    const tbody = document.getElementById('leave-status-tbody');
    const rows = Array.from(tbody.querySelectorAll('.leave-status-row'));

    // 필터링
    rows.forEach(row => {
        const dept = row.dataset.dept;
        if (deptFilter === '' || dept === deptFilter) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });

    // 정렬
    const visibleRows = rows.filter(row => row.style.display !== 'none');
    visibleRows.sort((a, b) => {
        switch (sortFilter) {
            case 'name':
                return a.querySelector('td').textContent.localeCompare(b.querySelector('td').textContent);
            case 'remaining-asc':
                return parseInt(a.dataset.remaining) - parseInt(b.dataset.remaining);
            case 'remaining-desc':
                return parseInt(b.dataset.remaining) - parseInt(a.dataset.remaining);
            case 'usage-desc':
                return parseInt(b.dataset.usage) - parseInt(a.dataset.usage);
            default:
                return 0;
        }
    });

    // 재배치
    visibleRows.forEach(row => tbody.appendChild(row));
}
