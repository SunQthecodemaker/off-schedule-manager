import { state, db } from './state.js';
import { _, show } from './utils.js';
import { getLeaveDetails } from './leave-utils.js';

// =========================================================================================
// 전역 이벤트 핸들러 할당
// =========================================================================================
export function assignManagementEventHandlers() {
    window.handleUpdateEmployee = handleUpdateEmployee;
    window.handleDeleteEmployee = handleDeleteEmployee;
    window.handleAddEmployee = handleAddEmployee;
    window.handleAddNewDepartment = handleAddNewDepartment;
    window.handleUpdateDepartment = handleUpdateDepartment;
    window.handleDeleteDepartment = handleDeleteDepartment;
    window.openDocumentRequestModal = openDocumentRequestModal;
    window.handleRetireEmployee = handleRetireEmployee;
    window.handleRestoreEmployee = handleRestoreEmployee;
    window.toggleEmployeeFilter = toggleEmployeeFilter;
}

// =========================================================================================
// 직원 관리 기능
// =========================================================================================

function addManagementEventListeners() {
    const selectAllCheckbox = _('#selectAllCheckbox');
    const employeeCheckboxes = document.querySelectorAll('.employee-checkbox');
    const bulkDeleteBtn = _('#bulkDeleteBtn');

    selectAllCheckbox?.addEventListener('change', () => {
        employeeCheckboxes.forEach(checkbox => {
            checkbox.checked = selectAllCheckbox.checked;
        });
        updateBulkDeleteButtonState();
    });

    employeeCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            if (!checkbox.checked) {
                selectAllCheckbox.checked = false;
            } else {
                const allChecked = Array.from(employeeCheckboxes).every(cb => cb.checked);
                selectAllCheckbox.checked = allChecked;
            }
            updateBulkDeleteButtonState();
        });
    });

    bulkDeleteBtn?.addEventListener('click', async () => {
        const checkedCheckboxes = document.querySelectorAll('.employee-checkbox:checked');
        const idsToDelete = Array.from(checkedCheckboxes).map(cb => parseInt(cb.value, 10));

        if (idsToDelete.length === 0) {
            alert('삭제할 직원을 선택해주세요.');
            return;
        }

        if (confirm(`정말로 선택된 ${idsToDelete.length}명의 직원을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`)) {
            const { error } = await db.from('employees').delete().in('id', idsToDelete);

            if (error) {
                alert('직원 삭제에 실패했습니다: ' + error.message);
            } else {
                alert(`${idsToDelete.length}명의 직원이 성공적으로 삭제되었습니다.`);
                await window.loadAndRenderManagement();
            }
        }
    });

    // ✅ 연차 기준일 변경 시 다음 갱신일 자동 업데이트
    const renewalInputs = document.querySelectorAll('.renewal-date-input');
    renewalInputs.forEach(input => {
        input.addEventListener('change', (e) => {
            const empId = e.target.dataset.empId;
            const entryDate = e.target.dataset.entryDate;
            const renewalValue = e.target.value;

            // 다음 갱신일 계산
            let nextRenewalDate;
            if (renewalValue) {
                const baseDate = dayjs(renewalValue);
                const today = dayjs();
                const renewalThisYear = baseDate.year(today.year());
                nextRenewalDate = renewalThisYear.isSameOrAfter(today, 'day')
                    ? renewalThisYear.format('YYYY-MM-DD')
                    : renewalThisYear.add(1, 'year').format('YYYY-MM-DD');
            } else if (entryDate) {
                const baseDate = dayjs(entryDate).add(1, 'year');
                const today = dayjs();
                const renewalThisYear = baseDate.year(today.year());
                nextRenewalDate = renewalThisYear.isSameOrAfter(today, 'day')
                    ? renewalThisYear.format('YYYY-MM-DD')
                    : renewalThisYear.add(1, 'year').format('YYYY-MM-DD');
            }

            // 다음 갱신일 표시 업데이트
            const nextRenewalCell = _(`#next-renewal-${empId}`);
            if (nextRenewalCell && nextRenewalDate) {
                nextRenewalCell.textContent = nextRenewalDate;
            }
        });
    });
}

function updateBulkDeleteButtonState() {
    const bulkDeleteBtn = _('#bulkDeleteBtn');
    const checkedCount = document.querySelectorAll('.employee-checkbox:checked').length;
    if (bulkDeleteBtn) {
        bulkDeleteBtn.disabled = checkedCount === 0;
        bulkDeleteBtn.textContent = `선택 직원 삭제 (${checkedCount})`;
    }
}

