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
    window.handleResetPassword = handleResetPassword;
    window.handleUpdateLeave = handleUpdateLeave;
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

window.handleResetPassword = async function (id) {
    const newPassword = prompt("새로운 비밀번호를 입력해주세요:");
    if (!newPassword) return; // 취소 또는 빈 값

    const { error } = await db.from('employees').update({ password: newPassword }).eq('id', id);

    if (error) {
        alert('비밀번호 변경 실패: ' + error.message);
    } else {
        alert('비밀번호가 성공적으로 변경되었습니다.');
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

function departmentOptions(selectedId) {
    const { departments } = state.management;
    return departments.map(d => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${d.name}</option>`).join('');
}

export function getManagementHTML() {
    const { employees } = state.management;
    const filter = currentEmployeeFilter; // 'active' or 'retired'

    // Filter employees
    const filteredEmployees = employees.filter(emp => {
        if (filter === 'active') return !emp.resignation_date;
        if (filter === 'retired') return emp.resignation_date;
        return true;
    });

    const headerHtml = `
        <th class="p-2 w-10"><input type="checkbox" id="selectAllCheckbox"></th>
        <th class="p-2 text-left">이름</th>
        <th class="p-2 w-48 text-left">부서</th>
        <th class="p-2 text-left">입사일</th>
        <th class="p-2 text-left">이메일</th>
        <th class="p-2 text-center w-20">매니저</th>
        <th class="p-2 text-center w-48">관리</th>
    `;

    const rows = filteredEmployees.map(emp => {
        const deptOptions = departmentOptions(emp.department_id);
        const isManagerChecked = emp.isManager ? 'checked' : '';

        let actions = '';
        if (filter === 'active') {
            actions = `
                <button onclick="handleUpdateEmployee(${emp.id})" class="text-xs bg-blue-500 text-white px-2 py-1 rounded">저장</button>
                <button onclick="handleRetireEmployee(${emp.id})" class="text-xs bg-gray-500 text-white px-2 py-1 rounded ml-1">퇴사</button>
                <button onclick="handleResetPassword(${emp.id})" class="text-xs bg-yellow-500 text-white px-2 py-1 rounded ml-1">재설정</button>
                <button onclick="handleDeleteEmployee(${emp.id})" class="text-xs bg-red-500 text-white px-2 py-1 rounded ml-1">삭제</button>
             `;
        } else {
            actions = `
                <button onclick="handleRestoreEmployee(${emp.id})" class="text-xs bg-green-500 text-white px-3 py-1 rounded">복직</button>
                <button onclick="handleDeleteEmployee(${emp.id})" class="text-xs bg-red-500 text-white px-3 py-1 rounded ml-1">삭제</button>
             `;
        }

        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-2 text-center"><input type="checkbox" class="employee-checkbox" value="${emp.id}"></td>
                <td class="p-2"><input type="text" id="name-${emp.id}" class="table-input" value="${emp.name}"></td>
                <td class="p-2">
                    <select id="dept-${emp.id}" class="table-input">
                        ${deptOptions}
                    </select>
                </td>
                <td class="p-2"><input type="date" id="entry-${emp.id}" class="table-input" value="${emp.entryDate}"></td>
                <td class="p-2"><input type="email" id="email-${emp.id}" class="table-input" value="${emp.email}"></td>
                <td class="p-2 text-center"><input type="checkbox" id="manager-${emp.id}" ${isManagerChecked}></td>
                <td class="p-2 text-center">${actions}</td>
            </tr>
        `;
    }).join('');

    const newRow = filter === 'active' ? `
        <tr class="border-t bg-gray-50">
            <td class="p-2"></td>
            <td class="p-2"><input type="text" id="newName" class="table-input" placeholder="이름"></td>
            <td class="p-2">
                <select id="newDepartment" class="table-input">
                    <option value="">부서 선택</option>
                    ${departmentOptions(null)}
                </select>
            </td>
            <td class="p-2"><input type="date" id="newEntry" value="${dayjs().format('YYYY-MM-DD')}" class="table-input"></td>
            <td class="p-2"><input type="email" id="newEmail" class="table-input" placeholder="이메일"></td>
            <td class="p-2" colspan="2">
                <div class="flex gap-2">
                    <input type="password" id="newPassword" class="table-input" placeholder="초기 비밀번호">
                    <button class="text-sm bg-green-600 text-white px-4 py-1 rounded w-full" onclick="handleAddEmployee()">추가</button>
                </div>
            </td>
        </tr>` : '';

    setTimeout(addManagementEventListeners, 0);

    return `
        <div class="flex justify-between items-center mb-3">
            <h2 class="text-lg font-semibold">직원 관리</h2>
            <div class="flex space-x-2">
                <button id="bulkDeleteBtn" class="text-sm bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 font-bold disabled:bg-gray-400 hidden" disabled>선택 삭제 (0)</button>
                <div class="flex bg-gray-200 rounded p-1" style="display: flex !important;">
                    <button id="filter-btn-active" onclick="window.toggleEmployeeFilter('active')" class="${filter === 'active' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'} px-3 py-1 text-sm rounded transition-colors" style="display: inline-block !important; ${filter === 'active' ? 'background-color: #2563eb; color: white;' : 'background-color: #e5e7eb; color: black;'}">[재직자]</button>
                    <button id="filter-btn-retired" onclick="window.toggleEmployeeFilter('retired')" class="${filter === 'retired' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'} px-3 py-1 text-sm rounded transition-colors ml-1" style="display: inline-block !important; ${filter === 'retired' ? 'background-color: #2563eb; color: white;' : 'background-color: #e5e7eb; color: black;'}">[퇴사자]</button>
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
        ${filter === 'active' ? `
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
    if (confirm(`정말로 이 부서를 삭제하시겠습니까 ? 해당 부서의 직원들은 '부서 미지정' 상태가 됩니다.`)) {
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
        <tr class="border-b" >
            <td class="p-2">${dept.id}</td>
            <td class="p-2"><input type="text" id="dept-name-${dept.id}" class="table-input" value="${dept.name}"></td>
            <td class="p-2 text-center">
                <button onclick="handleUpdateDepartment(${dept.id})" class="text-xs bg-blue-500 text-white px-3 py-1 rounded">저장</button>
                <button onclick="handleDeleteDepartment(${dept.id})" class="text-xs bg-red-500 text-white px-3 py-1 rounded ml-2">삭제</button>
            </td>
        </tr>
        `).join('');

    return `
        <h2 class="text-lg font-semibold mb-4" > 부서 관리</h2>
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

    // 모든 신청 내역 표시 (반려 포함)
    const filteredRequests = leaveRequests;

    let rows = '';
    if (filteredRequests.length === 0) {
        rows = `<tr ><td colspan="5" class="text-center text-gray-500 py-8">표시할 연차 신청 기록이 없습니다.</td></tr> `;
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
                actions = `<span class="text-xs text-red-400" >반려됨</span> `;
            } else if (finalStatus === 'approved') {
                // 최종 승인 완료
                actions = `<span class="text-xs text-green-600" >승인완료</span> `;
            } else if (currentUser.role === 'admin') {
                // 관리자: 최종 승인/반려 버튼
                actions = `
        <button onclick = "window.handleFinalApproval(${req.id}, 'approved')" class="text-xs bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700" > 승인</button >
            <button onclick="window.handleFinalApproval(${req.id}, 'rejected')" class="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 ml-1">반려</button>
    `;
            } else if (currentUser.isManager) {
                // 매니저
                if (middleStatus === 'pending') {
                    // 매니저 승인 대기 중
                    actions = `
        <button onclick = "window.handleMiddleApproval(${req.id}, 'approved')" class="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700" > 승인</button >
            <button onclick="window.handleMiddleApproval(${req.id}, 'rejected')" class="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 ml-1">반려</button>
    `;
                } else {
                    // 이미 매니저가 처리함 (최종 승인 대기)
                    actions = `<span class="text-xs text-gray-400" > 최종승인 대기</span> `;
                }
            } else {
                actions = `<span class="text-xs text-gray-400" > -</span> `;
            }

            const datesText = (req.dates || []).join(', ');
            const dateCount = req.dates?.length || 0;

            return `<tr class="border-b hover:bg-gray-50 leave-row" data-status="${finalStatus}" data-employee-id="${req.employee_id}" >
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
        </tr> `;
        }).join('');
    }

    // 직원 목록 생성 (신청 기록이 있는 직원만)
    const employeeIds = [...new Set(filteredRequests.map(req => req.employee_id))];
    const employeeOptions = employeeIds.map(id => {
        const name = employeeNameMap[id] || '알 수 없음';
        const count = filteredRequests.filter(req => req.employee_id === id).length;
        return `<option value = "${id}" > ${name} (${count}건)</option > `;
    }).join('');

    return `
        <h2 class="text-lg font-semibold mb-4">연차 신청 목록</h2>
        
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
                alert(`이미 승인된 연차입니다.\n\n직원: ${props.employeeName} \n날짜: ${info.event.start.toLocaleDateString('ko-KR')} `);
                return;
            }

            const message = `직원: ${props.employeeName}
    날짜: ${info.event.start.toLocaleDateString('ko-KR')}
    사유: ${props.reason || '없음'}
    신청일: ${dayjs(props.createdAt).format('YYYY-MM-DD HH:mm')}

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
            errors.push(`- ${index + 1}번째 줄: 필수 항목(이름, 입사일, 비밀번호, 부서명)이 누락되었습니다.`);
            return;
        }

        const department_id = departmentNameToIdMap.get(departmentName);
        if (!department_id) {
            errors.push(`- ${index + 1}번째 줄(${name}): 존재하지 않는 부서명입니다. ('${departmentName}')`);
            return;
        }

        employeesToInsert.push({ name, entryDate, email, password, department_id });
    });

    if (employeesToInsert.length > 0) {
        const { error } = await db.from('employees').insert(employeesToInsert);
        if (error) {
            errors.push(`데이터베이스 저장 실패: ${error.message} `);
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
        { name: '전년 이월', width: '7%' }, // 명칭 변경: 이월 -> 전년 이월
        { name: '조정', width: '7%' },
        { name: '확정', width: '5%' },
        { name: '사용', width: '5%' },
        { name: '잔여', width: '5%' },
        { name: '갱신 안내 (이월 예정)', width: '15%' }, // 명칭 변경: 이월 예정 -> 갱신 안내
        { name: '관리', width: '10%' }
    ];

    const headerHtml = headers.map(h => `<th class="p-2 text-left text-xs font-semibold" style = "width: ${h.width};" > ${h.name}</th> `).join('');

    const rows = employees.map(emp => {
        const leaveData = getLeaveDetails(emp);

        // 중요: 현재 연차 주기에 해당하는 승인된 연차만 합산
        const pStart = dayjs(leaveData.periodStart);
        const pEnd = dayjs(leaveData.periodEnd);

        const used = leaveRequests
            .filter(r => r.employee_id === emp.id && r.status === 'approved')
            .reduce((sum, r) => {
                // 신청일(dates) 중 현재 주기에 속하는 날짜만 카운트
                const validDates = (r.dates || []).filter(dateStr => {
                    const d = dayjs(dateStr);
                    return d.isSameOrAfter(pStart) && d.isSameOrBefore(pEnd);
                });
                return sum + validDates.length;
            }, 0);

        const remaining = leaveData.final - used;

        // 다음 갱신일 계산
        const baseDate = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date) : dayjs(emp.entryDate).add(1, 'year');
        const renewalThisYear = dayjs(`${dayjs().year()} -${baseDate.format('MM-DD')} `);
        const nextRenewalDate = renewalThisYear.isAfter(dayjs()) ? renewalThisYear.format('YYYY-MM-DD') : renewalThisYear.add(1, 'year').format('YYYY-MM-DD');

        const entryDateValue = emp.entryDate ? dayjs(emp.entryDate).format('YYYY-MM-DD') : '';
        const renewalDateValue = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date).format('YYYY-MM-DD') : '';
        const workDaysValue = emp.work_days_per_week || 5;

        return `<tr class="border-t" >
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
            </td >
            <td class="p-2"><input type="date" id="leave-renewal-${emp.id}" value="${renewalDateValue}" class="table-input text-xs"></td>
            <td class="p-2 text-sm text-center" id="leave-next-renewal-${emp.id}">${nextRenewalDate}</td>
            <td class="p-2 text-sm text-center">${leaveData.legal}</td>
            <td class="p-2"><input type="number" id="leave-carried-${emp.id}" value="${leaveData.carriedOverCnt || 0}" step="0.5" class="table-input text-center text-xs w-16"></td>
            <td class="p-2"><input type="number" id="leave-adj-${emp.id}" value="${leaveData.adjustment || 0}" step="0.5" class="table-input text-center text-xs w-16"></td>
            <td class="p-2 text-sm text-center font-bold">${leaveData.final}</td>
            <td class="p-2 text-sm text-center">${used}</td>
            <td class="p-2 text-sm text-center font-bold ${remaining < 0 ? 'text-red-600' : ''}">${remaining}</td>
            <td class="p-2 text-xs text-gray-600">${leaveData.note || '-'}</td>
            <td class="p-2 text-center">
                <button class="text-xs bg-blue-500 text-white px-2 py-1 rounded" onclick="handleUpdateLeave(${emp.id})">저장</button>
                <button class="text-xs bg-purple-500 text-white px-2 py-1 rounded ml-1" onclick="window.openSettlementModal(${emp.id})">정산</button>
            </td>
        </tr> `;
    }).join('');

    return `
        <div class="mb-3" >
            <h2 class="text-lg font-semibold">연차 관리</h2>
            <div class="flex justify-between items-end">
                <p class="text-sm text-gray-600 mt-1">직원별 연차 기준일과 조정값을 관리합니다. [정산] 버튼을 통해 이월 또는 수당 정산을 처리할 수 있습니다.</p>
            </div>
        </div>
        <div class="overflow-x-auto">
            <table class="fixed-table whitespace-nowrap text-sm mb-6">
                <thead class="bg-gray-100"><tr>${headerHtml}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        
        <!-- 연차 정산 모달 -->
        <div id="settlement-modal" class="modal-overlay hidden">
            <div class="modal-content">
                <div class="flex justify-between items-center border-b pb-3 mb-4">
                    <h2 class="text-xl font-bold">연차 정산 및 갱신</h2>
                    <button id="close-settlement-modal-btn" class="text-3xl">&times;</button>
                </div>
                <div id="settlement-modal-body" class="space-y-4">
                    <!-- 동적 콘텐츠 -->
                </div>
            </div>
        </div>
    `;
}

