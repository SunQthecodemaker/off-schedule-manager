// schedule.js - 수정된 버전
import { state, db } from './state.js';
import { _, show, hide } from './utils.js';

let unsavedChanges = new Map();
let unsavedHolidayChanges = { toAdd: new Set(), toRemove: new Set() };
state.schedule.activeDepartmentFilters = new Set();
state.schedule.companyHolidays = new Set();
state.schedule.activeReorder = {
    date: null,
    sortable: null,
};

// ✨ 클릭과 드래그 구분을 위한 변수
let isDragging = false;
let dragStartTime = 0;


// ✅ 그리드 위치 기반 업데이트 (완전 재작성)
function updateScheduleSortOrders(dateStr) {
    const dayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
    if (!dayEl) return;
    const eventContainer = dayEl.querySelector('.day-events');
    if (!eventContainer) return;

    // ✅ 현재 화면의 실제 직원 카드만 수집 (data-position 기준)
    const currentCards = [];
    const allSlots = eventContainer.querySelectorAll('.event-card, .event-slot');

    allSlots.forEach((slot, domIndex) => {
        const position = parseInt(slot.dataset.position, 10);
        const empId = parseInt(slot.dataset.employeeId, 10);

        // ✅ 실제 직원(양수 ID)만 수집, 빈 슬롯과 빈칸은 제외
        if (!isNaN(empId) && empId > 0 && !isNaN(position)) {
            currentCards.push({
                employee_id: empId,
                grid_position: position,
                domIndex: domIndex // 디버깅용
            });
        }
    });

    console.log(`📍 [${dateStr}] 그리드 위치 업데이트:`, currentCards);

    let changeCount = 0;

    // ✅ 변경 감지: 화면의 모든 카드를 state와 비교
    currentCards.forEach(cardData => {
        let schedule = state.schedule.schedules.find(
            s => s.date === dateStr && s.employee_id === cardData.employee_id && s.status === '근무'
        );

        if (schedule) {
            // 기존 스케줄: grid_position이 다르면 업데이트
            if (schedule.grid_position !== cardData.grid_position) {
                console.log(`  🔄 Position changed: ${schedule.employee_id} (${schedule.grid_position} → ${cardData.grid_position})`);
                schedule.grid_position = cardData.grid_position;
                schedule.sort_order = cardData.grid_position;
                unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                changeCount++;
            }
        } else {
            // 새 스케줄 생성
            console.log(`  ➕ New schedule: ${cardData.employee_id} at ${cardData.grid_position}`);
            const tempId = `temp-${Date.now()}-${cardData.employee_id}-${cardData.grid_position}`;
            const newSchedule = {
                id: tempId,
                date: dateStr,
                employee_id: cardData.employee_id,
                status: '근무',
                sort_order: cardData.grid_position,
                grid_position: cardData.grid_position
            };
            state.schedule.schedules.push(newSchedule);
            unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
            changeCount++;
        }
    });

    // 화면에 없는 스케줄은 삭제 표시
    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.status === '근무') {
            const exists = currentCards.some(c => c.employee_id === schedule.employee_id);
            if (!exists && !schedule.id.toString().startsWith('temp-')) {
                console.log(`  ➖ Delete schedule: ${schedule.employee_id}`);
                unsavedChanges.set(schedule.id, { type: 'delete', data: schedule });
                changeCount++;
            }
        }
    });

    console.log(`  💾 이번 호출에서 변경: ${changeCount}건, 전체 unsavedChanges: ${unsavedChanges.size}건`);
}

function getDepartmentColor(departmentId) {
    if (!departmentId) return '#cccccc';
    const colors = ['#4f46e5', '#db2777', '#16a34a', '#f97316', '#0891b2', '#6d28d9', '#ca8a04'];
    return colors[departmentId % colors.length];
}


// ✅ 빈칸 카운터 (고유 ID 생성용)
let spacerCounter = 1;

function getSpacerHtml() {
    // 고유한 음수 ID 생성 (빈칸1: -1, 빈칸2: -2, ...)
    const spacerId = -(spacerCounter++);
    const spacerName = `빈칸${-spacerId}`;
    return `<div class="draggable-employee" data-employee-id="${spacerId}" data-type="employee">
        <span class="handle">☰</span>
        <div class="fc-draggable-item" style="background-color: #f3f4f6;">
            <span style="background-color: #f3f4f6;" class="department-dot"></span>
            <span class="flex-grow font-semibold" style="color: #f3f4f6;">${spacerName}</span>
        </div>
    </div>`;
}

function getSeparatorHtml() {
    return `<div class="list-separator flex items-center" data-type="separator"><span class="handle">☰</span><div class="line"></div><button class="delete-separator-btn" title="구분선 삭제">×</button></div>`;
}

function getEmployeeHtml(emp) {
    if (!emp) return '';
    const departmentColor = getDepartmentColor(emp.departments?.id);
    return `<div class="draggable-employee" data-employee-id="${emp.id}" data-type="employee"><span class="handle">☰</span><div class="fc-draggable-item"><span style="background-color: ${departmentColor};" class="department-dot"></span><span class="flex-grow font-semibold">${emp.name}</span></div></div>`;
}

function getFilteredEmployees() {
    const { employees } = state.management;
    const { activeDepartmentFilters } = state.schedule;
    if (activeDepartmentFilters.size === 0) return employees;
    return employees.filter(emp => activeDepartmentFilters.has(emp.department_id));
}

function getTeamHtml(team, allEmployees) {
    const deleteButton = `<button class="delete-team-btn ml-auto text-red-500 hover:text-red-700 disabled:opacity-25" data-team-id="${team.id}" title="팀이 비어있을 때만 삭제 가능" ${team.members.length > 0 ? 'disabled' : ''}>🗑️</button>`;
    const membersHtml = team.members.map(memberId => {
        if (memberId === '---separator---') return getSeparatorHtml();
        if (memberId < 0) {
            // 음수 ID는 빈칸
            const spacerName = `빈칸${-memberId}`;
            return `<div class="draggable-employee" data-employee-id="${memberId}" data-type="employee">
                <span class="handle">☰</span>
                <div class="fc-draggable-item" style="background-color: #f3f4f6;">
                    <span style="background-color: #f3f4f6;" class="department-dot"></span>
                    <span class="flex-grow font-semibold" style="color: #f3f4f6;">${spacerName}</span>
                </div>
            </div>`;
        }
        const emp = allEmployees.find(e => e.id === memberId);
        return emp ? getEmployeeHtml(emp) : '';
    }).join('');
    return `<div class="team-group" data-team-id="${team.id}"><div class="team-header"><span class="handle">☰</span><input type="text" class="team-header-input" value="${team.name}">${deleteButton}</div><div class="team-member-list">${membersHtml}</div></div>`;
}

function updateSaveButtonState() {
    const saveBtn = _('#save-schedule-btn');
    const revertBtn = _('#revert-schedule-btn');
    if (!saveBtn || !revertBtn) return;
    const totalChanges = unsavedChanges.size + unsavedHolidayChanges.toAdd.size + unsavedHolidayChanges.toRemove.size;
    if (totalChanges > 0) {
        saveBtn.disabled = false;
        revertBtn.disabled = false;
        saveBtn.textContent = `💾 스케줄 저장 (${totalChanges}건)`;
    } else {
        saveBtn.disabled = true;
        revertBtn.disabled = true;
        saveBtn.textContent = '💾 스케줄 저장';
    }
}