async function handleUpdateEmployee(id) {
    const name = _(`#name-${id}`).value;
    const entryDate = _(`#entry-${id}`).value;
    const email = _(`#email-${id}`).value;
    const department_id = parseInt(_(`#dept-${id}`).value, 10);
    const managerCheckbox = _(`#manager-${id}`);
    const isManager = managerCheckbox ? managerCheckbox.checked : false;

    console.log('💾 업데이트 데이터:', {
        id,
        name,
        entryDate,
        email,
        department_id,
        isManager
    });

    const { data, error } = await db.from('employees').update({
        name,
        entryDate,
        email,
        department_id,
        isManager
    }).eq('id', id).select();

    console.log('✅ DB 응답:', { data, error });

    if (error) {
        alert('직원 정보 업데이트 실패: ' + error.message);
    } else {
        alert('직원 정보가 성공적으로 저장되었습니다.');
        await window.loadAndRenderManagement();
    }
}

async function handleDeleteEmployee(id) {
    if (confirm("정말로 이 직원을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) {
        const { error } = await db.from('employees').delete().eq('id', id);
        if (error) {
            alert('직원 삭제 실패: ' + error.message);
        } else {
            alert('직원이 성공적으로 삭제되었습니다.');
            await window.loadAndRenderManagement();
        }
    }
}

async function handleAddEmployee() {
    const name = _('#newName').value;
    const entryDate = _('#newEntry').value;
    const email = _('#newEmail').value;
    const password = _('#newPassword').value;
    const department_id = _('#newDepartment').value;

    if (!name || !entryDate || !password || !department_id) {
        alert('이름, 입사일, 비밀번호, 부서는 필수 입력 항목입니다.');
        return;
    }

    const { error } = await db.from('employees').insert([{ name, entryDate, email, password, department_id: parseInt(department_id, 10) }]).select();

    if (error) {
        alert('직원 추가에 실패했습니다: ' + error.message);
    } else {
        alert(`${name} 직원이 성공적으로 추가되었습니다.`);
        await window.loadAndRenderManagement();
    }
}

// =========================================================================================
// 서류 요청 모달 - 서식 목록 동적 로딩으로 수정
// =========================================================================================

function openDocumentRequestModal(employeeId, employeeName) {
    _('#issue-employee-id').value = employeeId;
    _('#issue-employee-name').textContent = employeeName;

    // 서식 목록을 동적으로 로드
    const select = _('#issue-required-doc');
    const templates = state.management.templates || [];

    // 서식이 있으면 동적으로 로드, 없으면 기본 옵션
    if (templates.length > 0) {
        select.innerHTML = '<option value="">-- 서류를 선택하세요 --</option>' +
            templates.map(t => `<option value="${t.id}">${t.template_name || t.name}</option>`).join('');
    } else {
        // 기본 하드코딩된 옵션 (서식이 없을 때)
        select.innerHTML = `
            <option value="">-- 서류를 선택하세요 --</option>
            <option value="경위서">경위서</option>
            <option value="시말서">시말서</option>
            <option value="병가확인서">병가확인서</option>
            <option value="기타">기타</option>
        `;
    }

    show('#issue-modal');
}

// 이슈 폼 제출 처리 (전역 함수로 등록)
window.handleIssueSubmit = async function (e) {
    e.preventDefault();

    const employeeId = parseInt(_('#issue-employee-id').value);
    const employee = state.management.employees.find(emp => emp.id === employeeId);
    const issueType = _('#issue-type').value;
    const details = _('#issue-details').value.trim();
    const requiredDocId = _('#issue-required-doc').value;

    if (!details) {
        alert('상세 내용을 입력해주세요.');
        return;
    }

    try {
        // 서식 ID가 숫자인지 문자인지 확인하여 처리
        let docType = '기타';
        if (requiredDocId) {
            if (isNaN(requiredDocId)) {
                // 문자열인 경우 (하드코딩된 옵션)
                docType = requiredDocId;
            } else {
                // 숫자인 경우 (DB 서식 ID)
                const template = state.management.templates.find(t => t.id === parseInt(requiredDocId));
                docType = template ? template.template_name : '기타';
            }
        }

        const { error } = await db.from('document_requests').insert({
            employeeId: employeeId,
            employeeName: employee ? employee.name : '알 수 없음',
            type: docType,
            message: details,
            status: 'pending',
            created_at: new Date().toISOString()
        });

        if (error) throw error;

        alert('서류 제출 요청이 생성되었습니다.');
        document.querySelector('#issue-modal').classList.add('hidden');
        _('#issue-form').reset();
        await window.loadAndRenderManagement();
    } catch (error) {
        console.error('요청 생성 실패:', error);
        alert('요청 생성에 실패했습니다: ' + error.message);
    }
};

// =========================================================================================
// 직원 관리 HTML
// =========================================================================================

// 직원 관리 필터 상태
let currentEmployeeFilter = 'active'; // active | retired

window.toggleEmployeeFilter = function (filter) {
    currentEmployeeFilter = filter;

    // 버튼 스타일 업데이트
    const activeBtn = document.getElementById('filter-btn-active');
    const retiredBtn = document.getElementById('filter-btn-retired');

    if (filter === 'active') {
        activeBtn.style.backgroundColor = '#2563eb';
        activeBtn.style.color = 'white';
        retiredBtn.style.backgroundColor = '#e5e7eb';
        retiredBtn.style.color = 'black';
    } else {
        retiredBtn.style.backgroundColor = '#2563eb';
        retiredBtn.style.color = 'white';
        activeBtn.style.backgroundColor = '#e5e7eb';
        activeBtn.style.color = 'black';
    }

    window.loadAndRenderManagement();
};

window.handleRetireEmployee = async function (id) {
    const defaultDate = dayjs().format('YYYY-MM-DD');
    const date = prompt("퇴사 일자를 입력해주세요 (YYYY-MM-DD):", defaultDate);

    if (date === null) return; // 취소

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        alert("올바른 날짜 형식이 아닙니다.");
        return;
    }

    if (confirm("해당 직원을 퇴사 처리하시겠습니까? 퇴사 처리 된 직원은 [퇴사자] 탭에서 확인할 수 있습니다.")) {
        const { error } = await db.from('employees').update({ resignation_date: date }).eq('id', id);
        if (error) {
            alert('퇴사 처리 실패: ' + error.message);
        } else {
            alert('퇴사 처리가 완료되었습니다.');
            await window.loadAndRenderManagement();
        }
    }
};

