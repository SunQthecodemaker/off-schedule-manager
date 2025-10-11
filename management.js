import { state, db } from './state.js';
import { _, show } from './utils.js';
import { getLeaveDetails } from './main.js';

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
    const leave_renewal_date = _(`#renewal-${id}`).value || null;
    const leave_adjustment = parseInt(_(`#adj-${id}`).value);
    const adjustment_notes = _(`#notes-${id}`).value;

    const { error } = await db.from('employees').update({
        name,
        entryDate,
        email,
        department_id,
        leave_renewal_date,
        leave_adjustment,
        adjustment_notes
    }).eq('id', id);

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
window.handleIssueSubmit = async function(e) {
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

export function getManagementHTML() {
    const { employees, leaveRequests, departments } = state.management;
    const departmentOptions = (currentDeptId = null) => {
        let options = departments.map(d => `<option value="${d.id}" ${d.id === currentDeptId ? 'selected' : ''}>${d.name}</option>`).join('');
        if (currentDeptId === null) {
            options = `<option value="" selected>-- 부서 선택 --</option>` + options;
        }
        return options;
    };

    const headers = [
        { name: '<input type="checkbox" id="selectAllCheckbox" class="cursor-pointer">', width: '3%' },
        { name: '이름', width: '8%' }, 
        { name: '부서', width: '8%' }, 
        { name: '입사일', width: '8%' }, 
        { name: '이메일', width: '10%' }, 
        { name: '비밀번호', width: '6%' }, 
        { name: '연차 기준일', width: '8%' }, 
        { name: '다음 갱신일', width: '8%' }, 
        { name: '법정', width: '4%' }, 
        { name: '조정', width: '8%' }, 
        { name: '비고', width: '8%' }, 
        { name: '확정', width: '4%' }, 
        { name: '사용', width: '4%' }, 
        { name: '잔여', width: '4%' }, 
        { name: '관리', width: '10%' }
    ];
    const headerHtml = headers.map(h => `<th class="p-2 text-left text-xs font-semibold" style="width: ${h.width};">${h.name}</th>`).join('');

    const rows = employees.map(emp => {
        const leaveData = getLeaveDetails(emp);
        const used = leaveRequests.filter(r => r.employee_id === emp.id && r.status === 'approved').reduce((sum, r) => sum + (r.dates?.length || 0), 0);
        const baseDate = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date) : dayjs(emp.entryDate).add(1, 'year');
        const nextRenewalDate = baseDate.year(dayjs().year()).isSameOrAfter(dayjs(), 'day') ? baseDate.year(dayjs().year()).format('YYYY-MM-DD') : baseDate.year(dayjs().year() + 1).format('YYYY-MM-DD');
        const entryDateValue = emp.entryDate ? dayjs(emp.entryDate).format('YYYY-MM-DD') : '';
        const renewalDateValue = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date).format('YYYY-MM-DD') : '';
        const managementButtons = `
            <button class="text-xs bg-blue-500 text-white px-2 py-1 rounded" onclick="handleUpdateEmployee(${emp.id})">저장</button> 
            <button class="text-xs bg-red-500 text-white px-2 py-1 rounded ml-1" onclick="handleDeleteEmployee(${emp.id})">삭제</button> 
            <button class="text-xs bg-yellow-600 text-white px-2 py-1 rounded mt-1 w-full" onclick="openDocumentRequestModal(${emp.id}, '${emp.name}')">서류 요청</button>
        `;
        
        return `<tr class="border-t">
            <td class="p-2 text-center"><input type="checkbox" class="employee-checkbox cursor-pointer" value="${emp.id}"></td>
            <td class="p-2"><input type="text" id="name-${emp.id}" value="${emp.name}" class="table-input"></td>
            <td class="p-2"><select id="dept-${emp.id}" class="table-input">${departmentOptions(emp.department_id)}</select></td>
            <td class="p-2"><input type="date" id="entry-${emp.id}" value="${entryDateValue}" class="table-input"></td>
            <td class="p-2"><input type="email" id="email-${emp.id}" value="${emp.email || ''}" class="table-input"></td>
            <td class="p-2 text-center"><button class="text-xs bg-gray-500 text-white px-2 py-1 rounded">재설정</button></td>
            <td class="p-2"><input type="date" id="renewal-${emp.id}" value="${renewalDateValue}" class="table-input"></td>
            <td class="p-2 text-center align-middle">${nextRenewalDate}</td>
            <td class="p-2 text-center align-middle">${leaveData.legal}</td>
            <td class="p-2 text-center"><div class="flex items-center justify-center"><button class="stepper-btn rounded-l">-</button><input type="number" id="adj-${emp.id}" value="${leaveData.adjustment || 0}" class="table-input table-input-center w-16 text-center"><button class="stepper-btn rounded-r">+</button></div></td>
            <td class="p-2"><input type="text" id="notes-${emp.id}" value="${emp.adjustment_notes || ''}" class="table-input"></td>
            <td class="p-2 text-center align-middle font-bold">${leaveData.final}</td>
            <td class="p-2 text-center align-middle">${used}</td>
            <td class="p-2 text-center align-middle font-bold">${leaveData.final - used}</td>
            <td class="p-2 text-center">${managementButtons}</td>
        </tr>`;
    }).join('');

    const newRow = `
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
            <td class="p-2" colspan="8"></td>
            <td class="p-2 text-center"><button class="text-sm bg-green-600 text-white px-2 py-1 rounded w-full" onclick="handleAddEmployee()">추가</button></td>
        </tr>`;

    setTimeout(addManagementEventListeners, 0);

    return `
        <div class="flex justify-between items-center mb-3">
            <h2 class="text-lg font-semibold">직원 관리</h2>
            <div class="flex space-x-2">
                <button id="bulkDeleteBtn" class="text-sm bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 font-bold disabled:bg-gray-400" disabled>선택 직원 삭제 (0)</button>
                <button id="open-bulk-register-btn" class="text-sm bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 font-bold">엑셀 붙여넣기 대량 등록</button>
            </div>
        </div>
        <div class="overflow-x-auto">
            <table class="fixed-table whitespace-nowrap text-sm mb-6">
                <thead class="bg-gray-100"><tr>${headerHtml}</tr></thead>
                <tbody>${rows}</tbody>
                <tfoot>${newRow}</tfoot>
            </table>
        </div>`;
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
    if (leaveRequests.length === 0) return `<p class="text-center text-gray-500 py-4">연차 신청 기록이 없습니다.</p>`;

    const employeeNameMap = employees.reduce((map, emp) => {
        map[emp.id] = emp.name;
        return map;
    }, {});

    const rows = leaveRequests.map(req => {
        const employeeName = employeeNameMap[req.employee_id] || '알 수 없음';
        const statusText = { pending: '대기중', approved: '승인됨', rejected: '반려됨' }[req.status] || req.status;
        const actions = req.status === 'pending' ? `<button class="text-sm text-green-600 font-bold">승인</button> <button class="text-sm text-red-600 font-bold ml-2">반려</button>` : `<span class="text-sm text-gray-500">${statusText}</span>`;
        const datesText = (req.dates || []).join(', ');
        const createdAtText = req.created_at ? dayjs(req.created_at).format('YYYY-MM-DD HH:mm') : '날짜 없음';
        return `<tr class="border-b"><td class="p-2">${employeeName}</td><td class="p-2">${datesText}</td><td class="p-2">${createdAtText}</td><td class="p-2">${statusText}</td><td class="p-2 text-center">${actions}</td></tr>`;
    }).join('');

    return `
        <h2 class="text-lg font-semibold mb-4">연차 신청 목록</h2>
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50"><tr><th class="p-2 text-left text-xs">직원</th><th class="p-2 text-left text-xs">신청날짜</th><th class="p-2 text-left text-xs">신청일시</th><th class="p-2 text-left text-xs">상태</th><th class="p-2 text-center text-xs">처리</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
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