function updateViewModeButtons() {
    const { viewMode } = state.schedule;
    document.querySelectorAll('.schedule-view-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === viewMode));
}

function handleViewModeChange(e) {
    const btn = e.target.closest('.schedule-view-btn');
    if (!btn) return;
    const newMode = btn.dataset.mode;
    if (state.schedule.viewMode !== newMode) {
        state.schedule.viewMode = newMode;
        updateViewModeButtons();
        renderCalendar();
    }
}

// ✨ 모든 날짜의 grid_position 업데이트
function updateAllGridPositions() {
    console.log('🔄 모든 날짜의 grid_position 업데이트 시작');

    document.querySelectorAll('.calendar-day').forEach(dayEl => {
        const dateStr = dayEl.dataset.date;
        const eventContainer = dayEl.querySelector('.day-events');
        if (!eventContainer) return;

        const eventCards = eventContainer.querySelectorAll('.event-card');
        eventCards.forEach((card, gridIndex) => {
            const empId = parseInt(card.dataset.employeeId, 10);
            // ✅ 양수 ID(실제 직원)만 처리
            if (isNaN(empId) || empId <= 0) return;

            let schedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === empId);

            if (schedule) {
                if (schedule.grid_position !== gridIndex) {
                    schedule.grid_position = gridIndex;
                    unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                }
            } else {
                // 새 스케줄 생성
                const tempId = `temp-${Date.now()}-${empId}-${gridIndex}`;
                const newSchedule = {
                    id: tempId,
                    date: dateStr,
                    employee_id: empId,
                    status: card.classList.contains('off') ? '휴무' : '근무',
                    sort_order: gridIndex,
                    grid_position: gridIndex
                };
                state.schedule.schedules.push(newSchedule);
                unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
            }
        });
    });

    console.log('✅ grid_position 업데이트 완료');
}

async function handleRevertChanges() {
    if (confirm("정말로 모든 변경사항을 되돌리시겠습니까?")) {
        await loadAndRenderScheduleData(state.schedule.currentDate);
    }
}