// 정산 모달 열기
window.openSettlementModal = function (empId) {
    const emp = state.management.employees.find(e => e.id === empId);
    if (!emp) return;

    const leaveData = getLeaveDetails(emp);

    // 모달에서도 동일하게 기간 필터링 적용
    const pStart = dayjs(leaveData.periodStart);
    const pEnd = dayjs(leaveData.periodEnd);

    const used = state.management.leaveRequests
        .filter(r => r.employee_id === emp.id && r.status === 'approved')
        .reduce((sum, r) => {
            const validDates = (r.dates || []).filter(dateStr => {
                const d = dayjs(dateStr);
                return d.isSameOrAfter(pStart) && d.isSameOrBefore(pEnd);
            });
            return sum + validDates.length;
        }, 0);

    const remaining = leaveData.final - used;

    // 계산 로직
    // 잔여 > 0: 이월 or 정산
    // 잔여 < 0: 차감 이월 or 탕감

    const isNegative = remaining < 0;
    const absRemaining = Math.abs(remaining);

    const modalBody = _('#settlement-modal-body');
    modalBody.innerHTML = `
        <div class="bg-gray-100 p-3 rounded mb-4">
            <p><strong>직원명:</strong> ${emp.name}</p>
            <p><strong>현재 잔여 연차:</strong> <span class="text-lg font-bold ${isNegative ? 'text-red-600' : 'text-blue-600'}">${remaining}일</span></p>
            <p class="text-sm text-gray-500 mt-1">
                ${isNegative ?
            `초과 사용 ${absRemaining}일이 있습니다. 내년 연차에서 차감하거나 탕감할 수 있습니다.` :
            `미사용 연차 ${absRemaining}일이 있습니다. 이월하거나 수당으로 정산(소멸)할 수 있습니다.`}
            </p>
        </div>

        <form id="settlement-form">
            <input type="hidden" id="settlement-emp-id" value="${emp.id}">
            <input type="hidden" id="settlement-remaining" value="${remaining}">
            
            <label class="block font-semibold mb-2">처리 방식 선택</label>
            <div class="space-y-2">
                ${isNegative ? `
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="deduct_next" checked>
                        <div>
                            <span class="font-bold text-red-600">차감 이월</span>
                            <p class="text-xs text-gray-500">내년도 이월 연차에서 ${absRemaining}일을 뺍니다. (마이너스 이월)</p>
                        </div>
                    </label>
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="write_off">
                        <div>
                            <span class="font-bold text-gray-600">탕감 (초기화)</span>
                            <p class="text-xs text-gray-500">초과 사용분을 0으로 만듭니다. (페널티 없음)</p>
                        </div>
                    </label>
                ` : `
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="carry_over" checked>
                        <div>
                            <span class="font-bold text-blue-600">이월 처리</span>
                            <p class="text-xs text-gray-500">현재 이월 연차에 ${absRemaining}일을 더합니다.</p>
                        </div>
                    </label>
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="cash_out">
                        <div>
                            <span class="font-bold text-green-600">수당 정산 (소멸)</span>
                            <p class="text-xs text-gray-500">연차를 0으로 초기화합니다. (별도 급여 대장 등에 기록 필요)</p>
                        </div>
                    </label>
                `}
            </div>

            <div class="mt-4">
                <label class="block font-semibold mb-1">메모 (선택)</label>
                <input type="text" id="settlement-memo" class="w-full border p-2 rounded" placeholder="예: 2025년도 연차 정산">
            </div>

            <div class="flex justify-end pt-4 mt-2 border-t space-x-2">
                <button type="button" class="px-4 py-2 bg-gray-300 rounded" onclick="window.closeSettlementModal()">취소</button>
                <button type="submit" class="px-4 py-2 bg-blue-600 text-white rounded font-bold">처리하기</button>
            </div>
        </form>
    `;

    show('#settlement-modal');

    // 이벤트 리스너 (한번만 등록되도록 처리하거나 매번 덮어쓰기)
    const form = _('#settlement-form');
    form.onsubmit = window.handleSettlementSubmit;
};

