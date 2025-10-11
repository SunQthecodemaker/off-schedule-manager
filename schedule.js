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

function updateScheduleSortOrders(dateStr) {
    const dayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
    if (!dayEl) return;
    const eventContainer = dayEl.querySelector('.day-events');
    if (!eventContainer) return;
    
    const orderedIds = [];
    const eventCards = eventContainer.querySelectorAll('.event-card');
    eventCards.forEach(card => {
        const empId = parseInt(card.dataset.employeeId, 10);
        if (!isNaN(empId)) orderedIds.push(empId);
    });
    
    orderedIds.forEach((employeeId, index) => {
        let schedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === employeeId);
        if (schedule) {
            if (schedule.sort_order !== index) {
                schedule.sort_order = index;
                unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
            }
        } else {
            const tempId = `temp-${Date.now()}-${employeeId}`;
            const newSchedule = { 
                id: tempId, 
                date: dateStr, 
                employee_id: employeeId, 
                status: '근무', 
                sort_order: index
            };
            state.schedule.schedules.push(newSchedule);
            unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
        }
    });
}

function getDepartmentColor(departmentId) {
    if (!departmentId) return '#cccccc';
    const colors = ['#4f46e5', '#db2777', '#16a34a', '#f97316', '#0891b2', '#6d28d9', '#ca8a04'];
    return colors[departmentId % colors.length];
}