async function handleSaveSchedules() {
    const saveBtn = _('#save-schedule-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';

    console.log('💾 ========== 저장 시작 (State 기반 + 휴무일) ==========');

    try {
        // ✅ 1. 현재 화면의 배치(Grid Position)를 State에 반영
        if (state.schedule.viewMode === 'working') {
            updateAllGridPositions();
        }

        const startOfMonth = dayjs(state.schedule.currentDate).startOf('month').format('YYYY-MM-DD');
        const endOfMonth = dayjs(state.schedule.currentDate).endOf('month').format('YYYY-MM-DD');

        console.log('📅 대상 기간:', startOfMonth, '~', endOfMonth);

        // ✅ 2. State에서 저장할 데이터 수집
        // 유효한 직원 ID 목록 (삭제된 직원 데이터가 남아있을 경우 RLS 에러 방지)
        const validEmployeeIds = new Set(state.management.employees.map(e => e.id));

        const schedulesToSave = state.schedule.schedules
            .filter(s => {
                // 기간 내, 양수 ID(실제 직원), 그리고 유효한 직원 목록에 있는 경우만 저장
                return s.date >= startOfMonth &&
                    s.date <= endOfMonth &&
                    s.employee_id > 0 &&
                    validEmployeeIds.has(s.employee_id);
            })
            .map(s => ({
                date: s.date,
                employee_id: s.employee_id,
                status: s.status,
                sort_order: s.sort_order || 0,
                grid_position: s.grid_position || 0
                // manager_id 제거 (테이블에 없음)
            }));

        console.log('📊 수집된 스케줄 (State):', schedulesToSave.length, '건');

        // ✅ 3. 해당 월의 기존 스케줄 완전 삭제
        console.log('🗑️ 기존 스케줄 삭제 중...');
        const { error: deleteError } = await db.from('schedules')
            .delete()
            .gte('date', startOfMonth)
            .lte('date', endOfMonth);

        if (deleteError) throw deleteError;

        // ✅ 4. 데이터 일괄 삽입
        if (schedulesToSave.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < schedulesToSave.length; i += BATCH_SIZE) {
                const batch = schedulesToSave.slice(i, i + BATCH_SIZE);
                const { error: insertError } = await db.from('schedules').insert(batch);
                if (insertError) throw insertError;
            }
        }

        // ✅ 5. 회사 휴무일 저장
        const holidaysToAdd = Array.from(unsavedHolidayChanges.toAdd);
        const holidaysToRemove = Array.from(unsavedHolidayChanges.toRemove);

        if (holidaysToAdd.length > 0) {
            const { error: holidayAddError } = await db.from('company_holidays')
                .insert(holidaysToAdd.map(date => ({ date })));
            if (holidayAddError) throw holidayAddError;
        }

        if (holidaysToRemove.length > 0) {
            const { error: holidayRemoveError } = await db.from('company_holidays')
                .delete()
                .in('date', holidaysToRemove);
            if (holidayRemoveError) throw holidayRemoveError;
        }

        console.log('✅ 저장 완료');

        // 6. 화면 다시 로드 (확실한 동기화)
        await loadAndRenderScheduleData(state.schedule.currentDate);

        alert('스케줄이 성공적으로 저장되었습니다.');

    } catch (error) {
        console.error('❌ 저장 실패:', error);
        alert(`스케줄 저장에 실패했습니다.\n\n오류: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 스케줄 저장';
    }
}

// 리셋 함수 추가
async function handleResetSchedule() {
    if (!confirm('현재 달의 모든 스케줄을 리셋하고 사이드바 순서대로 근무자로 초기화하시겠습니까?')) {
        return;
    }

    const resetBtn = _('#reset-schedule-btn');
    resetBtn.disabled = true;
    resetBtn.textContent = '리셋 중...';

    try {
        // 1. 사이드바에서 순서 가져오기 (제외 목록 제외)
        const orderedEmployees = [];
        let gridPosition = 0;

        // ✅ 직원 목록(.employee-list)에서만 가져오기
        document.querySelectorAll('.employee-list .draggable-employee').forEach(memberEl => {
            const empId = parseInt(memberEl.dataset.employeeId, 10);

            if (!isNaN(empId)) {
                if (empId < 0) {
                    // 음수 ID = 빈칸 (DB에 저장하지 않음)
                    orderedEmployees.push({
                        type: 'spacer',
                        position: gridPosition++
                    });
                } else {
                    // 양수 ID = 실제 직원
                    orderedEmployees.push({
                        type: 'employee',
                        employee_id: empId,
                        position: gridPosition++
                    });
                }
            }
        });

        console.log('📋 리셋에 포함될 항목:', orderedEmployees.length, '개');

        // ✅ 제외 목록 확인 (로그용)
        const excludedCount = document.querySelectorAll('.excluded-list .draggable-employee').length;
        console.log('🚫 제외된 직원:', excludedCount, '명');

        // 2. 해당 월의 모든 날짜 가져오기
        const currentDate = dayjs(state.schedule.currentDate);
        const startOfMonth = currentDate.startOf('month');
        const endOfMonth = currentDate.endOf('month');

        const allDates = [];
        let currentLoop = startOfMonth.clone();
        while (currentLoop.valueOf() <= endOfMonth.valueOf()) {
            allDates.push(currentLoop.format('YYYY-MM-DD'));
            currentLoop = currentLoop.add(1, 'day');
        }

        console.log('📅 대상 날짜:', allDates.length, '일');

        // 3. 기존 스케줄 삭제
        const { error: deleteError } = await db.from('schedules')
            .delete()
            .gte('date', startOfMonth.format('YYYY-MM-DD'))
            .lte('date', endOfMonth.format('YYYY-MM-DD'));

        if (deleteError) {
            console.error('❌ 삭제 오류:', deleteError);
            throw deleteError;
        }

        console.log('✅ 기존 스케줄 삭제 완료');

        // 4. 모든 날짜에 대해 근무자로 삽입
        const schedulesToInsert = [];

        allDates.forEach(dateStr => {
            orderedEmployees.forEach(item => {
                // ✅ 실제 직원만 저장 (빈칸은 제외)
                if (item.type === 'employee') {
                    schedulesToInsert.push({
                        date: dateStr,
                        employee_id: item.employee_id,
                        status: '근무',
                        sort_order: item.position,
                        grid_position: item.position
                    });
                }
                // spacer는 DB에 저장하지 않음 (렌더링 시 빈 공간으로 표시됨)
            });
        });

        console.log('➕ 삽입할 스케줄:', schedulesToInsert.length, '건');

        // 5. 새 스케줄 삽입 (배치 처리)
        const BATCH_SIZE = 50;
        for (let i = 0; i < schedulesToInsert.length; i += BATCH_SIZE) {
            const batch = schedulesToInsert.slice(i, i + BATCH_SIZE);
            console.log(`⏳ 배치 삽입 중 (${i + 1} ~ ${Math.min(i + BATCH_SIZE, schedulesToInsert.length)} / ${schedulesToInsert.length})`);

            const { error: insertError } = await db.from('schedules')
                .insert(batch);

            if (insertError) {
                console.error(`❌ 배치 삽입 오류 (인덱스 ${i}):`, insertError);
                throw insertError;
            }
        }

        console.log('✅ 스케줄 리셋 완료');

        // 6. 화면 다시 로드
        await loadAndRenderScheduleData(state.schedule.currentDate);

        alert('스케줄이 성공적으로 리셋되었습니다.');

    } catch (error) {
        console.error('❌ 리셋 실패:', error);
        alert(`스케줄 리셋에 실패했습니다.\n\n오류: ${error.message}`);
    } finally {
        resetBtn.disabled = false;
        resetBtn.textContent = '🔄 스케줄 리셋';
    }
}
function handleAddNewTeam() {
    const newTeamHtml = getTeamHtml({ id: `new-${Date.now()}`, name: '새로운 팀', members: [] }, getFilteredEmployees());
    _('.unassigned-group').insertAdjacentHTML('beforebegin', newTeamHtml);
    const newTeamEl = _('.unassigned-group').previousElementSibling;
    const deleteBtn = newTeamEl.querySelector('.delete-team-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', handleDeleteTeam);
    initializeSortableAndDraggable();
}

function handleDeleteTeam(e) {
    const teamId = e.target.closest('.delete-team-btn').dataset.teamId;
    if (!teamId) return;
    if (confirm("이 팀을 삭제하시겠습니까? 팀에 속한 직원은 '미지정 직원'으로 이동합니다.")) {
        const teamEl = _(`.team-group[data-team-id="${teamId}"]`);
        if (teamEl) {
            teamEl.querySelectorAll('.draggable-employee, .list-spacer').forEach(member => _('#unassigned-list').appendChild(member));
            teamEl.remove();
        }
    }
}

function handleAddSeparator() {
    _('#unassigned-list').insertAdjacentHTML('beforeend', getSeparatorHtml());
}

function handleAddSpacer() {
    const employeeList = document.querySelector('.employee-list');
    if (employeeList) {
        employeeList.insertAdjacentHTML('beforeend', getSpacerHtml());
    }
}

function handleDeleteSpacer(e) {
    if (e.target.matches('.delete-spacer-btn, .delete-separator-btn')) {
        e.target.closest('[data-type]').remove();
    }
}

async function handleSaveEmployeeOrder() {
    const saveBtn = _('#save-employee-order-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장중...';

    // ✅ 직원 목록(.employee-list)에서만 순서 수집
    const employeeOrder = [];
    document.querySelectorAll('.employee-list .draggable-employee').forEach(memberEl => {
        const empId = parseInt(memberEl.dataset.employeeId, 10);
        if (!isNaN(empId)) {
            employeeOrder.push(empId); // 음수(빈칸)도 포함
        }
    });

    console.log('💾 직원 순서 저장:', employeeOrder);

    const month = dayjs(state.schedule.currentDate).format('YYYY-MM-01');
    const managerUuid = state.currentUser?.auth_uuid;

    if (!managerUuid) {
        alert('로그인 정보가 올바르지 않습니다. 다시 로그인해주세요.');
        saveBtn.disabled = false;
        saveBtn.textContent = '순서저장';
        return;
    }

    try {
        // ✅ 간단한 형식으로 저장 (하나의 팀으로)
        const layoutData = [{
            id: 'main',
            name: '직원 목록',
            members: employeeOrder
        }];

        const { error } = await db.from('team_layouts')
            .upsert({
                month,
                layout_data: layoutData,
                manager_id: managerUuid
            }, { onConflict: 'month' });

        if (error) throw error;

        alert('직원 순서가 성공적으로 저장되었습니다.');
        await loadAndRenderScheduleData(state.schedule.currentDate);
    } catch (error) {
        console.error('직원 순서 저장 실패:', error);
        alert(`직원 순서 저장에 실패했습니다: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '순서저장';
    }
}

function handleDepartmentFilterChange(e) {
    const checkbox = e.target;
    if (checkbox.matches('.dept-filter-checkbox')) {
        const deptId = parseInt(checkbox.value);
        if (checkbox.checked) state.schedule.activeDepartmentFilters.add(deptId);
        else state.schedule.activeDepartmentFilters.delete(deptId);
        renderCalendar();
        renderScheduleSidebar();
    }
}

// ✨ 개선: 사이드바에서 달력으로 드래그 가능하도록 수정

// ✅ 같은 날짜 내 이동 처리 (24칸 고정 그리드)
function handleSameDateMove(dateStr, movedEmployeeId, oldIndex, newIndex) {
    console.log(`🔄 [${dateStr}] ${movedEmployeeId}번 이동: ${oldIndex} → ${newIndex}`);

    const GRID_SIZE = 24;

    // 1. 현재 24칸 상태 구성
    const currentGrid = new Array(GRID_SIZE).fill(null);

    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.status === '근무' && schedule.grid_position != null) {
            const pos = schedule.grid_position;
            if (pos >= 0 && pos < GRID_SIZE) {
                currentGrid[pos] = schedule.employee_id;
            }
        }
    });

    console.log('  기존 그리드:', currentGrid.map((id, i) => id === null ? `${i}:_` : id === -1 ? `${i}:[]` : `${i}:${id}`).join(' '));

    // 2. 이동 처리
    const newGrid = [...currentGrid];

    // 원래 위치 비우기 (빈 슬롯으로)
    newGrid[oldIndex] = null;

    // 새 위치에 배치
    if (newGrid[newIndex] === null) {
        // 빈 슬롯이면 단순 이동
        newGrid[newIndex] = movedEmployeeId;
    } else {
        // 다른 직원/빈칸이 있으면 삽입 (뒤로 밀기)
        const itemsToShift = [];
        for (let i = newIndex; i < GRID_SIZE; i++) {
            if (newGrid[i] !== null) {
                itemsToShift.push(newGrid[i]);
                newGrid[i] = null;
            }
        }

        // 삽입
        newGrid[newIndex] = movedEmployeeId;
        let insertPos = newIndex + 1;
        itemsToShift.forEach(empId => {
            while (insertPos < GRID_SIZE && newGrid[insertPos] !== null) {
                insertPos++;
            }
            if (insertPos < GRID_SIZE) {
                newGrid[insertPos] = empId;
                insertPos++;
            }
        });
    }

    console.log('  새 그리드:', newGrid.map((id, i) => id === null ? `${i}:_` : id === -1 ? `${i}:[]` : `${i}:${id}`).join(' '));

    // 3. state 업데이트 (기존 스케줄 삭제 표시)
    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.status === '근무') {
            const currentPos = newGrid.indexOf(schedule.employee_id);
            if (currentPos === -1) {
                // 그리드에 없으면 삭제 표시
                if (!schedule.id.toString().startsWith('temp-')) {
                    unsavedChanges.set(schedule.id, { type: 'delete', data: schedule });
                }
            }
        }
    });

    // 4. 새 그리드 상태로 스케줄 생성/업데이트
    newGrid.forEach((employeeId, position) => {
        if (employeeId === null) return; // 빈 슬롯은 스킵

        let schedule = state.schedule.schedules.find(
            s => s.date === dateStr && s.employee_id === employeeId
        );

        if (schedule) {
            // 기존 스케줄 업데이트
            if (schedule.grid_position !== position) {
                schedule.grid_position = position;
                schedule.sort_order = position;
                unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
            }
        } else {
            // 새 스케줄 생성
            const tempId = `temp-${Date.now()}-${employeeId}-${position}`;
            const newSchedule = {
                id: tempId,
                date: dateStr,
                employee_id: employeeId,
                status: '근무',
                sort_order: position,
                grid_position: position
            };
            state.schedule.schedules.push(newSchedule);
            unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
        }
    });

    // 5. 즉시 재렌더링
    renderCalendar();
    updateSaveButtonState();
}