window.closeSettlementModal = function () {
    hide('#settlement-modal');
};

_('#close-settlement-modal-btn')?.addEventListener('click', window.closeSettlementModal);

// 정산 처리 로직
window.handleSettlementSubmit = async function (e) {
    e.preventDefault();

    const empId = parseInt(_('#settlement-emp-id').value);
    const remaining = parseFloat(_('#settlement-remaining').value);
    const type = document.querySelector('input[name="settlementType"]:checked').value;
    const memo = _('#settlement-memo').value;

    const emp = state.management.employees.find(e => e.id === empId);
    let newCarriedOver = emp.carried_over_leave || 0;

    // 로직 적용
    if (type === 'carry_over') {
        newCarriedOver += remaining;
    } else if (type === 'deduct_next') {
        // remaining이 음수이므로 더하면 됨 (예: -2를 더하면 이월이 2 줄어듦)
        newCarriedOver += remaining;
    }
    // cash_out 이나 write_off는 이월 연차를 변경하지 않음 (단, 기존 이월분이 정산 대상에 포함된다면 로직이 복잡해질 수 있으나, 
    // 여기서는 '잔여' 전체를 처리한다고 가정. 
    // 하지만 보통 '정산'은 '올해 발생분'을 없애는 것이므로 '이월'값은 그대로 두거나, '이월'값도 갱신해야 함.
    // **단순화**: 이 기능은 '잔여 연차'를 '이월 연차' 컬럼으로 옮기거나 없애는 역할.
    // 문제는 '잔여'에는 '올해 발생분(legal)'도 포함되어 있다는 점.
    // '정산' 후에는 잔여가 0이 되어야 하므로, 
    // 1. 조정(adjustment)을 마이너스 처리해서 0으로 맞추거나 
    // 2. 관리자가 '내년도 세팅'을 할 때 쓴다고 가정.

    // 사용자의 요구: "매년 갱신시... 처리하는 방식"
    // 가장 깔끔한 방식: 
    // 1. 이월 처리 시: carried_over_leave += 잔여. (그리고 잔여를 0으로 만들기 위해, 사실상 '새 해'가 되면 legal이 리셋되거나 해야함. 
    //    하지만 legal은 입사일 기준 자동 계산됨. 따라서 '지난 해 잔여'를 '새 해 이월'로 넘기는 것이므로
    //    DB 상 carried_over_leave를 업데이트하고, **과거 사용 기록**은 보존하되 영향력을 없애야 함? 
    //    아님. 보통 시스템은 '회계연도 마감'을 함.
    //    
    //    **현실적 구현**: 
    //    이 앱은 '사용 기록'(`leaveRequests`) 전체를 누적해서 계산함 (`used` = 전체 승인 건수).
    //    따라서 갱신을 하려면 '과거 사용 기록'을 '아카이브' 하거나,
    //    calculation 로직에서 '특정 기준일 이후'의 사용분만 계산해야 함.

    //    **중요 수정**: `leave-utils.js`나 `getLeaveDetails`가 '전체 기간'을 대상으로 하면 갱신 처리가 불가능함.
    //    -> `leave_renewal_date` (연차 기준일)이 있음.
    //    `getLeaveDetails` 로직을 보면:
    //    "입사 1년 이상... 주기 시작 ~ 주기 끝"
    //    **다행히** `getLeaveDetails`는 이미 '현재 주기(Period)'에 해당하는 연차만 계산하고 있음? (확인 필요)

    //    확인 결과: `getLeaveDetails`는 근속연수에 따른 '법정 연차 개수'만 리턴함. 
    //    그런데 `used` 계산(`management.js` 1097라인)은 `leaveRequests.filter...`로 **전체 기간**을 다 더하고 있음!
    //    이게 문제임. 갱신을 하려면 **'현재 주기(이번 년도)'에 사용한 연차**만 카운트해야 함.

    //    **따라서 정산 기능을 완벽히 하려면**:
    //    1. `used` 계산 시 '현재 연차 주기'에 속하는 날짜만 필터링해야 함.
    //    2. 그렇게 하면, '지난 주기'의 잔여 연차는 자동으로 사라짐(계산에서 제외되므로).
    //    3. 그때 '이월' 버튼을 누르면 -> '지난 주기 잔여'를 구해 `carried_over_leave`에 더해줌.

    //    **전략 수정**:
    //    먼저 `used` 계산 로직을 '현재 주기' 기준으로 수정해야 함. (이번 Task 범위에 포함)

    // 일단 여기서는 DB 업데이트 부분만 작성하고, 아래 코드 블록 이후에 `used` 계산 로직을 수정하겠음.

    try {
        const { error } = await db.from('employees').update({
            carried_over_leave: newCarriedOver,
            // 정산(소멸)의 경우, 단순히 carried_over를 업데이트 안하면 됨. (왜냐하면 다음 주기 계산 시 지난 주기는 무시되니까)
            // 하지만 '마이너스 차감'은 carried_over를 깎아야 함 (-값 허용).
        }).eq('id', empId);

        if (error) throw error;

        // 정산 이력 기록 (issues 테이블이나 별도 로그 테이블 활용, 여기서는 로그만)
        console.log(`정산 완료: ${emp.name}, 타입: ${type}, 잔여: ${remaining} -> 처리됨`);

        alert(`정산 처리가 완료되었습니다.\n(${type === 'deduct_next' ? '차감 이월' : (type === 'carry_over' ? '이월' : '초기화')})`);
        window.closeSettlementModal();
        await window.loadAndRenderManagement();

    } catch (err) {
        console.error(err);
        alert('처리 중 오류가 발생했습니다: ' + err.message);
    }
};