window.handleRestoreEmployee = async function (id) {
    if (confirm("해당 직원을 복직 처리하시겠습니까? 다시 [재직자] 탭으로 이동됩니다.")) {
        const { error } = await db.from('employees').update({ resignation_date: null }).eq('id', id);
        if (error) {
            alert('복직 처리 실패: ' + error.message);
        } else {
            alert('복직 처리가 완료되었습니다.');
            await window.loadAndRenderManagement();
        }
    }
};

export function getManagementHTML() {
    const { employees, departments } = state.management;

    // 필터링
    const filteredEmployees = employees.filter(emp => {
        if (currentEmployeeFilter === 'active') {
            return !emp.resignation_date;
        } else {
            return emp.resignation_date;
        }
    });

    const departmentOptions = (currentDeptId = null) => {
        let options = departments.map(d => `<option value="${d.id}" ${d.id === currentDeptId ? 'selected' : ''}>${d.name}</option>`).join('');
        if (currentDeptId === null) {
            options = `<option value="" selected>-- 부서 선택 --</option>` + options;
        }
        return options;
    };

    const headers = [
        { name: '<input type="checkbox" id="selectAllCheckbox" class="cursor-pointer">', width: '5%' },
        { name: '이름', width: '15%' },
        { name: '부서', width: '15%' },
        { name: '입사일', width: '15%' },
        { name: '이메일', width: '20%' },
        { name: '비밀번호', width: '10%' },
        { name: filterLabel(), width: '8%' }, // 동적 헤더 (매니저/퇴사일)
        { name: '관리', width: '12%' }
    ];

    function filterLabel() {
        return currentEmployeeFilter === 'active' ? '매니저' : '퇴사일';
    }

    const headerHtml = headers.map(h => `<th class="p-2 text-left text-xs font-semibold" style="width: ${h.width};">${h.name}</th>`).join('');

    const rows = filteredEmployees.map(emp => {
        const entryDateValue = emp.entryDate ? dayjs(emp.entryDate).format('YYYY-MM-DD') : '';

        let managementButtons = '';
        if (currentEmployeeFilter === 'active') {
            managementButtons = `
                <button class="text-xs bg-blue-500 text-white px-2 py-1 rounded" onclick="handleUpdateEmployee(${emp.id})">저장</button> 
                <button class="text-xs px-2 py-1 rounded ml-1" style="background-color: #f97316; color: white;" onclick="handleRetireEmployee(${emp.id})">퇴사</button>
            `;
        } else {
            managementButtons = `
                <button class="text-xs bg-green-500 text-white px-2 py-1 rounded" onclick="handleRestoreEmployee(${emp.id})">복직</button>
                <button class="text-xs bg-red-500 text-white px-2 py-1 rounded ml-1" onclick="handleDeleteEmployee(${emp.id})">삭제</button>
            `;
        }

        const extraColumn = currentEmployeeFilter === 'active'
            ? `<input type="checkbox" id="manager-${emp.id}" ${emp.isManager ? 'checked' : ''} class="cursor-pointer w-4 h-4">`
            : `<span class="text-gray-500 text-xs">${emp.resignation_date || '-'}</span>`;

        return `<tr class="border-t">
            <td class="p-2 text-center"><input type="checkbox" class="employee-checkbox cursor-pointer" value="${emp.id}"></td>
            <td class="p-2"><input type="text" id="name-${emp.id}" value="${emp.name}" class="table-input"></td>
            <td class="p-2"><select id="dept-${emp.id}" class="table-input">${departmentOptions(emp.department_id)}</select></td>
            <td class="p-2"><input type="date" id="entry-${emp.id}" value="${entryDateValue}" class="table-input"></td>
            <td class="p-2"><input type="email" id="email-${emp.id}" value="${emp.email || ''}" class="table-input"></td>
            <td class="p-2 text-center"><button class="text-xs bg-gray-500 text-white px-2 py-1 rounded">재설정</button></td>
            <td class="p-2 text-center">${extraColumn}</td>
            <td class="p-2 text-center">${managementButtons}</td>
        </tr>`;
    }).join('');

    const newRow = currentEmployeeFilter === 'active' ? `
        <tr class="border-t bg-gray-50">
            <td class="p-2"></td>
            <td class="p-2"><input type="text" id="newName" class="table-input" placeholder="이름"></td>
            <td class="p-2">
                <select id="newDepartment" class="table-input">
                    ${departmentOptions(null)}
                </select>
            </td>
            <td class="p-2"><input type="date" id="newEntry" value="${dayjs().format('YYYY-MM-DD')}" class="table-input"></td>
            <td class="p-2"><input type="email" id="newEmail" class="table-input" placeholder="이메일"></td>
            <td class="p-2"><input type="password" id="newPassword" class="table-input" placeholder="초기 비밀번호"></td>
            <td class="p-2"></td>
            <td class="p-2 text-center"><button class="text-sm bg-green-600 text-white px-2 py-1 rounded w-full" onclick="handleAddEmployee()">추가</button></td>
        </tr>` : '';

    setTimeout(addManagementEventListeners, 0);

    return `
        <div class="flex justify-between items-center mb-3">
            <h2 class="text-lg font-semibold">직원 관리</h2>
            <div class="flex space-x-2">
                <button id="bulkDeleteBtn" class="text-sm bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 font-bold disabled:bg-gray-400 hidden" disabled>선택 삭제 (0)</button>
                <div class="flex bg-gray-200 rounded p-1" style="display: flex !important;">
                    <button id="filter-btn-active" onclick="window.toggleEmployeeFilter('active')" class="${currentEmployeeFilter === 'active' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'} px-3 py-1 text-sm rounded transition-colors" style="display: inline-block !important; ${currentEmployeeFilter === 'active' ? 'background-color: #2563eb; color: white;' : 'background-color: #e5e7eb; color: black;'}">[재직자]</button>
                    <button id="filter-btn-retired" onclick="window.toggleEmployeeFilter('retired')" class="${currentEmployeeFilter === 'retired' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'} px-3 py-1 text-sm rounded transition-colors ml-1" style="display: inline-block !important; ${currentEmployeeFilter === 'retired' ? 'background-color: #2563eb; color: white;' : 'background-color: #e5e7eb; color: black;'}">[퇴사자]</button>
                </div>
            </div>
        </div>
        <div class="overflow-x-auto">
            <table class="fixed-table whitespace-nowrap text-sm mb-6">
                <thead class="bg-gray-100"><tr>${headerHtml}</tr></thead>
                <tbody>${rows}</tbody>
                <tfoot>${newRow}</tfoot>
            </table>
        </div>
        ${currentEmployeeFilter === 'active' ? `
        <div class="flex justify-end mt-2">
             <button id="open-bulk-register-btn" class="text-sm bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 font-bold">엑셀 붙여넣기 대량 등록</button>
        </div>` : ''}
        `;
}