function initializeDayDragDrop(dayEl, dateStr) {
    const eventContainer = dayEl.querySelector('.day-events');
    if (!eventContainer) return;

    if (eventContainer.sortableInstance) {
        eventContainer.sortableInstance.destroy();
    }

    // ✨ 날짜 칸에 드롭존 설정
    let dragSourceInfo = null; // 드래그 시작 정보 저장

    eventContainer.sortableInstance = new Sortable(eventContainer, {
        group: {
            name: 'calendar-group',
            pull: true,
            put: ['sidebar-employees', 'calendar-group'] // ✅ 그룹명 변경
        },
        draggable: '.event-card, .draggable-employee, .list-spacer, .event-slot',  // ✅ 빈 슬롯도 드래그 가능
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        chosenClass: 'sortable-chosen',
        dragoverBubble: true,
        delay: 100,
        delayOnTouchOnly: false,
        forceFallback: false,
        fallbackTolerance: 5,
        emptyInsertThreshold: 30,

        onStart(evt) {
            isDragging = true;
            dragStartTime = Date.now();
            document.body.style.userSelect = 'none';

            // ✅ 드래그 시작 시 현재 상태 저장
            const draggedCard = evt.item;
            const empIdStr = draggedCard.dataset.employeeId;

            // ✅ 빈 슬롯도 드래그 가능하게 변경
            const empId = empIdStr === 'empty' ? null : parseInt(empIdStr, 10);

            dragSourceInfo = {
                employeeId: empId,
                oldIndex: evt.oldIndex,
                fromDate: dateStr,
                originalState: state.schedule.schedules
                    .filter(s => s.date === dateStr && s.status === '근무')
                    .map(s => ({ employee_id: s.employee_id, grid_position: s.grid_position }))
            };

            console.log('📅 Drag started:', dragSourceInfo);

            document.querySelectorAll('.day-events').forEach(el => {
                el.style.minHeight = '100px';
                el.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
                el.style.border = '2px dashed rgba(59, 130, 246, 0.3)';
            });
        },

        onEnd(evt) {
            setTimeout(() => {
                isDragging = false;
            }, 100);
            document.body.style.userSelect = '';
            document.querySelectorAll('.day-events').forEach(el => {
                el.style.minHeight = '';
                el.style.backgroundColor = '';
                el.style.border = '';
            });

            console.log('📅 [onEnd] Drag ended');
            dragSourceInfo = null;
        },

        onUpdate(evt) {
            // ✅ 같은 날짜 내 이동 처리
            const oldIndex = evt.oldIndex;
            const newIndex = evt.newIndex;

            console.log('📅 [onUpdate] 같은 날짜 내 이동:', oldIndex, '→', newIndex);

            if (oldIndex !== newIndex) {
                // ✅ DOM 순서가 바뀌었으므로 모든 슬롯의 data-position 재설정
                const eventContainer = evt.to;
                const allSlots = eventContainer.querySelectorAll('.event-card, .event-slot');
                allSlots.forEach((slot, idx) => {
                    slot.dataset.position = idx;
                });

                // ✅ 위치가 바뀌면 전체 position 재계산
                updateScheduleSortOrders(dateStr);
                updateSaveButtonState();
            }
        },

        onAdd(evt) {
            console.log('🎯 Calendar onAdd triggered! Date:', dateStr);
            const employeeEl = evt.item;

            // ✅ event-card인 경우는 다른 날짜에서 온 것 (규칙 5)
            if (employeeEl.classList.contains('event-card')) {
                console.log('✅ Moved from another date');
                updateScheduleSortOrders(dateStr);
                updateSaveButtonState();
                return;
            }

            // ✅ draggable-employee인 경우 사이드바에서 온 것
            const empId = parseInt(employeeEl.dataset.employeeId, 10);
            console.log('📝 Dropped employee ID:', empId);

            if (isNaN(empId)) {
                console.log('❌ Invalid employee ID, removing element');
                employeeEl.remove();
                return;
            }

            // ✅ 중복 체크 (규칙 4-2)
            const alreadyExists = state.schedule.schedules.some(
                s => s.date === dateStr && s.employee_id === empId && s.status === '근무'
            );

            if (alreadyExists) {
                console.log('❌ Employee already exists on this date - drop cancelled');
                employeeEl.remove();
                alert('이미 해당 날짜에 배치된 직원입니다.');
                return;
            }

            // ✅ 음수 ID는 빈칸으로 처리
            let employee = null;
            let employeeName = '';
            if (empId < 0) {
                employeeName = `빈칸${-empId}`;
                console.log('✅ Spacer:', employeeName, 'at position:', evt.newIndex);
            } else {
                employee = state.management.employees.find(e => e.id === empId);
                if (!employee) {
                    console.log('❌ Employee not found, removing element');
                    employeeEl.remove();
                    return;
                }
                employeeName = employee.name;
                console.log('✅ Found employee:', employeeName, 'at position:', evt.newIndex);
            }

            // ✅ 새 스케줄 추가 (기존 스케줄의 position은 건드리지 않음)
            const tempId = `temp-${Date.now()}-${empId}`;
            const newSchedule = {
                id: tempId,
                date: dateStr,
                employee_id: empId,
                status: '근무',
                sort_order: evt.newIndex,
                grid_position: evt.newIndex
            };
            state.schedule.schedules.push(newSchedule);
            unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
            console.log('✅ Added new schedule:', empId, 'at position:', evt.newIndex);

            // ✅ DOM 정리 및 재렌더링
            employeeEl.remove();
            renderCalendar();

            // ✅ 모든 카드의 position 재계산 (밀린 카드들 감지)
            updateScheduleSortOrders(dateStr);
            updateSaveButtonState();
        },
    });
}

function getWorkingEmployeesOnDate(dateStr) {
    const workingEmps = [];

    // ✅ DB에 명시적으로 '근무' 상태로 저장된 직원만 표시
    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.status === '근무') {
            const emp = state.management.employees.find(e => e.id === schedule.employee_id);
            if (emp) {
                workingEmps.push(emp);
            }
        }
    });

    // ✅ grid_position 기준 정렬
    workingEmps.sort((a, b) => {
        const scheduleA = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === a.id);
        const scheduleB = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === b.id);

        const posA = scheduleA?.grid_position;
        const posB = scheduleB?.grid_position;

        if (posA != null && posB != null) return posA - posB;
        if (posA != null) return -1;
        if (posB != null) return 1;

        return a.id - b.id;
    });

    return workingEmps;
}

function getOffEmployeesOnDate(dateStr) {
    const offEmps = [];

    // ✅ 1. DB/State에 '휴무' 상태로 저장된 직원
    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.status === '휴무') {
            const emp = state.management.employees.find(e => e.id === schedule.employee_id);
            if (emp) {
                // 중복 방지
                if (!offEmps.some(item => item.employee.id === emp.id)) {
                    offEmps.push({ employee: emp, schedule: schedule, type: '휴무' });
                }
            }
        }
    });

    // ✅ 2. 승인된 연차 (DB에 스케줄 없어도 표시)
    state.management.leaveRequests.forEach(req => {
        if (req.status === 'approved' && req.dates?.includes(dateStr)) {
            const emp = state.management.employees.find(e => e.id === req.employee_id);
            // 이미 추가된 경우 제외 (스케줄 상 휴무로 되어있을 수 있음)
            const alreadyAdded = offEmps.some(item => item.employee.id === req.employee_id);
            if (emp && !alreadyAdded) {
                offEmps.push({ employee: emp, schedule: null, type: 'leave' });
            }
        }
    });

    // ✅ 이름순 정렬 (휴무자는 그리드 위치가 중요하지 않음)
    offEmps.sort((a, b) => a.employee.name.localeCompare(b.employee.name));

    return offEmps;
}