// =========================================================================================
// 연차 현황 기능
window.handleUpdateLeave = async function (id) {
    const leave_renewal_date = _(`#leave-renewal-${id}`).value || null;
    const leave_adjustment = parseFloat(_(`#leave-adj-${id}`).value) || 0;
    const carried_over_leave = parseFloat(_(`#leave-carried-${id}`).value) || 0;
    const work_days_per_week = parseInt(_(`#leave-workdays-${id}`).value) || 5;

    console.log('💾 연차 업데이트:', { id, leave_renewal_date, leave_adjustment, carried_over_leave, work_days_per_week });

    const { data, error } = await db.from('employees').update({
        leave_renewal_date,
        leave_adjustment,
        carried_over_leave, // 이월 연차 추가
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
        const pStart = dayjs(leaveDetails.periodStart);
        const pEnd = dayjs(leaveDetails.periodEnd);

        const usedRequests = leaveRequests
            .filter(req => req.employee_id === emp.id && req.status === 'approved');

        // 사용한 날짜들을 모두 수집하여 평탄화 및 정렬
        let usedDates = usedRequests
            .flatMap(req => {
                return (req.dates || [])
                    .filter(dateStr => {
                        const d = dayjs(dateStr);
                        return d.isSameOrAfter(pStart) && d.isSameOrBefore(pEnd);
                    })
                    .map(date => ({
                        date: date,
                        // '수동'이라는 단어가 포함되어 있으면 manual로 처리 (유연성 확보)
                        type: (req.reason && req.reason.includes('수동')) ? 'manual' : 'formal',
                        requestId: req.id
                    }));
            })
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        const usedDays = usedDates.length;
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
        <style>
            .leave-grid-container {
                display: flex;
                flex-wrap: nowrap; /* 줄바꿈 방지 */
                gap: 4px;
                overflow-x: auto; /* 내용이 넘치면 스크롤 */
                padding-bottom: 4px; /* 스크롤바 공간 확보 */
            }
            .leave-box {
                flex: 0 0 42px; /* 크기 고정 */
                width: 42px;
                height: 32px;
                border: 1px solid #e5e7eb;
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                background-color: #ffffff;
                color: #9ca3af; /* 기본 연한 회색 (번호) */
            }
            .leave-box.used {
                background-color: #dbeafe; /* 기본(정식) 연차 배경색 (파랑) */
                border-color: #93c5fd;
                color: #1e40af;
                font-weight: bold;
            }
            .leave-box.used.manual {
                background-color: #f3e8ff; /* 수동 등록 배경색 (보라) */
                border-color: #d8b4fe;
                color: #6b21a8;
            }
            .leave-box:hover {
                transform: translateY(-1px);
                box-shadow: 0 1px 2px rgba(0,0,0,0.1);
            }
            
            /* 이월 연차 스타일 (보라) */
            .leave-box.type-carried {
                border-color: #d8b4fe;
                color: #a855f7; /* text-purple-500 */
                background-color: #faf5ff; /* bg-purple-50 */
            }
            .leave-box.type-carried.used {
                background-color: #d8b4fe;
                color: #6b21a8;
            }

            /* 일반 연차 스타일 (파랑) */
            .leave-box.type-regular {
                border-color: #93c5fd; /* blue-300 */
                color: #3b82f6; /* blue-500 */
                background-color: #eff6ff; /* blue-50 */
            }
            .leave-box.type-regular.used {
                background-color: #93c5fd;
                color: #1e40af;
            }

            /* 당겨쓰기/초과 연차 스타일 (빨강) */
            .leave-box.type-borrowed {
                border-color: #fca5a5; /* red-300 */
                color: #ef4444; /* red-500 */
                background-color: #fef2f2; /* red-50 */
                font-weight: bold;
            }
            .leave-box.type-borrowed.used {
                background-color: #fca5a5;
                color: #991b1b;
            }

            /* 수동 등록 표시 (빗금 등) - 여기선 간단히 테두리로 구분 */
            .leave-box.manual-entry {
                position: relative;
            }
            .leave-box.manual-entry::after {
                content: '';
                position: absolute;
                top: 2px; right: 2px;
                width: 4px; height: 4px;
                border-radius: 50%;
                background-color: #eab308; /* yellow-500 */
            }
        </style>
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
            boxLabel = `이${boxIndex}`; // 이1, 이2 ...
        } else if (i < finalLeaves) {
            // 금년 연차 구간
            // 이월이 2개라면, i=2는 3번째 칸이지만 금년 연차로는 1번째임.
            // boxLabel = boxIndex - carriedCnt; (옵션: 금년 연차만 1부터 다시 셀지, 통산으로 할지)
            // 통산 번호로 유지하는 게 깔끔함. 대신 색상으로 구분.
            boxType = 'regular';
        } else {
            // 초과(당겨쓰기) 구간
            boxType = 'borrowed';
            boxLabel = `-${boxIndex - finalLeaves}`; // -1, -2 ...
        }

        let boxClass = `leave-box type-${boxType}`;
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

                dataAttrs = `data-request-id="${requestId}" data-type="${type}" title="${boxType === 'borrowed' ? '당겨쓰기(초과)' : '연차사용'}: ${dateVal}"`;
            }
        }
        // 미사용 상태 (빈칸)
        else {
            dataAttrs = `title="${boxType === 'carried' ? '이월 연차 (미사용)' : '금년 연차 (미사용)'}"`;
        }

        gridHTML += `<div class="${boxClass}" ${dataAttrs}>${displayText}</div>`;
    }
    gridHTML += '</div>';

    return `
        <tr class="leave-status-row border-b hover:bg-gray-50" data-employee-id="${emp.id}" data-dept="${deptName}" data-remaining="${emp.remainingDays}" data-usage="${emp.usagePercent}">
            <td class="p-2 text-center font-semibold">${emp.name}</td>
            <td class="p-2 text-center text-gray-600">${deptName}</td>
            <td class="p-2 text-center text-gray-500">${dayjs(emp.entryDate).format('YY.MM.DD')}</td>
            <td class="p-2 text-center font-bold">${emp.leaveDetails.final}</td>
            <td class="p-2 text-center text-blue-600">${emp.usedDays}</td>
            <td class="p-2 text-center font-bold ${emp.remainingDays <= 3 ? 'text-red-600' : 'text-green-600'}">${emp.remainingDays}</td>
            <td class="p-2 text-left pl-4" style="max-width: 800px; overflow-x: auto;">
                ${gridHTML}
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
                `등록일: ${dayjs(request.created_at).format('YYYY-MM-DD')}\n` +
                `대상일: ${request.dates.join(', ')}\n` +
                `사유: ${request.reason}\n\n` +
                `이 연차 내역을 삭제하시겠습니까?`;

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
        ? `<img src="${request.signature}" alt="서명" style="max-width: 150px; max-height: 80px;">`
        : `<span class="text-gray-400 italic text-sm">(서명 없음)</span>`;

    const modalHTML = `
        <div id="view-leave-app-modal" class="modal-overlay">
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
        </div>
        
        <style>
            @media print {
                body * {
                    visibility: hidden;
                }
                .print-area, .print-area * {
                    visibility: visible;
                }
                .print-area {
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
    const inputDate = prompt(`[${employee.name}] 직원의 연차를 수동으로 등록하시겠습니까?\n등록할 날짜를 입력해주세요 (YYYY-MM-DD):`, defaultDate);

    if (inputDate === null) return;

    // 날짜 유효성 검사
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
        alert('올바른 날짜 형식이 아닙니다 (YYYY-MM-DD)');
        return;
    }

    if (confirm(`${employee.name}님의 ${inputDate} 연차를 '관리자 수동 등록'으로 처리하시겠습니까?`)) {
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