// =========================================================================================
// 부서 관리
// =========================================================================================

async function handleAddNewDepartment() {
    const nameInput = _('#new-dept-name');
    const name = nameInput.value.trim();
    if (!name) {
        alert('부서명을 입력하세요.');
        return;
    }
    const { error } = await db.from('departments').insert({ name });
    if (error) {
        alert('부서 추가 실패: ' + error.message);
    } else {
        nameInput.value = '';
        await window.loadAndRenderManagement();
    }
}

async function handleUpdateDepartment(id) {
    const name = _(`#dept-name-${id}`).value.trim();
    if (!name) {
        alert('부서명을 입력하세요.');
        return;
    }
    const { error } = await db.from('departments').update({ name }).eq('id', id);
    if (error) {
        alert('부서명 변경 실패: ' + error.message);
    } else {
        alert('부서명이 변경되었습니다.');
        await window.loadAndRenderManagement();
    }
}

async function handleDeleteDepartment(id) {
    if (confirm(`정말로 이 부서를 삭제하시겠습니까? 해당 부서의 직원들은 '부서 미지정' 상태가 됩니다.`)) {
        const { error: updateError } = await db.from('employees').update({ department_id: null }).eq('department_id', id);
        if (updateError) {
            alert('소속 직원 정보 변경 실패: ' + updateError.message);
            return;
        }
        const { error: deleteError } = await db.from('departments').delete().eq('id', id);
        if (deleteError) {
            alert('부서 삭제 실패: ' + deleteError.message);
        } else {
            await window.loadAndRenderManagement();
        }
    }
}