// ✨ 개선: 클릭 이벤트를 더 정교하게 처리
function handleEventCardClick(e) {
    const card = e.target.closest('.event-card');
    if (!card) return;

    // ✨ 드래그 중이거나 드래그 직후면 클릭 무시
    if (isDragging || (Date.now() - dragStartTime < 200)) {
        console.log('Click ignored: dragging or just after drag');
        return;
    }

    const dateStr = card.closest('.calendar-day').dataset.date;
    const empId = parseInt(card.dataset.employeeId);
    const type = card.dataset.type;

    // 연차와 빈칸은 클릭 불가
    if (type === 'leave') {
        return;
    }

    // ✅ 빈칸(음수 ID)은 클릭해도 상태 변경 안함
    if (empId < 0) {
        console.log('Spacer clicked - no action');
        return;
    }

    // ✨ 카드 클릭: 상태 전환
    console.log('Card clicked:', empId, 'on', dateStr);

    let schedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === empId);

    if (schedule) {
        // 기존 스케줄: 상태 전환
        schedule.status = schedule.status === '근무' ? '휴무' : '근무';
        unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
        console.log('Updated schedule:', schedule);
    } else {
        // 새 스케줄 생성
        const currentlyWorking = getWorkingEmployeesOnDate(dateStr).some(emp => emp.id === empId);
        const newStatus = currentlyWorking ? '휴무' : '근무';

        const existingOrders = state.schedule.schedules
            .filter(s => s.date === dateStr)
            .map(s => s.sort_order)
            .filter(o => o !== null && o !== undefined);
        const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) : -1;

        const tempId = `temp-${Date.now()}-${empId}`;
        const newSchedule = {
            id: tempId,
            date: dateStr,
            employee_id: empId,
            status: newStatus,
            sort_order: maxOrder + 1
        };
        state.schedule.schedules.push(newSchedule);
        unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
        console.log('Created schedule:', newSchedule);
    }

    renderCalendar();
    updateSaveButtonState();
}

function handleDateNumberClick(e) {
    const target = e.target;

    if (!target.classList.contains('day-number')) return;

    e.stopPropagation();

    const dayEl = target.closest('.calendar-day');
    if (!dayEl) return;

    const clickedDate = dayEl.dataset.date;

    console.log('Date clicked:', clickedDate, 'Mode:', state.schedule.viewMode);

    const allEmployees = getFilteredEmployees();

    if (state.schedule.viewMode === 'working') {
        allEmployees.forEach((emp, index) => {
            let schedule = state.schedule.schedules.find(s => s.date === clickedDate && s.employee_id === emp.id);

            if (schedule) {
                if (schedule.status !== '휴무') {
                    schedule.status = '휴무';
                    schedule.sort_order = index;
                    unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                }
            } else {
                const tempId = `temp-${Date.now()}-${emp.id}`;
                const newSchedule = {
                    id: tempId,
                    date: clickedDate,
                    employee_id: emp.id,
                    status: '휴무',
                    sort_order: index
                };
                state.schedule.schedules.push(newSchedule);
                unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
            }
        });

        state.schedule.companyHolidays.add(clickedDate);
        if (unsavedHolidayChanges.toRemove.has(clickedDate)) {
            unsavedHolidayChanges.toRemove.delete(clickedDate);
        } else {
            unsavedHolidayChanges.toAdd.add(clickedDate);
        }
    }
    else {
        allEmployees.forEach((emp, index) => {
            let schedule = state.schedule.schedules.find(s => s.date === clickedDate && s.employee_id === emp.id);

            if (schedule) {
                if (schedule.status !== '근무') {
                    schedule.status = '근무';
                    schedule.sort_order = index;
                    unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                }
            } else {
                const tempId = `temp-${Date.now()}-${emp.id}`;
                const newSchedule = {
                    id: tempId,
                    date: clickedDate,
                    employee_id: emp.id,
                    status: '근무',
                    sort_order: index
                };
                state.schedule.schedules.push(newSchedule);
                unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
            }
        });

        state.schedule.companyHolidays.delete(clickedDate);
        if (unsavedHolidayChanges.toAdd.has(clickedDate)) {
            unsavedHolidayChanges.toAdd.delete(clickedDate);
        } else {
            unsavedHolidayChanges.toRemove.add(clickedDate);
        }
    }

    renderCalendar();
    updateSaveButtonState();
}

function renderCalendar() {
    const container = _('#pure-calendar');
    if (!container) {
        console.error('Calendar container not found');
        return;
    }

    const currentDate = dayjs(state.schedule.currentDate);
    const year = currentDate.year();
    const month = currentDate.month();

    const firstDay = dayjs(new Date(year, month, 1));
    const lastDay = dayjs(new Date(year, month + 1, 0));
    const startDate = firstDay.startOf('week');
    const endDate = lastDay.endOf('week');

    let calendarHTML = '<div class="calendar-grid">';

    const weekDays = ['일', '월', '화', '수', '목', '금', '토'];
    weekDays.forEach((day, idx) => {
        let colorClass = '';
        if (idx === 0) colorClass = 'text-red-500';
        else if (idx === 6) colorClass = 'text-blue-500';
        calendarHTML += `<div class="calendar-header ${colorClass}">${day}</div>`;
    });

    let currentLoop = startDate.clone();
    while (currentLoop.valueOf() <= endDate.valueOf()) {
        const dateStr = currentLoop.format('YYYY-MM-DD');
        const dayNum = currentLoop.date();
        const isCurrentMonth = currentLoop.month() === month;
        const isToday = currentLoop.format('YYYY-MM-DD') === dayjs().format('YYYY-MM-DD');
        const isSunday = currentLoop.day() === 0;
        const isSaturday = currentLoop.day() === 6;
        const isHoliday = state.schedule.companyHolidays.has(dateStr);

        let dayClasses = 'calendar-day';
        if (!isCurrentMonth) dayClasses += ' other-month';
        if (isToday) dayClasses += ' today';
        if (isHoliday) dayClasses += ' company-holiday';
        if (isSunday) dayClasses += ' sunday-col';

        let numberClass = 'day-number';
        if (isSunday) numberClass += ' text-red-500';
        else if (isSaturday) numberClass += ' text-blue-500';

        let eventsHTML = '';
        if (state.schedule.viewMode === 'working') {
            // ✅ 항상 24칸 고정 렌더링
            const GRID_SIZE = 24;
            const gridSlots = new Array(GRID_SIZE).fill(null);

            // 해당 날짜의 스케줄을 그리드 위치에 배치

            // ✅ 부서 필터 적용된 직원 ID 목록
            const filteredEmployeeIds = new Set();
            if (state.schedule.activeDepartmentFilters.size > 0) {
                state.management.employees.forEach(emp => {
                    if (state.schedule.activeDepartmentFilters.has(emp.department_id)) {
                        filteredEmployeeIds.add(emp.id);
                    }
                });
            }
            state.schedule.schedules.forEach(schedule => {
                if (schedule.date === dateStr && schedule.status === '근무' && schedule.grid_position != null) {
                    // ✅ 부서 필터가 있으면 필터링된 직원만 표시
                    if (state.schedule.activeDepartmentFilters.size > 0) {
                        if (!filteredEmployeeIds.has(schedule.employee_id) && schedule.employee_id > 0) {
                            return; // 필터에 해당하지 않는 직원은 스킵
                        }
                    }
                    const pos = schedule.grid_position;
                    if (pos >= 0 && pos < GRID_SIZE) {
                        gridSlots[pos] = schedule;
                    }
                }
            });

            // 각 슬롯을 HTML로 변환
            eventsHTML = gridSlots.map((schedule, position) => {
                if (!schedule) {
                    // 빈 슬롯
                    return `<div class="event-slot empty-slot" data-position="${position}" data-employee-id="empty" data-type="empty">
                        <span class="slot-number">${position + 1}</span>
                    </div>`;
                } else if (schedule.employee_id < 0) {
                    // ✅ 빈칸 카드: 텍스트가 배경색과 같아서 안보임
                    const spacerName = `빈칸${-schedule.employee_id}`;
                    return `<div class="event-card event-working" data-position="${position}" data-employee-id="${schedule.employee_id}" data-schedule-id="${schedule.id}" data-type="working" style="background-color: #f3f4f6;">
                        <span class="event-dot" style="background-color: #f3f4f6;"></span>
                        <span class="event-name" style="color: #f3f4f6;">${spacerName}</span>
                    </div>`;
                } else {
                    // 직원 카드
                    const emp = state.management.employees.find(e => e.id === schedule.employee_id);
                    if (!emp) {
                        // 음수 ID거나 삭제된 직원 - 빈칸으로 표시
                        const spacerName = schedule.employee_id < 0 ? `빈칸${-schedule.employee_id}` : '알수없음';
                        return `<div class="event-card event-working" data-position="${position}" data-employee-id="${schedule.employee_id}" data-schedule-id="${schedule.id}" data-type="working" style="background-color: #f3f4f6;">
                            <span class="event-dot" style="background-color: #f3f4f6;"></span>
                            <span class="event-name" style="color: #f3f4f6;">${spacerName}</span>
                        </div>`;
                    }

                    const deptColor = getDepartmentColor(emp.departments?.id);
                    return `<div class="event-card event-working" data-position="${position}" data-employee-id="${emp.id}" data-schedule-id="${schedule.id}" data-type="working">
                        <span class="event-dot" style="background-color: ${deptColor};"></span>
                        <span class="event-name">${emp.name}</span>
                    </div>`;
                }
            }).join('');
        } else {
            const offData = getOffEmployeesOnDate(dateStr);
            eventsHTML = offData.map(item => {
                const scheduleId = item.schedule?.id || '';
                const type = item.type;
                const deptColor = getDepartmentColor(item.employee.departments?.id);
                const eventClass = type === 'leave' ? 'event-leave' : 'event-off';
                // ✨ 삭제 버튼 제거
                return `<div class="event-card ${eventClass}" data-employee-id="${item.employee.id}" data-schedule-id="${scheduleId}" data-type="${type}">
                    <span class="event-dot" style="background-color: ${deptColor};"></span>
                    <span class="event-name">${item.employee.name}</span>
                </div>`;
            }).join('');
        }

        calendarHTML += `
            <div class="${dayClasses}" data-date="${dateStr}">
                <div class="day-header">
                    <span class="${numberClass}">${dayNum}</span>
                </div>
                <div class="day-events">${eventsHTML}</div>
            </div>`;

        currentLoop = currentLoop.add(1, 'day');
    }

    calendarHTML += '</div>';
    container.innerHTML = calendarHTML;

    // ✨ 모든 날짜에 드래그 앤 드롭 초기화
    document.querySelectorAll('.calendar-day').forEach(dayEl => {
        const dateStr = dayEl.dataset.date;
        initializeDayDragDrop(dayEl, dateStr);
    });

    // ✨ 이벤트 위임으로 클릭 처리
    container.removeEventListener('click', handleCalendarClick);
    container.addEventListener('click', handleCalendarClick);

    console.log('Calendar rendered successfully');
}