function getSpacerHtml() {
    return `<div class="list-spacer" data-type="spacer"><span class="handle">☰</span><button class="delete-spacer-btn" title="빈 칸 삭제">×</button></div>`;
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
        if (memberId === '---spacer---') return getSpacerHtml();
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

async function handleRevertChanges() {
    if (confirm("정말로 모든 변경사항을 되돌리시겠습니까?")) {
        await loadAndRenderScheduleData(state.schedule.currentDate);
    }
}

async function handleSaveSchedules() {
    _('#save-schedule-btn').disabled = true;
    _('#save-schedule-btn').textContent = '저장 중...';

    const toInsert = [], toUpdate = new Map(), toDelete = [];
    for (const [id, change] of unsavedChanges.entries()) {
        if (change.type === 'new') {
            // ✨ temp ID 제거하고 데이터만 추가
            const { id: tempId, ...dataWithoutId } = change.data;
            toInsert.push(dataWithoutId);
        }
        else if (change.type === 'update') toUpdate.set(change.data.id, change.data);
        else if (change.type === 'delete' && typeof id === 'number') toDelete.push(id);
    }
    const holidaysToAdd = Array.from(unsavedHolidayChanges.toAdd).map(date => ({ date }));
    const holidaysToRemove = Array.from(unsavedHolidayChanges.toRemove);

    try {
        const promises = [];
        if (toInsert.length > 0) {
            console.log('Inserting schedules:', toInsert);
            promises.push(db.from('schedules').insert(toInsert));
        }
        if (toDelete.length > 0) promises.push(db.from('schedules').delete().in('id', toDelete));
        if (toUpdate.size > 0) promises.push(...Array.from(toUpdate.values()).map(item => 
            db.from('schedules')
              .update({ date: item.date, status: item.status, sort_order: item.sort_order })
              .eq('id', item.id)
        ));
        if (holidaysToAdd.length > 0) promises.push(db.from('company_holidays').insert(holidaysToAdd));
        if (holidaysToRemove.length > 0) promises.push(db.from('company_holidays').delete().in('date', holidaysToRemove));
        const results = await Promise.all(promises);
        for (const res of results) if (res.error) throw res.error;
        alert('스케줄 및 휴무일 정보가 성공적으로 저장되었습니다.');
        await loadAndRenderScheduleData(state.schedule.currentDate);
    } catch (error) {
        console.error('스케줄 저장 실패:', error);
        alert(`스케줄 저장에 실패했습니다: ${error.message}`);
    } finally {
        updateSaveButtonState();
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
    _('#unassigned-list').insertAdjacentHTML('beforeend', getSpacerHtml());
}

function handleDeleteSpacer(e) {
    if (e.target.matches('.delete-spacer-btn, .delete-separator-btn')) {
        e.target.closest('[data-type]').remove();
    }
}

async function handleSaveTeamLayout() {
    const saveBtn = _('#save-team-layout-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';
    const layoutData = [];
    document.querySelectorAll('#team-list-container .team-group').forEach(teamEl => {
        if (teamEl.classList.contains('unassigned-group')) return;
        const teamId = teamEl.dataset.teamId;
        const teamName = teamEl.querySelector('.team-header-input').value;
        const members = [];
        teamEl.querySelectorAll('.team-member-list > div').forEach(memberEl => {
            const type = memberEl.dataset.type;
            if (type === 'employee') members.push(parseInt(memberEl.dataset.employeeId, 10));
            else if (type === 'separator') members.push('---separator---');
            else if (type === 'spacer') members.push('---spacer---');
        });
        layoutData.push({ id: teamId, name: teamName, members });
    });
    const month = dayjs(state.schedule.currentDate).format('YYYY-MM-01');
    const managerUuid = state.currentUser?.auth_uuid;
    if (!managerUuid) {
        alert('로그인 정보가 올바르지 않습니다. 다시 로그인해주세요.');
        saveBtn.disabled = false;
        saveBtn.textContent = '팀/순서 저장';
        return;
    }
    try {
        const { error } = await db.from('team_layouts').upsert({ month, layout_data: layoutData, manager_id: managerUuid }, { onConflict: 'month' });
        if (error) throw error;
        alert('팀/직원 순서가 성공적으로 저장되었습니다.');
        await loadAndRenderScheduleData(state.schedule.currentDate);
    } catch (error) {
        console.error('팀 레이아웃 저장 실패:', error);
        alert(`팀/직원 순서 저장에 실패했습니다: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '팀/순서 저장';
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
function initializeDayDragDrop(dayEl, dateStr) {
    const eventContainer = dayEl.querySelector('.day-events');
    if (!eventContainer) return;
    
    if (eventContainer.sortableInstance) {
        eventContainer.sortableInstance.destroy();
    }
    
    // ✨ 날짜 칸에 드롭존 설정
    eventContainer.sortableInstance = new Sortable(eventContainer, {
        group: {
            name: 'calendar-group',
            pull: true,
            put: ['sidebar-group', 'calendar-group'] // ✨ 명시적으로 받을 그룹 지정
        },
        draggable: '.event-card, .draggable-employee',
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        chosenClass: 'sortable-chosen',
        dragoverBubble: true,
        delay: 100,
        delayOnTouchOnly: false,
        forceFallback: false, // ✨ HTML5 드래그 사용
        fallbackTolerance: 5,
        emptyInsertThreshold: 30,
        
        onStart(evt) {
            isDragging = true;
            dragStartTime = Date.now();
            document.body.style.userSelect = 'none';
            document.querySelectorAll('.day-events').forEach(el => {
                el.style.minHeight = '100px';
                el.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
                el.style.border = '2px dashed rgba(59, 130, 246, 0.3)';
            });
            console.log('📅 Calendar drag started');
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
            console.log('📅 Calendar drag ended');
        },
        
        onUpdate(evt) {
            console.log('📅 Calendar onUpdate');
            updateScheduleSortOrders(dateStr);
            updateSaveButtonState();
        },
        
        onAdd(evt) {
            console.log('🎯 Calendar onAdd triggered! Date:', dateStr);
            const employeeEl = evt.item;
            
            // event-card인 경우는 다른 날짜에서 온 것
            if (employeeEl.classList.contains('event-card')) {
                console.log('✅ Moved from another date');
                updateScheduleSortOrders(dateStr);
                updateSaveButtonState();
                return;
            }
            
            // draggable-employee인 경우 사이드바에서 온 것
            const empId = parseInt(employeeEl.dataset.employeeId, 10);
            console.log('📝 Dropped employee ID:', empId);
            
            if (isNaN(empId) || !empId) {
                console.log('❌ Invalid employee ID, removing element');
                employeeEl.remove();
                return;
            }
            
            const employee = state.management.employees.find(e => e.id === empId);
            if (!employee) {
                console.log('❌ Employee not found, removing element');
                employeeEl.remove();
                return;
            }
            
            console.log('✅ Found employee:', employee.name);
            
            let schedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === empId);
            
            if (!schedule) {
                const maxOrder = Math.max(
                    -1,
                    ...state.schedule.schedules
                        .filter(s => s.date === dateStr)
                        .map(s => s.sort_order)
                        .filter(o => o !== null && o !== undefined)
                );
                
                const tempId = `temp-${Date.now()}-${empId}`;
                schedule = {
                    id: tempId,
                    date: dateStr,
                    employee_id: empId,
                    status: state.schedule.viewMode === 'working' ? '근무' : '휴무',
                    sort_order: maxOrder + 1
                };
                state.schedule.schedules.push(schedule);
                unsavedChanges.set(tempId, { type: 'new', data: schedule });
                console.log('✅ Created new schedule:', schedule);
            } else {
                const newStatus = state.schedule.viewMode === 'working' ? '근무' : '휴무';
                if (schedule.status !== newStatus) {
                    schedule.status = newStatus;
                    unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                    console.log('✅ Updated schedule status:', schedule);
                }
            }
            
            employeeEl.remove();
            renderCalendar();
            updateSaveButtonState();
        },
    });
}

function getWorkingEmployeesOnDate(dateStr) {
    const filteredEmployees = getFilteredEmployees();
    const masterOrderMap = new Map();
    state.schedule.teamLayout.data.flatMap(team => team.members)
        .forEach((id, index) => {
            if (typeof id === 'number') masterOrderMap.set(id, index);
        });

    const workingEmps = [];
    
    filteredEmployees.forEach(emp => {
        const explicitSchedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === emp.id);
        
        if (explicitSchedule) {
            if (explicitSchedule.status === '근무') {
                workingEmps.push(emp);
            }
            return;
        }
        
        const isLeave = state.management.leaveRequests.some(r => r.status === 'approved' && r.employee_id === emp.id && r.dates.includes(dateStr));
        const isHoliday = state.schedule.companyHolidays.has(dateStr);
        const isDefaultOff = dayjs(dateStr).day() === 0;
        
        if (!isLeave && !isHoliday && !isDefaultOff) {
            workingEmps.push(emp);
        }
    });

    workingEmps.sort((a, b) => {
        const scheduleA = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === a.id);
        const scheduleB = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === b.id);

        const orderA = scheduleA?.sort_order;
        const orderB = scheduleB?.sort_order;

        if (orderA !== null && typeof orderA !== 'undefined' && orderB !== null && typeof orderB !== 'undefined') return orderA - orderB;
        if (orderA !== null && typeof orderA !== 'undefined') return -1;
        if (orderB !== null && typeof orderB !== 'undefined') return 1;

        const masterIndexA = masterOrderMap.get(a.id) ?? 999;
        const masterIndexB = masterOrderMap.get(b.id) ?? 999;
        
        return masterIndexA - masterIndexB;
    });

    return workingEmps;
}

function getOffEmployeesOnDate(dateStr) {
    const filteredEmployees = getFilteredEmployees();
    const masterOrderMap = new Map();
    state.schedule.teamLayout.data.flatMap(team => team.members)
        .forEach((id, index) => {
            if (typeof id === 'number') masterOrderMap.set(id, index);
        });

    const offEmps = [];
    
    filteredEmployees.forEach(emp => {
        const explicitSchedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === emp.id);
        
        if (explicitSchedule && explicitSchedule.status === '휴무') {
            offEmps.push({ employee: emp, schedule: explicitSchedule, type: '휴무' });
            return;
        }
        
        if (!explicitSchedule) {
            const isLeave = state.management.leaveRequests.some(r => r.status === 'approved' && r.employee_id === emp.id && r.dates.includes(dateStr));
            if (isLeave) {
                offEmps.push({ employee: emp, schedule: null, type: 'leave' });
            }
        }
    });
    
    offEmps.sort((a, b) => {
        const orderA = a.schedule?.sort_order;
        const orderB = b.schedule?.sort_order;

        if (orderA !== null && typeof orderA !== 'undefined' && orderB !== null && typeof orderB !== 'undefined') return orderA - orderB;
        if (orderA !== null && typeof orderA !== 'undefined') return -1;
        if (orderB !== null && typeof orderB !== 'undefined') return 1;

        const masterIndexA = masterOrderMap.get(a.employee.id) ?? 999;
        const masterIndexB = masterOrderMap.get(b.employee.id) ?? 999;
        
        return masterIndexA - masterIndexB;
    });

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
    
    // 연차는 클릭 불가
    if (type === 'leave') {
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
            const employees = getWorkingEmployeesOnDate(dateStr);
            eventsHTML = employees.map(emp => {
                const schedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === emp.id);
                const scheduleId = schedule?.id || '';
                const deptColor = getDepartmentColor(emp.departments?.id);
                // ✨ 삭제 버튼 제거
                return `<div class="event-card event-working" data-employee-id="${emp.id}" data-schedule-id="${scheduleId}" data-type="working">
                    <span class="event-dot" style="background-color: ${deptColor};"></span>
                    <span class="event-name">${emp.name}</span>
                </div>`;
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
        state.schedule.teamLayout = { 
            month: dayjs(date).format('YYYY-MM'), 
            data: latestLayout ? latestLayout.layout_data : [] 
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
        
        console.log('Rendering complete');
    } catch (error) {
        console.error("스케줄 데이터 로딩 실패:", error);
        alert('스케줄 데이터를 불러오는 데 실패했습니다: ' + error.message);
    }
}

function initializeSortableAndDraggable() {
    state.schedule.sortableInstances.forEach(s => s.destroy());
    state.schedule.sortableInstances = [];
    
    const container = _('#team-list-container');
    if (container) {
        new Sortable(container, { 
            group: 'teams', 
            handle: '.handle', 
            animation: 150, 
            ghostClass: 'sortable-ghost', 
            filter: '.unassigned-group' 
        });
    }
    
    // ✨ 사이드바 직원 리스트
    document.querySelectorAll('.team-member-list').forEach((list, index) => {
        const sortableInstance = new Sortable(list, { 
            group: {
                name: 'sidebar-group', // ✨ 고유한 그룹명
                pull: 'clone', // ✨ 복사 모드 (사이드바에 유지)
                put: true
            },
            draggable: '.draggable-employee, .list-spacer',
            animation: 150, 
            ghostClass: 'sortable-ghost',
            sort: true,
            forceFallback: false, // ✨ HTML5 드래그 사용
            
            onStart(evt) {
                isDragging = true;
                dragStartTime = Date.now();
                document.body.style.userSelect = 'none';
                const empId = evt.item.dataset.employeeId;
                console.log(`👉 [Sidebar ${index}] Drag started - Employee ID: ${empId}`);
                
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
                console.log(`👉 [Sidebar ${index}] Drag ended - To: ${toClasses}, isCalendar: ${isCalendar}`);
                
                // ✨ 달력 강조 제거
                document.querySelectorAll('.day-events').forEach(el => {
                    el.style.minHeight = '';
                    el.style.backgroundColor = '';
                    el.style.border = '';
                });
            },
            
            onClone(evt) {
                console.log(`👉 [Sidebar ${index}] Employee cloned for drag`);
            },
        });
        
        state.schedule.sortableInstances.push(sortableInstance);
    });
    
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
    const { teamLayout } = state.schedule;
    const filteredEmployees = getFilteredEmployees();
    let teamData = teamLayout.data || [];
    
    const assignedEmployeeIds = new Set(teamData.flatMap(team => team.members.filter(m => typeof m === 'number')));
    const unassignedEmployees = filteredEmployees.filter(emp => !assignedEmployeeIds.has(emp.id));

    sidebar.innerHTML = `
        <div class="flex flex-col h-full">
            <div class="flex justify-between items-center mb-2 pb-2 border-b">
                <h3 class="font-bold">팀 / 직원 목록</h3>
                <button id="save-team-layout-btn" class="text-sm px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold">팀/순서 저장</button>
            </div>
            <div class="flex-grow overflow-y-auto pr-2" id="team-list-container">
                ${teamData.map(team => getTeamHtml(team, filteredEmployees)).join('')}
                <div class="team-group unassigned-group">
                    <div class="team-header text-sm font-semibold text-gray-600 p-2">미지정 직원</div>
                    <div class="team-member-list" id="unassigned-list">${unassignedEmployees.map(emp => getEmployeeHtml(emp)).join('')}</div>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
                <button id="add-new-team-btn" class="w-full mt-2 text-sm py-2 px-2 border border-dashed rounded-lg text-gray-600 hover:bg-gray-100">+ 새 팀 추가</button>
                <button id="add-separator-btn" class="w-full mt-2 text-sm py-2 px-2 border border-dashed rounded-lg text-gray-600 hover:bg-gray-100">-- 구분선 추가</button>
                <button id="add-spacer-btn" class="col-span-2 w-full mt-2 text-sm py-2 px-2 border border-dashed rounded-lg text-gray-600 hover:bg-gray-100">📄 빈 칸 추가</button>
            </div>
        </div>`;
    _('#add-new-team-btn').addEventListener('click', handleAddNewTeam);
    _('#add-separator-btn').addEventListener('click', handleAddSeparator);
    _('#add-spacer-btn').addEventListener('click', handleAddSpacer);
    _('#save-team-layout-btn').addEventListener('click', handleSaveTeamLayout);
    sidebar.addEventListener('click', handleDeleteSpacer);
    document.querySelectorAll('.delete-team-btn').forEach(btn => btn.addEventListener('click', handleDeleteTeam));
    initializeSortableAndDraggable();
}

export async function renderScheduleManagement(container) {
    console.log('renderScheduleManagement called');
    
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
    
    container.innerHTML = `
        <div class="schedule-grid">
            <div class="schedule-main-content">
                <div class="flex justify-between items-center mb-2 pb-2 border-b">
                    <div id="schedule-view-toggle" class="flex rounded-md shadow-sm" role="group">
                        <button type="button" data-mode="working" class="schedule-view-btn active rounded-l-lg">근무자 보기</button>
                        <button type="button" data-mode="off" class="schedule-view-btn rounded-r-md">휴무자 보기</button>
                    </div>
                    <div class="flex items-center gap-2">
                        <button id="print-schedule-btn">🖨️ 인쇄하기</button>
                        <button id="revert-schedule-btn" disabled>🔄 되돌리기</button>
                        <button id="save-schedule-btn" disabled>💾 스케줄 저장</button>
                    </div>
                </div>
                <div id="department-filters" class="flex items-center flex-wrap gap-4 my-4 text-sm">
                    <span class="font-semibold">부서 필터:</span>${deptFilterHtml}
                </div>
                <div class="calendar-controls flex items-center justify-between mb-4">
                    <button id="calendar-prev" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">◀ 이전</button>
                    <h2 id="calendar-title" class="text-2xl font-bold"></h2>
                    <button id="calendar-next" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">다음 ▶</button>
                    <button id="calendar-today" class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700">오늘</button>
                </div>
                <div id="pure-calendar"></div>
            </div>
            <div id="schedule-sidebar-area"></div>
        </div>
    `;
    
    console.log('HTML rendered');
    
    _('#schedule-view-toggle')?.addEventListener('click', handleViewModeChange);
    _('#department-filters')?.addEventListener('change', handleDepartmentFilterChange);
    _('#save-schedule-btn')?.addEventListener('click', handleSaveSchedules);
    _('#revert-schedule-btn')?.addEventListener('click', handleRevertChanges);
    _('#calendar-prev')?.addEventListener('click', () => navigateMonth('prev'));
    _('#calendar-next')?.addEventListener('click', () => navigateMonth('next'));
    _('#calendar-today')?.addEventListener('click', () => navigateMonth('today'));
    _('#print-schedule-btn')?.addEventListener('click', handlePrintSchedule);
    
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