export function getDepartmentManagementHTML() {
    const { departments } = state.management;
    const rows = departments.map(dept => `
        <tr class="border-b">
            <td class="p-2">${dept.id}</td>
            <td class="p-2"><input type="text" id="dept-name-${dept.id}" class="table-input" value="${dept.name}"></td>
            <td class="p-2 text-center">
                <button onclick="handleUpdateDepartment(${dept.id})" class="text-xs bg-blue-500 text-white px-3 py-1 rounded">저장</button>
                <button onclick="handleDeleteDepartment(${dept.id})" class="text-xs bg-red-500 text-white px-3 py-1 rounded ml-2">삭제</button>
            </td>
        </tr>
    `).join('');

    return `
        <h2 class="text-lg font-semibold mb-4">부서 관리</h2>
        <table class="min-w-full text-sm mb-6">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-2 text-left w-16">ID</th>
                    <th class="p-2 text-left">부서명</th>
                    <th class="p-2 text-center w-32">관리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot class="bg-gray-50">
                <tr class="border-t">
                    <td class="p-2"></td>
                    <td class="p-2"><input type="text" id="new-dept-name" class="table-input" placeholder="새 부서명 입력"></td>
                    <td class="p-2 text-center">
                        <button onclick="handleAddNewDepartment()" class="text-sm bg-green-600 text-white px-4 py-1 rounded w-full">추가</button>
                    </td>
                </tr>
            </tfoot>
        </table>
    `;
}

// =========================================================================================
// 연차 신청 목록
// =========================================================================================