// ✨ 달력 클릭 핸들러 분리
function handleCalendarClick(e) {
    // 날짜 숫자 클릭
    if (e.target.classList.contains('day-number')) {
        handleDateNumberClick(e);
        return;
    }

    // 이벤트 카드 클릭 (드래그 아닐 때만)
    const card = e.target.closest('.event-card');
    if (card && !isDragging) {
        handleEventCardClick(e);
        return;
    }
}

function navigateMonth(direction) {
    const totalChanges = unsavedChanges.size + unsavedHolidayChanges.toAdd.size + unsavedHolidayChanges.toRemove.size;
    if (totalChanges > 0 && !confirm("저장되지 않은 변경사항이 있습니다. 다른 달로 이동하면 변경사항이 사라집니다. 정말 이동하시겠습니까?")) {
        return;
    }

    const current = dayjs(state.schedule.currentDate);
    let newDate;
    if (direction === 'prev') newDate = current.subtract(1, 'month');
    else if (direction === 'next') newDate = current.add(1, 'month');
    else newDate = dayjs();

    state.schedule.currentDate = newDate.format('YYYY-MM-DD');
    loadAndRenderScheduleData(state.schedule.currentDate);
}

async function loadAndRenderScheduleData(date) {
    if (state.schedule.activeReorder.date) {
        const prevDayEl = _(`.calendar-day[data-date="${state.schedule.activeReorder.date}"]`);
        if (prevDayEl) {
            prevDayEl.classList.remove('reordering-active');
        }
        state.schedule.activeReorder.sortable?.destroy();
        state.schedule.activeReorder.date = null;
        state.schedule.activeReorder.sortable = null;
    }

    unsavedChanges.clear();
    unsavedHolidayChanges = { toAdd: new Set(), toRemove: new Set() };
    updateSaveButtonState();

    const currentMonth = dayjs(date).format('YYYY-MM-01');
    const startOfMonth = dayjs(date).startOf('month').format('YYYY-MM-DD');
    const endOfMonth = dayjs(date).endOf('month').format('YYYY-MM-DD');

    console.log('Loading data for:', { currentMonth, startOfMonth, endOfMonth });

    try {
        const [layoutRes, scheduleRes, holidayRes] = await Promise.all([
            db.from('team_layouts').select('layout_data').lte('month', currentMonth).order('month', { ascending: false }).limit(1),
            db.from('schedules').select('*').gte('date', startOfMonth).lte('date', endOfMonth),
            db.from('company_holidays').select('date').gte('date', startOfMonth).lte('date', endOfMonth)
        ]);

        console.log('Data loaded:', { layoutRes, scheduleRes, holidayRes });

        if (layoutRes.error) throw layoutRes.error;
        if (scheduleRes.error) throw scheduleRes.error;
        if (holidayRes.error) throw holidayRes.error;

        const latestLayout = layoutRes.data?.[0];
        // ✅ 단순 직원 순서만 저장
        let employeeOrder = [];
        if (latestLayout && latestLayout.layout_data && latestLayout.layout_data.length > 0) {
            // 첫 번째 팀의 members를 순서로 사용
            employeeOrder = latestLayout.layout_data[0].members || [];
        }
        state.schedule.teamLayout = {
            month: dayjs(date).format('YYYY-MM'),
            data: employeeOrder.length > 0 ? [{ id: 'main', name: '직원 목록', members: employeeOrder }] : []
        };
        state.schedule.schedules = scheduleRes.data || [];
        state.schedule.companyHolidays = new Set((holidayRes.data || []).map(h => h.date));

        console.log('State updated:', {
            teamLayout: state.schedule.teamLayout,
            schedulesCount: state.schedule.schedules.length,
            holidaysCount: state.schedule.companyHolidays.size
        });

        const titleEl = _('#calendar-title');
        if (titleEl) {
            titleEl.textContent = dayjs(date).format('YYYY년 M월');
        }

        // ✨ 순서 변경: 달력을 먼저 렌더링
        renderCalendar();

        // ✨ 그 다음 사이드바 렌더링 (이때 달력의 day-events가 존재함)
        await renderScheduleSidebar();

        // 관리자 모드일 경우 확정 상태 체크
        if (state.currentUser?.isManager) {
            await checkScheduleConfirmationStatus();
        }

        console.log('Rendering complete');
    } catch (error) {
        console.error("스케줄 데이터 로딩 실패:", error);
        alert('스케줄 데이터를 불러오는 데 실패했습니다: ' + error.message);
    }
}

