import { state, db } from './state.js';
import { _, _all, show, hide } from './utils.js';
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