export function getLeaveListHTML() {
    const { leaveRequests, employees } = state.management;

    const employeeNameMap = employees.reduce((map, emp) => {
        const suffix = emp.resignation_date ? ' (퇴사)' : '';
        map[emp.id] = emp.name + suffix;
        return map;
    }, {});

    // 반려 제외
    const filteredRequests = leaveRequests.filter(req => req.status !== 'rejected');

    let rows = '';
    if (leaveRequests.length === 0) {
        rows = `<tr><td colspan="5" class="text-center text-gray-500 py-8">연차 신청 기록이 없습니다.</td></tr>`;
    } else {
        rows = filteredRequests.map(req => {
            const employeeName = employeeNameMap[req.employee_id] || '알 수 없음';

            // 최종 승인 상태
            const finalStatus = req.final_manager_status || 'pending';
            const finalText = {
                pending: '대기',
                approved: '승인',
                rejected: '반려'
            }[finalStatus] || '대기';
            const finalColor = {
                pending: 'text-yellow-600',
                approved: 'text-green-600',
                rejected: 'text-red-600'
            }[finalStatus] || 'text-yellow-600';

            // 매니저 승인 상태 (최종 승인이 완료된 경우 매니저 상태가 대기여도 생략/완료 처리된 것으로 표시)
            let middleStatus = req.middle_manager_status || 'pending';

            let middleText = '대기';
            let middleColor = 'text-yellow-600';

            // 1. DB 상태에 따른 기본 텍스트/색상 설정
            if (middleStatus === 'approved') {
                middleText = '승인';
                middleColor = 'text-green-600';
            } else if (middleStatus === 'rejected') {
                middleText = '반려';
                middleColor = 'text-red-600';
            } else if (middleStatus === 'skipped') {
                middleText = '생략';
                middleColor = 'text-gray-400 line-through';
            }

            // 2. UI 표시용 상태 오버라이드: 최종 처리가 끝났는데 매니저가 승인/반려 상태가 아니라면 '생략'으로 표시
            if (finalStatus !== 'pending' && middleStatus !== 'approved' && middleStatus !== 'rejected') {
                middleText = '생략';
                middleColor = 'text-gray-400 line-through';
                middleStatus = 'skipped';
            }

            // 버튼 표시 로직
            const currentUser = state.currentUser;
            let actions = '';

            if (finalStatus === 'rejected') {
                // 반려됨
                actions = `<span class="text-xs text-gray-400">반려됨</span>`;
            } else if (finalStatus === 'approved') {
                // 최종 승인 완료
                actions = `<span class="text-xs text-gray-400">승인완료</span>`;
            } else if (currentUser.role === 'admin') {
                // 관리자: 최종 승인/반려 버튼
                actions = `
                <button onclick="window.handleFinalApproval(${req.id}, 'approved')" class="text-xs bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700">승인</button>
                <button onclick="window.handleFinalApproval(${req.id}, 'rejected')" class="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 ml-1">반려</button>
            `;
            } else if (currentUser.isManager) {
                // 매니저
                if (middleStatus === 'pending') {
                    // 매니저 승인 대기 중
                    actions = `
                    <button onclick="window.handleMiddleApproval(${req.id}, 'approved')" class="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700">승인</button>
                    <button onclick="window.handleMiddleApproval(${req.id}, 'rejected')" class="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 ml-1">반려</button>
                `;
                } else {
                    // 이미 매니저가 처리함 (최종 승인 대기)
                    actions = `<span class="text-xs text-gray-400">최종승인 대기</span>`;
                }
            } else {
                actions = `<span class="text-xs text-gray-400">-</span>`;
            }

            const datesText = (req.dates || []).join(', ');
            const dateCount = req.dates?.length || 0;

            return `<tr class="border-b hover:bg-gray-50 leave-row" data-status="${finalStatus}" data-employee-id="${req.employee_id}">
            <td class="p-2 text-sm">${employeeName}</td>
            <td class="p-2 text-sm">${datesText}</td>
            <td class="p-2 text-sm text-center">${dateCount}일</td>
            <td class="p-2 text-sm text-center">
                <div class="text-xs">
                    <span class="inline-block w-12">매니저:</span>
                    <span class="${middleColor} font-semibold">${middleText}</span>
                </div>
                <div class="text-xs mt-1">
                    <span class="inline-block w-12">최종:</span>
                    <span class="${finalColor} font-semibold">${finalText}</span>
                </div>
            </td>
            <td class="p-2 text-center">${actions}</td>
        </tr>`;
        }).join('');
    }

    // 직원 목록 생성 (신청 기록이 있는 직원만)
    const employeeIds = [...new Set(filteredRequests.map(req => req.employee_id))];
    const employeeOptions = employeeIds.map(id => {
        const name = employeeNameMap[id] || '알 수 없음';
        const count = filteredRequests.filter(req => req.employee_id === id).length;
        return `<option value="${id}">${name} (${count}건)</option>`;
    }).join('');

    return `
        <h2 class="text-lg font-semibold mb-4">연차 신청 목록</h2>
        
        <!-- 필터 -->
        <div class="flex flex-wrap gap-2 mb-4 items-center">
            <div class="flex gap-2">
                <button onclick="window.filterLeaveList('all')" id="filter-all" class="filter-btn active px-3 py-1 text-sm rounded bg-blue-600 text-white">전체 (${filteredRequests.length})</button>
                <button onclick="window.filterLeaveList('pending')" id="filter-pending" class="filter-btn px-3 py-1 text-sm rounded bg-gray-200">최종 대기중 (${filteredRequests.filter(r => (r.final_manager_status || 'pending') === 'pending').length})</button>
                <button onclick="window.filterLeaveList('approved')" id="filter-approved" class="filter-btn px-3 py-1 text-sm rounded bg-gray-200">최종 승인됨 (${filteredRequests.filter(r => (r.final_manager_status || 'pending') === 'approved').length})</button>
            </div>
            <div class="flex gap-2 items-center ml-4">
                <label class="text-sm font-semibold">직원:</label>
                <select id="employee-filter" onchange="window.filterByEmployee(this.value)" class="text-sm border rounded px-2 py-1">
                    <option value="all">전체 직원</option>
                    ${employeeOptions}
                </select>
            </div>
        </div>
        
        <!-- 테이블 보기 -->
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
        
        <!-- 달력 보기 -->
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

    const activeBtn = _(`#filter-${status}`);
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

    const activeBtn = _(`#cal-filter-${status}`);
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
                alert(`이미 승인된 연차입니다.\n\n직원: ${props.employeeName}\n날짜: ${info.event.start.toLocaleDateString('ko-KR')}`);
                return;
            }

            const message = `직원: ${props.employeeName}
날짜: ${info.event.start.toLocaleDateString('ko-KR')}
사유: ${props.reason || '없음'}
신청일: ${dayjs(props.createdAt).format('YYYY-MM-DD HH:mm')}

승인하시겠습니까?`;

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
            errors.push(`- ${index + 1}번째 줄: 필수 항목(이름, 입사일, 비밀번호, 부서명)이 누락되었습니다.`);
            return;
        }

        const department_id = departmentNameToIdMap.get(departmentName);
        if (!department_id) {
            errors.push(`- ${index + 1}번째 줄 (${name}): 존재하지 않는 부서명입니다. ('${departmentName}')`);
            return;
        }

        employeesToInsert.push({ name, entryDate, email, password, department_id });
    });

    if (employeesToInsert.length > 0) {
        const { error } = await db.from('employees').insert(employeesToInsert);
        if (error) {
            errors.push(`데이터베이스 저장 실패: ${error.message}`);
        }
    }

    let resultMessage = `총 ${lines.length}건 중 ${employeesToInsert.length}건 성공 / ${errors.length}건 실패\n\n`;
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
        { name: '조정', width: '7%' },
        { name: '확정', width: '5%' },
        { name: '사용', width: '5%' },
        { name: '잔여', width: '5%' },
        { name: '이월 예정', width: '22%' },
        { name: '관리', width: '10%' }
    ];

    const headerHtml = headers.map(h => `<th class="p-2 text-left text-xs font-semibold" style="width: ${h.width};">${h.name}</th>`).join('');

    const rows = employees.map(emp => {
        const leaveData = getLeaveDetails(emp);
        const used = leaveRequests.filter(r => r.employee_id === emp.id && r.status === 'approved').reduce((sum, r) => sum + (r.dates?.length || 0), 0);
        const remaining = leaveData.final - used;

        // 다음 갱신일 계산
        const baseDate = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date) : dayjs(emp.entryDate).add(1, 'year');
        const renewalThisYear = dayjs(`${dayjs().year()}-${baseDate.format('MM-DD')}`);
        const nextRenewalDate = renewalThisYear.isAfter(dayjs()) ? renewalThisYear.format('YYYY-MM-DD') : renewalThisYear.add(1, 'year').format('YYYY-MM-DD');

        const entryDateValue = emp.entryDate ? dayjs(emp.entryDate).format('YYYY-MM-DD') : '';
        const renewalDateValue = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date).format('YYYY-MM-DD') : '';
        const workDaysValue = emp.work_days_per_week || 5;

        return `<tr class="border-t">
            <td class="p-2 text-sm font-semibold">${emp.name}</td>
            <td class="p-2 text-sm">${entryDateValue}</td>
            <td class="p-2">
                <select id="leave-workdays-${emp.id}" class="table-input text-center text-xs w-16">
                    <option value="1" ${workDaysValue === 1 ? 'selected' : ''}>주1일</option>
                    <option value="2" ${workDaysValue === 2 ? 'selected' : ''}>주2일</option>
                    <option value="3" ${workDaysValue === 3 ? 'selected' : ''}>주3일</option>
                    <option value="4" ${workDaysValue === 4 ? 'selected' : ''}>주4일</option>
                    <option value="5" ${workDaysValue === 5 ? 'selected' : ''}>주5일</option>
                    <option value="6" ${workDaysValue === 6 ? 'selected' : ''}>주6일</option>
                    <option value="7" ${workDaysValue === 7 ? 'selected' : ''}>주7일</option>
                </select>
            </td>
            </td>
            <td class="p-2"><input type="date" id="leave-renewal-${emp.id}" value="${renewalDateValue}" class="table-input text-xs"></td>
            <td class="p-2 text-sm text-center" id="leave-next-renewal-${emp.id}">${nextRenewalDate}</td>
            <td class="p-2 text-sm text-center">${leaveData.legal}</td>
            <td class="p-2"><input type="number" id="leave-adj-${emp.id}" value="${leaveData.adjustment || 0}" class="table-input text-center text-xs w-16"></td>
            <td class="p-2 text-sm text-center font-bold">${leaveData.final}</td>
            <td class="p-2 text-sm text-center">${used}</td>
            <td class="p-2 text-sm text-center font-bold ${remaining < 0 ? 'text-red-600' : ''}">${remaining}</td>
            <td class="p-2 text-xs text-gray-600">${leaveData.note || '-'}</td>
            <td class="p-2 text-center">
                <button class="text-xs bg-blue-500 text-white px-2 py-1 rounded" onclick="handleUpdateLeave(${emp.id})">저장</button>
            </td>
        </tr>`;
    }).join('');

    return `
        <div class="mb-3">
            <h2 class="text-lg font-semibold">연차 관리</h2>
            <p class="text-sm text-gray-600 mt-1">직원별 연차 기준일과 조정값을 관리합니다. 법정 연차는 주5일 기준으로 계산 후 근무일수에 비례 적용됩니다.</p>
        </div>
        <div class="overflow-x-auto">
            <table class="fixed-table whitespace-nowrap text-sm mb-6">
                <thead class="bg-gray-100"><tr>${headerHtml}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// 연차 정보 업데이트
window.handleUpdateLeave = async function (id) {
    const leave_renewal_date = _(`#leave-renewal-${id}`).value || null;
    const leave_adjustment = parseInt(_(`#leave-adj-${id}`).value) || 0;
    const work_days_per_week = parseInt(_(`#leave-workdays-${id}`).value) || 5;

    console.log('💾 연차 업데이트:', { id, leave_renewal_date, leave_adjustment, work_days_per_week });

    const { data, error } = await db.from('employees').update({
        leave_renewal_date,
        leave_adjustment,
        work_days_per_week
    }).eq('id', id).select();

    console.log('✅ DB 응답:', { data, error });

    if (error) {
        alert('연차 정보 업데이트 실패: ' + error.message);
    } else {
        alert('연차 정보가 성공적으로 저장되었습니다.');
        await window.loadAndRenderManagement();
    }
};
// =========================================================================================
// 연차 현황 기능
// =========================================================================================