function initializeSortableAndDraggable() {
    state.schedule.sortableInstances.forEach(s => s.destroy());
    state.schedule.sortableInstances = [];

    // ✅ 직원 리스트에 Sortable 적용
    const employeeList = document.querySelector('.employee-list');
    if (employeeList) {
        const sortableInstance = new Sortable(employeeList, {
            group: {
                name: 'sidebar-employees',
                pull: function (to, from, dragEl) {
                    // 달력으로 드래그할 때는 복사, 제외 목록으로는 이동
                    if (to.el.classList.contains('day-events')) {
                        return 'clone'; // 복사 모드
                    } else {
                        return true; // 이동 모드
                    }
                },
                put: true
            },
            draggable: '.draggable-employee, .list-spacer',
            animation: 150,
            ghostClass: 'sortable-ghost',
            sort: true,
            forceFallback: false,

            onStart(evt) {
                isDragging = true;
                dragStartTime = Date.now();
                document.body.style.userSelect = 'none';
                const empId = evt.item.dataset.employeeId;
                console.log(`👉 [Sidebar] Drag started - Employee ID: ${empId}`);

                // ✨ 달력 영역 강조
                document.querySelectorAll('.day-events').forEach(el => {
                    el.style.minHeight = '100px';
                    el.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
                    el.style.border = '2px dashed rgba(59, 130, 246, 0.3)';
                });
            },

            onEnd(evt) {
                setTimeout(() => {
                    isDragging = false;
                }, 100);
                document.body.style.userSelect = '';

                const toClasses = evt.to.className;
                const isCalendar = toClasses.includes('day-events');
                const isExcluded = toClasses.includes('excluded-list');
                console.log(`👉 [Sidebar] Drag ended - To: ${toClasses}, Calendar: ${isCalendar}, Excluded: ${isExcluded}`);

                // ✨ 달력 강조 제거
                document.querySelectorAll('.day-events').forEach(el => {
                    el.style.minHeight = '';
                    el.style.backgroundColor = '';
                    el.style.border = '';
                });
            },

            onClone(evt) {
                console.log(`👉 [Sidebar] Employee cloned for drag`);
            },
        });

        state.schedule.sortableInstances.push(sortableInstance);
    }

    // ✅ 제외 목록에도 Sortable 적용
    const excludedList = document.querySelector('.excluded-list');
    if (excludedList) {
        const excludedSortable = new Sortable(excludedList, {
            group: {
                name: 'sidebar-employees',
                pull: true, // 이동 모드
                put: true
            },
            draggable: '.draggable-employee',
            animation: 150,
            ghostClass: 'sortable-ghost',
            sort: true,

            onAdd(evt) {
                console.log(`🚫 직원이 제외 목록으로 이동됨`);
            }
        });

        state.schedule.sortableInstances.push(excludedSortable);
    }

    console.log('✅ Initialized', state.schedule.sortableInstances.length, 'sidebar sortable instances');
    console.log('✅ Calendar has', document.querySelectorAll('.day-events').length, 'droppable day-events');

    // ✨ 디버깅: 첫 번째 day-events의 Sortable 설정 확인
    const firstDayEvent = document.querySelector('.day-events');
    if (firstDayEvent && firstDayEvent.sortableInstance) {
        console.log('✅ First day-events Sortable group:', firstDayEvent.sortableInstance.option('group'));
    } else {
        console.log('❌ First day-events has no Sortable instance!');
    }
}

async function renderScheduleSidebar() {
    const sidebar = _('#schedule-sidebar-area');
    if (!sidebar) return;

    const filteredEmployees = getFilteredEmployees();

    // ✅ 중복 제거: 각 직원을 한 번씩만 표시
    const uniqueEmployees = Array.from(new Map(
        filteredEmployees.map(emp => [emp.id, emp])
    ).values());

    // ✅ 저장된 순서가 있으면 그 순서대로 정렬
    let orderedEmployees = [];
    let excludedEmployees = [];
    const savedLayout = state.schedule.teamLayout?.data?.[0];

    if (savedLayout && savedLayout.members && savedLayout.members.length > 0) {
        console.log('📋 저장된 순서 적용:', savedLayout.members);

        // 저장된 순서대로 직원 배치 (빈칸 포함)
        savedLayout.members.forEach(memberId => {
            if (memberId < 0) {
                // 음수 ID는 빈칸
                orderedEmployees.push({ id: memberId, isSpacer: true, name: `빈칸${-memberId}` });
            } else {
                const emp = uniqueEmployees.find(e => e.id === memberId);
                if (emp) {
                    orderedEmployees.push(emp);
                }
            }
        });

        // ✅ 저장된 순서에 없는 직원들은 제외 목록으로
        uniqueEmployees.forEach(emp => {
            if (!savedLayout.members.includes(emp.id)) {
                excludedEmployees.push(emp);
            }
        });
    } else {
        // 저장된 순서가 없으면 기본 순서 사용
        orderedEmployees = uniqueEmployees;
        console.log('📋 기본 순서 사용');
    }

    console.log('📋 사이드바 직원 수:', orderedEmployees.length);
    console.log('🚫 제외된 직원 수:', excludedEmployees.length);

    // HTML 생성 - 직원 목록
    const employeeListHtml = orderedEmployees.map(item => {
        if (item.isSpacer) {
            // 빈칸: 배경색과 텍스트색 동일
            return `<div class="draggable-employee" data-employee-id="${item.id}" data-type="employee">
                <span class="handle">☰</span>
                <div class="fc-draggable-item" style="background-color: #f3f4f6;">
                    <span style="background-color: #f3f4f6;" class="department-dot"></span>
                    <span class="flex-grow font-semibold" style="color: #f3f4f6;">${item.name}</span>
                </div>
            </div>`;
        } else {
            return getEmployeeHtml(item);
        }
    }).join('');

    // HTML 생성 - 제외 목록
    const excludedListHtml = excludedEmployees.map(emp => getEmployeeHtml(emp)).join('');

    sidebar.innerHTML = `
        <div class="flex flex-col h-full">
            <div class="flex justify-between items-center mb-2 pb-2 border-b">
                <h3 class="font-bold text-sm">직원 목록</h3>
                <button id="save-employee-order-btn" class="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 font-bold whitespace-nowrap">순서저장</button>
            </div>
            <div class="flex-grow overflow-y-auto pr-2" id="employee-list-container">
                <div class="employee-list">
                    ${employeeListHtml}
                </div>
            </div>
            <div class="mt-2 pt-2 border-t">
                <button id="add-spacer-btn" class="w-full text-sm py-2 px-2 border border-dashed rounded-lg text-gray-600 hover:bg-gray-100">📄 빈 칸 추가</button>
            </div>
            <div class="mt-2 pt-2 border-t">
                <h3 class="font-bold text-xs text-gray-500 mb-2">🚫 리셋 제외 목록</h3>
                <div class="excluded-list min-h-[80px] p-2 bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg">
                    ${excludedListHtml}
                </div>
                <p class="text-xs text-gray-400 mt-1">여기로 드래그하면 리셋 시 제외됩니다</p>
            </div>
        </div>`;

    _('#add-spacer-btn')?.addEventListener('click', handleAddSpacer);
    _('#save-employee-order-btn')?.addEventListener('click', handleSaveEmployeeOrder);
    sidebar.addEventListener('click', handleDeleteSpacer);

    initializeSortableAndDraggable();
}

export async function renderScheduleManagement(container, isReadOnly = false) {
    console.log('renderScheduleManagement called', { isReadOnly });

    if (!state.schedule) {
        state.schedule = {
            currentDate: dayjs().format('YYYY-MM-DD'),
            viewMode: 'working',
            teamLayout: { month: '', data: [] },
            schedules: [],
            activeDepartmentFilters: new Set(),
            companyHolidays: new Set(),
            activeReorder: { date: null, sortable: null },
            sortableInstances: []
        };
    }
    state.schedule.isReadOnly = isReadOnly; // ✅ ReadOnly 상태 저장

    if (!state.management) {
        console.error('state.management is not initialized');
        container.innerHTML = '<div class="p-4 text-red-600">관리 데이터를 불러올 수 없습니다. 페이지를 새로고침해주세요.</div>';
        return;
    }

    const departments = state.management.departments || [];
    const deptFilterHtml = departments.map(dept =>
        `<div class="flex items-center">
            <input id="dept-${dept.id}" type="checkbox" value="${dept.id}" class="dept-filter-checkbox h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500">
            <label for="dept-${dept.id}" class="ml-2 text-sm text-gray-700">${dept.name}</label>
        </div>`
    ).join('');

    // Conditional sidebar HTML
    const sidebarHtml = isReadOnly ? '' : `
        <div id="schedule-sidebar-area"></div>
    `;

    // Conditional top control buttons HTML
    const topControlsHtml = isReadOnly ? `
        <div class="flex justify-between items-center mb-2 pb-2 border-b">
            <div id="schedule-view-toggle" class="flex rounded-md shadow-sm" role="group">
                <button type="button" data-mode="working" class="schedule-view-btn active rounded-l-lg">근무자 보기</button>
                <button type="button" data-mode="off" class="schedule-view-btn rounded-r-md">휴무자 보기</button>
            </div>
        </div>
    ` : `
        <div class="flex justify-between items-center mb-2 pb-2 border-b">
            <div id="schedule-view-toggle" class="flex rounded-md shadow-sm" role="group">
                <button type="button" data-mode="working" class="schedule-view-btn active rounded-l-lg">근무자 보기</button>
                <button type="button" data-mode="off" class="schedule-view-btn rounded-r-md">휴무자 보기</button>
            </div>
            <div class="flex items-center gap-2">
                <button id="confirm-schedule-btn" class="bg-green-600 text-white hover:bg-green-700">스케줄 확정</button>
                <button id="reset-schedule-btn" class="bg-green-600 text-white hover:bg-green-700">🔄 스케줄 리셋</button>
                <button id="print-schedule-btn">🖨️ 인쇄하기</button>
                <button id="revert-schedule-btn" disabled>🔄 되돌리기</button>
                <button id="save-schedule-btn" disabled>💾 스케줄 저장</button>
            </div>
        </div>
    `;

    container.innerHTML = `
        <div class="schedule-grid">
            <div class="schedule-main-content">
                ${topControlsHtml}
                <div id="department-filters" class="flex items-center flex-wrap gap-4 my-4 text-sm">
                    <span class="font-semibold">부서 필터:</span>${deptFilterHtml}
                </div>
                <div class="calendar-controls flex items-center justify-between mb-4">
                    <button id="calendar-prev" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">◀ 이전</button>
                    <div class="flex items-center">
                        <h2 id="calendar-title" class="text-2xl font-bold"></h2>
                        <span id="schedule-status-badge" class="px-3 py-1 rounded-full text-sm font-bold ml-2 hidden"></span>
                    </div>
                    <button id="calendar-next" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">다음 ▶</button>
                    <button id="calendar-today" class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700">오늘</button>
                </div>
                <div id="pure-calendar"></div>
            </div>
            ${sidebarHtml}
        </div>
    `;

    console.log('HTML rendered');

    _('#schedule-view-toggle')?.addEventListener('click', handleViewModeChange);
    _('#department-filters')?.addEventListener('change', handleDepartmentFilterChange);
    _('#print-schedule-btn')?.addEventListener('click', handlePrintSchedule); // Always available

    // Only attach these if not read-only
    if (!isReadOnly) {
        _('#save-schedule-btn')?.addEventListener('click', handleSaveSchedules);
        _('#revert-schedule-btn')?.addEventListener('click', handleRevertChanges);
        _('#reset-schedule-btn')?.addEventListener('click', handleResetSchedule);
    }

    _('#calendar-prev')?.addEventListener('click', () => navigateMonth('prev'));
    _('#calendar-next')?.addEventListener('click', () => navigateMonth('next'));
    _('#calendar-today')?.addEventListener('click', () => navigateMonth('today'));


    console.log('Event listeners attached');

    try {
        await loadAndRenderScheduleData(state.schedule.currentDate);
        updateViewModeButtons();
        console.log('Initial render complete');
    } catch (error) {
        console.error('Error in initial render:', error);
        alert('초기 데이터 로딩에 실패했습니다: ' + error.message);
    }
}

// ✨ 인쇄 핸들러 - 캡쳐 방식으로 변경
async function handlePrintSchedule() {
    const currentDate = dayjs(state.schedule.currentDate);
    const viewModeText = state.schedule.viewMode === 'working' ? '근무자 명단' : '휴무자 명단';

    // 달력 요소
    const calendarEl = _('#pure-calendar');
    if (!calendarEl) {
        alert('달력을 찾을 수 없습니다.');
        return;
    }

    try {
        // 버튼 비활성화
        const printBtn = _('#print-schedule-btn');
        printBtn.disabled = true;
        printBtn.textContent = '캡쳐 중...';

        // html2canvas로 달력 캡쳐
        const canvas = await html2canvas(calendarEl, {
            scale: 2, // 고해상도
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
        });

        // 새 창에 이미지 표시 및 인쇄
        const imgData = canvas.toDataURL('image/png');
        const printWindow = window.open('', '_blank');

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${currentDate.format('YYYY년 M월')} 스케줄 - ${viewModeText}</title>
                <style>
                    @page {
                        size: A4 landscape;
                        margin: 10mm;
                    }
                    * {
                        margin: 0;
                        padding: 0;
                    }
                    body {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        background: white;
                    }
                    .print-header {
                        text-align: center;
                        margin-bottom: 10px;
                    }
                    h1 {
                        font-size: 20pt;
                        font-weight: bold;
                        margin-bottom: 5px;
                    }
                    p {
                        font-size: 12pt;
                        color: #666;
                    }
                    img {
                        max-width: 100%;
                        height: auto;
                        display: block;
                    }
                    @media print {
                        body {
                            min-height: auto;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="print-header">
                    <h1>${currentDate.format('YYYY년 M월')} 스케줄</h1>
                    <p>${viewModeText}</p>
                </div>
                <img src="${imgData}" />
                <script>
                    window.onload = function() {
                        window.print();
                        // 인쇄 완료 후 창 닫기
                        setTimeout(() => window.close(), 100);
                    };
                </script>
            </body>
            </html>
        `);

        printWindow.document.close();

    } catch (error) {
        console.error('캡쳐 실패:', error);
        alert('캡쳐에 실패했습니다: ' + error.message);
    } finally {
        // 버튼 복구
        const printBtn = _('#print-schedule-btn');
        printBtn.disabled = false;
        printBtn.textContent = '🖨️ 인쇄하기';
    }
}

// =========================================================================================
// [신규] 스케줄 확정 관련 기능
// =========================================================================================

async function checkScheduleConfirmationStatus() {
    const viewDate = state.schedule.currentDate || dayjs().format('YYYY-MM-DD');
    const month = dayjs(viewDate).format('YYYY-MM');

    try {
        const { data, error } = await db.from('schedule_confirmations')
            .select('*')
            .eq('month', month)
            .single();

        const badge = document.querySelector('#schedule-status-badge');
        const confirmBtn = document.querySelector('#confirm-schedule-btn');

        if (data && data.is_confirmed) {
            // 확정됨
            if (badge) {
                badge.textContent = '확정됨';
                badge.className = 'px-3 py-1 rounded-full text-sm font-bold ml-2 bg-green-100 text-green-800';
                badge.classList.remove('hidden');
            }
            if (confirmBtn) {
                confirmBtn.textContent = '확정 해제';
                confirmBtn.className = 'px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 font-bold';
                confirmBtn.onclick = () => handleConfirmSchedule(false); // 해제 모드
            }
        } else {
            // 미확정
            if (badge) {
                badge.textContent = '미확정';
                badge.className = 'px-3 py-1 rounded-full text-sm font-bold ml-2 bg-yellow-100 text-yellow-800';
                badge.classList.remove('hidden');
            }
            if (confirmBtn) {
                confirmBtn.textContent = '스케줄 확정';
                confirmBtn.className = 'px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-bold';
                confirmBtn.onclick = () => handleConfirmSchedule(true); // 확정 모드
            }
        }
    } catch (err) {
        console.error('확정 상태 확인 실패:', err);
    }
}

async function handleConfirmSchedule(isConfirm = true) {
    const viewDate = state.schedule.currentDate || dayjs().format('YYYY-MM-DD');
    const month = dayjs(viewDate).format('YYYY-MM');

    const message = isConfirm
        ? `${month}월 스케줄을 확정하시겠습니까?\n확정 후에는 직원들이 스케줄을 볼 수 있습니다.`
        : `${month}월 스케줄 확정을 해제하시겠습니까?\n해제 시 직원들은 스케줄을 볼 수 없게 됩니다.`;

    if (!confirm(message)) return;

    try {
        // Upsert logic
        const { error } = await db.from('schedule_confirmations')
            .upsert({
                month: month,
                is_confirmed: isConfirm,
                confirmed_at: new Date().toISOString()
            }, { onConflict: 'month' });

        if (error) throw error;

        alert(isConfirm ? '스케줄이 확정되었습니다.' : '스케줄 확정이 해제되었습니다.');
        checkScheduleConfirmationStatus(); // UI 갱신

    } catch (error) {
        console.error('스케줄 확정 오류:', error);
        alert('오류가 발생했습니다: ' + error.message);
    }
}