export function getLeaveStatusHTML() {
    const { employees, leaveRequests } = state.management;

    // 각 직원의 연차 데이터 수집
    const employeeLeaveData = employees.map(emp => {
        const leaveDetails = getLeaveDetails(emp);
        const usedDays = leaveRequests
            .filter(req => req.employee_id === emp.id && req.status === 'approved')
            .reduce((sum, req) => sum + (req.dates?.length || 0), 0);

        const usedDates = leaveRequests
            .filter(req => req.employee_id === emp.id && req.status === 'approved')
            .flatMap(req => req.dates || [])
            .sort();

        const remainingDays = leaveDetails.final - usedDays;
        const usagePercent = leaveDetails.final > 0 ? Math.round((usedDays / leaveDetails.final) * 100) : 0;

        return {
            ...emp,
            leaveDetails,
            usedDays,
            remainingDays,
            usagePercent,
            usedDates
        };
    });

    // 부서별 필터링을 위한 부서 목록
    const departments = [...new Set(employees.map(e => e.dept || e.departments?.name).filter(Boolean))];

    return `
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
            
            <div class="leave-status-table-wrapper">
                <table class="leave-status-table">
                    <thead>
                        <tr>
                            <th>이름</th>
                            <th>부서</th>
                            <th>입사일</th>
                            <th>확정연차</th>
                            <th>사용연차</th>
                            <th>잔여연차</th>
                            <th>사용 현황</th>
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
    const progressColor = emp.usagePercent <= 30 ? 'bg-green-500' :
        emp.usagePercent <= 70 ? 'bg-yellow-500' :
            emp.usagePercent <= 90 ? 'bg-orange-500' : 'bg-red-500';

    const deptName = emp.dept || emp.departments?.name || '-';
    const formattedDates = emp.usedDates.map(d => dayjs(d).format('M/D')).join(', ');
    const dateDisplay = emp.usedDates.length > 0 ? formattedDates : '사용 내역 없음';

    return `
        <tr class="leave-status-row" data-dept="${deptName}" data-remaining="${emp.remainingDays}" data-usage="${emp.usagePercent}">
            <td class="font-semibold">${emp.name}</td>
            <td>${deptName}</td>
            <td>${dayjs(emp.entryDate).format('YY.MM.DD')}</td>
            <td class="text-center font-bold">${emp.leaveDetails.final}</td>
            <td class="text-center">${emp.usedDays}</td>
            <td class="text-center font-bold ${emp.remainingDays <= 3 ? 'text-red-600' : ''}">${emp.remainingDays}</td>
            <td class="leave-progress-cell">
                <div class="progress-bar-container">
                    <div class="progress-bar ${progressColor}" style="width: ${emp.usagePercent}%"></div>
                    <span class="progress-text">${emp.usagePercent}%</span>
                </div>
                <button class="toggle-dates-btn text-xs text-blue-600 mt-1" data-emp-id="${emp.id}">
                    ▼ 상세 보기
                </button>
                <div class="used-dates-detail hidden" id="dates-${emp.id}">
                    <div class="text-xs text-gray-600 mt-2 p-2 bg-gray-50 rounded">
                        ${dateDisplay}
                    </div>
                </div>
            </td>
        </tr>
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

    // 상세 보기 토글
    document.querySelectorAll('.toggle-dates-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const empId = e.target.dataset.empId;
            const detailDiv = document.getElementById(`dates-${empId}`);
            if (detailDiv) {
                detailDiv.classList.toggle('hidden');
                e.target.textContent = detailDiv.classList.contains('hidden') ? '▼ 상세 보기' : '▲ 접기';
            }
        });
    });
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