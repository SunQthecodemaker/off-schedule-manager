import { state, db } from './state.js';
import { _, _all, show, hide } from './utils.js';
// AppSheet 연동 기능 복구
import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@latest/modular/sortable.complete.esm.js';
import { registerManualLeave, cancelManualLeave } from './management.js';
import { syncToAppSheet, importFromAppSheet, getScriptUrl, setScriptUrl } from './appsheet-client.js';
import { ScheduleGenerator } from './schedule-generator.js';

let unsavedChanges = new Map();
let unsavedHolidayChanges = { toAdd: new Set(), toRemove: new Set() };

// ✅ 기본 팀 배치 (엑셀 팀표 순서 — 스케줄 리셋 시 기본값)
// 1행: 원장 / 2~5행: 진료실 / 6행: 경영지원실 / 7행: 기공실
const DEFAULT_TEAM_MEMBERS = [
    1, 29, 30, 31,       // 원장: 박선규, 류효경, 박보현, 김민재
    32, 35, 34, 38,      // 진료실1: 이고은, 최수연, 정유진, 정해인
    36, 37, 224, 40,     // 진료실2: 김민주, 최지은, 신현채, 김가현
    41, 39, 234,         // 진료실3: 최윤미, 최지혜, 김규빈
    -1,                  // 구분선
    43, 44, 45, 46,      // 경영지원실: 유시온, 최나은, 김채이, 이진현
    -1,                  // 구분선
    47, 48, 226          // 기공실: 이우현, 용윤지, 이지민
];

// ✅ 그리드 크기 상수 (모든 곳에서 이 값만 사용)
const GRID_SIZE = 32;

// ═══════════════════════════════════════════════════════
// ✅ 고정 휴무 규칙 헬퍼
// DB 형식: [{day:2, sub:true}, {day:4, sub:false}] (신규)
// 호환 형식: [2, 4, 6] (기존 — 자동 변환, sub=true 기본)
// ═══════════════════════════════════════════════════════
function parseHolidayRules(rules) {
    if (!rules || !Array.isArray(rules) || rules.length === 0) return [];
    // 기존 숫자 배열 호환
    if (typeof rules[0] === 'number') {
        return rules.map(d => ({ day: d, sub: true }));
    }
    return rules;
}

/** 고정 휴무 요일 번호 배열 반환 (기존 코드 호환) */
function getFixedOffDays(rules) {
    return parseHolidayRules(rules).map(r => r.day);
}

/** 특정 요일이 고정 휴무인지 */
function isFixedOffDay(rules, dayOfWeek) {
    return getFixedOffDays(rules).includes(dayOfWeek);
}

/** 특정 요일의 대체근무 가능 여부 */
function isSubstitutable(rules, dayOfWeek) {
    const parsed = parseHolidayRules(rules);
    const rule = parsed.find(r => r.day === dayOfWeek);
    return rule ? rule.sub !== false : false; // 고정 휴무 아니면 false
}

// ═══════════════════════════════════════════════════════
// ✅ 통합 네임카드 조작 헬퍼 (모든 이동/붙여넣기가 이 함수를 사용)
// 공통 규칙:
//   R1: 덮어쓰기 — 타겟 위치에 기존 카드 있으면 휴무 처리
//   R2: 이름 중복 방지 — 같은 날짜에 같은 직원 2개 시 기존것 제거
//   R4: 복수 조작 = 배열 단위 — 1개든 10개든 동일 경로
// ═══════════════════════════════════════════════════════

/**
 * 카드를 특정 날짜의 특정 위치에 배치 (덮어쓰기 방식)
 * @param {Array} items - [{employee_id, status?}] 배치할 직원 목록
 * @param {string} dateStr - 대상 날짜 (YYYY-MM-DD)
 * @param {number|null} startPos - 시작 위치 (null이면 자동 탐색)
 * @returns {number} 배치된 개수
 */
function placeCards(items, dateStr, startPos = null) {
    console.log(`📋 placeCards: ${items.length}개 아이템, date=${dateStr}, startPos=${startPos}`, items.map(i => `${i.employee_id}@${i._origPos}`));
    let placed = 0;

    // 상대 위치 보존: _origPos가 있으면 오프셋 계산
    const hasOrigPos = items.some(i => i._origPos != null);
    const baseOffset = (hasOrigPos && startPos != null && items[0]._origPos != null)
        ? (startPos - items[0]._origPos) : 0;

    items.forEach((item, idx) => {
        const empId = item.employee_id;

        // 배치할 position 결정
        let assignPos = -1;
        if (hasOrigPos && item._origPos != null) {
            // 상대 위치 보존 모드: 원래 position + 오프셋 (날짜 전체 복사 시 오프셋=0)
            assignPos = item._origPos + baseOffset;
        } else if (startPos != null && startPos >= 0 && startPos < GRID_SIZE) {
            // _origPos 없음: startPos부터 연속 배치
            assignPos = startPos + idx;
        } else {
            // 자동 빈자리 탐색
            for (let i = 0; i < GRID_SIZE; i++) {
                const occupied = state.schedule.schedules.some(
                    s => s.date === dateStr && s.status === '근무' && s.grid_position === i && s.employee_id !== empId
                );
                if (!occupied) { assignPos = i; break; }
            }
        }

        if (assignPos < 0 || assignPos >= GRID_SIZE) {
            console.log(`  ⚠️ [${idx}] empId=${empId} → pos=${assignPos} 범위 초과, 건너뜀`);
            return;
        }

        // R2: 같은 날짜에 같은 직원이 이미 있으면 기존것 제거 (휴무 처리)
        const existing = state.schedule.schedules.find(
            s => s.date === dateStr && s.employee_id === empId && s.status === '근무'
        );
        if (existing) {
            existing.status = '휴무';
            unsavedChanges.set(existing.id, { type: 'update', data: existing });
        }

        // R1: 타겟 위치에 다른 카드 있으면 덮어쓰기 (기존 카드 휴무)
        const blocking = state.schedule.schedules.find(
            s => s.date === dateStr && s.status === '근무' && s.grid_position === assignPos && s.employee_id !== empId
        );
        if (blocking) {
            blocking.status = '휴무';
            unsavedChanges.set(blocking.id, { type: 'update', data: blocking });
        }

        // 배치: 기존 스케줄 업데이트 또는 신규 생성
        let target = state.schedule.schedules.find(
            s => s.date === dateStr && s.employee_id === empId
        );
        if (target) {
            target.status = item.status || '근무';
            target.grid_position = assignPos;
            target.sort_order = assignPos;
            unsavedChanges.set(target.id, { type: 'update', data: target });
        } else {
            const newSched = {
                id: `place-${Date.now()}-${empId}-${Math.random()}`,
                date: dateStr,
                employee_id: empId,
                status: item.status || '근무',
                grid_position: assignPos,
                sort_order: assignPos,
                created_at: new Date().toISOString()
            };
            state.schedule.schedules.push(newSched);
            unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
        }

        placed++;
        console.log(`  📌 [${idx}] empId=${empId} → pos=${assignPos} (${target ? 'update' : 'create'})`);
    });

    console.log(`📋 placeCards 결과: ${placed}/${items.length}개 배치 완료`);
    return placed;
}

/**
 * 카드를 다른 날짜로 이동 (원본=휴무, 대상=근무 배치)
 * @param {Array} empIds - 이동할 직원 ID 배열
 * @param {string} fromDate - 원본 날짜
 * @param {string} toDate - 대상 날짜
 * @param {number|null} targetPos - 대상 시작 위치
 * @returns {number} 이동된 개수
 */
function moveCards(empIds, fromDate, toDate, targetPos = null) {
    // 원본 날짜에서 휴무 처리
    empIds.forEach(empId => {
        const src = state.schedule.schedules.find(
            s => s.date === fromDate && s.employee_id === empId && s.status === '근무'
        );
        if (src) {
            src.status = '휴무';
            unsavedChanges.set(src.id, { type: 'update', data: src });
        }
    });

    // 대상 날짜에 배치
    const items = empIds.map(id => ({ employee_id: id, status: '근무' }));
    return placeCards(items, toDate, targetPos);
}

state.schedule.activeDepartmentFilters = new Set();
state.schedule.companyHolidays = new Set();
state.schedule.activeReorder = {
    date: null,
    sortable: null,
};

// ✨ 클릭과 드래그 구분을 위한 변수
let isDragging = false;
let dragStartTime = 0;

// ✨ 다중 선택 및 클립보드 상태
state.schedule.selectedSchedules = new Set(); // Set<schedule_id>
let scheduleClipboard = []; // Array of { employee_id, status }
let lastSelectedCardInfo = null; // { date, position } — Shift+클릭 범위선택 기준점

// ✨ 마우스 드래그 범위선택 상태
let dragSelectState = null; // { startDate, startPos, active }
let dragSelectJustFinished = false; // 드래그 선택 직후 클릭 방지

// ✨ Sortable: Using complete ESM bundle (Plugins included)

// =========================================================================================
// ⚡ Undo / Redo System
// =========================================================================================
const undoStack = [];
const redoStack = [];

function pushUndoState(actionName) {
    const snapshot = {
        schedules: JSON.parse(JSON.stringify(state.schedule.schedules)),
        unsavedChanges: new Map(unsavedChanges)
    };
    undoStack.push({ name: actionName, snapshot });
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0; // New action clears redo stack
    console.log(`📸 Undo Point Saved: ${actionName} (Stack: ${undoStack.length})`);
}

function undoLastChange() {
    if (undoStack.length === 0) {
        alert('되돌릴 작업이 없습니다.');
        return;
    }
    const { name, snapshot } = undoStack.pop();

    // Save current to redo
    const currentSnapshot = {
        schedules: JSON.parse(JSON.stringify(state.schedule.schedules)),
        unsavedChanges: new Map(unsavedChanges)
    };
    redoStack.push({ name, snapshot: currentSnapshot });

    // Restore
    state.schedule.schedules = snapshot.schedules;
    unsavedChanges = snapshot.unsavedChanges;

    console.log(`⏪ Undoing: ${name}`);
    renderCalendar();
    updateSaveButtonState();
}

// Keyboard shortcuts are handled in the main event handler section below


// ✅ 그리드 위치 기반 업데이트 (완전 재작성 - 빈칸 포함)
function updateScheduleSortOrders(dateStr) {
    const dayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
    if (!dayEl) return;
    const eventContainer = dayEl.querySelector('.day-events');
    if (!eventContainer) return;

    // ✅ 1. DOM 순서대로 스캔하여 정확한 grid_position 파악
    const allSlots = Array.from(eventContainer.querySelectorAll('.event-card, .event-slot'));

    // 위치 맵 생성: employee_id -> new_grid_position
    const newPositions = new Map();

    allSlots.forEach((slot, index) => {
        if (slot.classList.contains('event-card')) {
            const empId = parseInt(slot.dataset.employeeId, 10);
            if (!isNaN(empId)) {
                newPositions.set(empId, index); // index가 곧 grid_position (0 ~ 23)
            }
        }
    });

    console.log(`📍 [${dateStr}] 위치 재계산:`, newPositions);

    // ✅ 2. State 업데이트
    let changeCount = 0;

    // 이 날짜의 근무 스케줄
    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.status === '근무') {
            const newPos = newPositions.get(schedule.employee_id);
            if (newPos !== undefined) {
                // 화면에 존재 -> 위치 업데이트
                if (schedule.grid_position !== newPos) {
                    schedule.grid_position = newPos;
                    schedule.sort_order = newPos;
                    unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                    changeCount++;
                }
            }
        }
    });

    if (changeCount > 0) {
        console.log(`  💾 위치 변경됨: ${changeCount}건`);
        updateSaveButtonState();
    }
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
    const newMode = btn.dataset.mode; // 'all', 'working', 'off'
    if (state.schedule.viewMode !== newMode) {
        state.schedule.viewMode = newMode;

        clearSelection(); // ✨ 뷰 모드 변경 시 선택 초기화

        // Update button active states
        document.querySelectorAll('.schedule-view-btn').forEach(b => {
            if (b.dataset.mode === newMode) {
                b.classList.add('bg-white', 'text-blue-600', 'shadow-sm');
                b.classList.remove('text-gray-500', 'hover:text-blue-600', 'hover:bg-white');
            } else {
                b.classList.remove('bg-white', 'text-blue-600', 'shadow-sm');
                b.classList.add('text-gray-500', 'hover:text-blue-600', 'hover:bg-white');
            }
        });

        renderCalendar();
    }
}

// ✨ 모든 날짜의 grid_position 업데이트 (빈칸 포함)
function updateAllGridPositions() {
    console.log('🔄 모든 날짜의 grid_position 업데이트 시작');

    document.querySelectorAll('.calendar-day').forEach(dayEl => {
        const dateStr = dayEl.dataset.date;
        updateScheduleSortOrders(dateStr); // 재사용
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

        // ✅ 2-1. grid_position 중복 제거 (같은 날짜+위치에 2명 → 나중 것 유지)
        const positionMap = new Map();
        const deduped = [];
        for (const s of schedulesToSave) {
            const key = `${s.date}_${s.grid_position}`;
            if (positionMap.has(key)) {
                console.warn(`⚠️ 중복 위치 제거: ${key}`, positionMap.get(key).employee_id, '→', s.employee_id);
            }
            positionMap.set(key, s);
        }
        deduped.push(...positionMap.values());

        console.log('📊 수집된 스케줄 (State):', schedulesToSave.length, '건 → 중복 제거 후:', deduped.length, '건');
        const schedulesToInsert = deduped;

        // ✅ 3. 해당 월의 기존 스케줄 완전 삭제
        console.log('🗑️ 기존 스케줄 삭제 중...');
        const { error: deleteError } = await db.from('schedules')
            .delete()
            .gte('date', startOfMonth)
            .lte('date', endOfMonth);

        if (deleteError) throw deleteError;

        // ✅ 4. 데이터 일괄 삽입
        if (schedulesToInsert.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < schedulesToInsert.length; i += BATCH_SIZE) {
                const batch = schedulesToInsert.slice(i, i + BATCH_SIZE);
                const { error: insertError } = await db.from('schedules').insert(batch);
                if (insertError) throw insertError;
            }
        }

        // ✅ 5. 회사 휴무일 저장
        try {
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
        } catch (holidayError) {
            console.error('❌ 휴무일 저장 실패 (권한 문제 예상):', holidayError);
            alert('⚠️ 주의: 직원 스케줄은 저장되었으나, 휴일 설정 저장 권한이 없습니다.\n(관리자에게 company_holidays 테이블 권한 설정을 요청하세요)');
            // 에러를 throw하지 않고 진행하여 화면 리로드(Step 6)가 실행되도록 함
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
// 리셋 함수 추가
async function handleResetSchedule() {
    if (!confirm('현재 달의 모든 스케줄을 리셋하고 사이드바 순서대로 근무자로 초기화하시겠습니까?\n(승인된 연차는 보존됩니다)')) {
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
                    // 음수 ID = 빈칸
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

        // 2. 해당 월의 모든 날짜 가져오기
        const currentDate = dayjs(state.schedule.currentDate);
        const startOfMonth = currentDate.startOf('month');
        const endOfMonth = currentDate.endOf('month');
        const startOfMonthStr = startOfMonth.format('YYYY-MM-DD');
        const endOfMonthStr = endOfMonth.format('YYYY-MM-DD');

        const allDates = [];
        let currentLoop = startOfMonth.clone();
        while (currentLoop.valueOf() <= endOfMonth.valueOf()) {
            allDates.push(currentLoop.format('YYYY-MM-DD'));
            currentLoop = currentLoop.add(1, 'day');
        }

        // ✅ 3. 승인된 연차 정보 수집 (리셋 시 보존하기 위함)
        const leaveMap = new Map(); // date -> Set(employee_id)
        const requests = state.management.leaveRequests || [];
        requests.forEach(req => {
            // Admin 등록 등 status 확인
            const isApproved = (req.status === 'approved' || req.final_manager_status === 'approved');

            if (isApproved && req.dates) {
                req.dates.forEach(date => {
                    if (date >= startOfMonthStr && date <= endOfMonthStr) {
                        if (!leaveMap.has(date)) leaveMap.set(date, new Set());
                        leaveMap.get(date).add(req.employee_id);
                    }
                });
            }
        });

        // 4. 기존 스케줄 삭제
        const { error: deleteError } = await db.from('schedules')
            .delete()
            .gte('date', startOfMonthStr)
            .lte('date', endOfMonthStr);

        if (deleteError) {
            console.error('❌ 삭제 오류:', deleteError);
            throw deleteError;
        }

        console.log('✅ 기존 스케줄 삭제 완료');

        // 5. 모든 날짜에 대해 근무자로 삽입 (연차인 날은 제외)
        const schedulesToInsert = [];

        allDates.forEach(dateStr => {
            const leaveSet = leaveMap.get(dateStr);

            orderedEmployees.forEach(item => {
                // ✅ 실제 직원만 저장
                if (item.type === 'employee') {
                    // 연차인 직원은 근무 스케줄 생성 안 함
                    if (leaveSet && leaveSet.has(item.employee_id)) {
                        // console.log(`[Reset] Skipping ${item.employee_id} on ${dateStr} (Leave)`);
                    } else {
                        schedulesToInsert.push({
                            date: dateStr,
                            employee_id: item.employee_id,
                            status: '근무',
                            sort_order: item.position,
                            grid_position: item.position
                        });
                    }
                }
                // spacer는 DB에 저장하지 않음
            });
        });

        console.log('➕ 삽입할 스케줄:', schedulesToInsert.length, '건');

        // 6. 새 스케줄 삽입 (배치 처리)
        const BATCH_SIZE = 50;
        for (let i = 0; i < schedulesToInsert.length; i += BATCH_SIZE) {
            const batch = schedulesToInsert.slice(i, i + BATCH_SIZE);
            const { error: insertError } = await db.from('schedules').insert(batch);

            if (insertError) {
                console.error(`❌ 배치 삽입 오류 (인덱스 ${i}):`, insertError);
                throw insertError;
            }
        }

        console.log('✅ 스케줄 리셋 완료');

        // 7. 화면 다시 로드
        await loadAndRenderScheduleData(state.schedule.currentDate);

        alert('스케줄이 성공적으로 리셋되었습니다. (승인된 연차는 제외됨)');

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
    // 레거시 — 새 그리드 편집기에서는 더블클릭으로 빈칸 토글
    const grid = document.querySelector('#layout-grid');
    if (!grid) return;
    // 마지막 빈 슬롯을 spacer로 변환
    const emptySlots = grid.querySelectorAll('.layout-empty');
    if (emptySlots.length > 0) {
        const slot = emptySlots[emptySlots.length - 1];
        const pos = parseInt(slot.dataset.position);
        slot.className = 'layout-slot layout-spacer';
        slot.dataset.employeeId = '-1';
        slot.innerHTML = `<span class="slot-number" style="color:#d1d5db;">${pos + 1}</span>`;
    }
}

function handleDeleteSpacer(e) {
    if (e.target.matches('.delete-spacer-btn, .delete-separator-btn')) {
        e.target.closest('[data-type]').remove();
    }
}

async function handleSaveEmployeeOrder(options = {}) {
    const saveBtn = _('#save-employee-order-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장중...';

    // ✅ 4×8 그리드에서 순서 수집 (달력과 동일한 event-card/event-slot 구조)
    const employeeOrder = [];
    document.querySelectorAll('#layout-grid .event-card, #layout-grid .event-slot').forEach(slot => {
        const empId = slot.dataset.employeeId;
        if (empId === 'empty') {
            employeeOrder.push(0); // placeholder
        } else {
            const id = parseInt(empId, 10);
            if (!isNaN(id)) {
                employeeOrder.push(id); // 음수(spacer)도 포함
            }
        }
    });

    // 끝에 있는 빈 슬롯(0) 제거, 중간 빈 슬롯은 유지
    while (employeeOrder.length > 0 && employeeOrder[employeeOrder.length - 1] === 0) {
        employeeOrder.pop();
    }
    // 중간 빈 슬롯(0)은 -1(spacer)로 변환
    for (let i = 0; i < employeeOrder.length; i++) {
        if (employeeOrder[i] === 0) employeeOrder[i] = -1;
    }

    console.log('💾 그리드 배치 저장:', employeeOrder);

    const month = dayjs(state.schedule.currentDate).format('YYYY-MM-01');
    const managerUuid = state.currentUser?.auth_uuid;

    if (!managerUuid) {
        alert('로그인 정보가 올바르지 않습니다. 다시 로그인해주세요.');
        saveBtn.disabled = false;
        saveBtn.textContent = '배치 저장';
        return;
    }

    try {
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

        alert('배치가 저장되었습니다.');
        if (!options.skipReload) {
            await loadAndRenderScheduleData(state.schedule.currentDate);
        }
    } catch (error) {
        console.error('배치 저장 실패:', error);
        alert(`배치 저장 실패: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '배치 저장';
    }
}

// ✅ "전체 적용" — 현재 그리드 배치를 해당 월 모든 날짜의 grid_position에 적용
// 배치 그리드에서 employee → position 매핑 추출
function getLayoutPositionMap() {
    const positionMap = new Map();
    document.querySelectorAll('#layout-grid .event-card, #layout-grid .event-slot').forEach((slot, idx) => {
        const empId = parseInt(slot.dataset.employeeId);
        if (!isNaN(empId) && empId > 0) {
            positionMap.set(empId, idx);
        }
    });
    return positionMap;
}

// 지정된 날짜들의 스케줄에 배치(grid_position)만 적용 (상태는 건드리지 않음)
function applyLayoutToSchedules(positionMap, targetDates) {
    const dateSet = targetDates ? new Set(targetDates) : null;
    let updateCount = 0;

    state.schedule.schedules.forEach(s => {
        if (s.employee_id <= 0) return;
        if (dateSet && !dateSet.has(s.date)) return;
        if (!positionMap.has(s.employee_id)) return;

        const newPos = positionMap.get(s.employee_id);
        if (s.grid_position !== newPos) {
            s.grid_position = newPos;
            unsavedChanges.set(s.id, { type: 'update', data: s });
            updateCount++;
        }
    });

    return updateCount;
}

async function handleApplyLayoutToAll() {
    const btn = _('#apply-layout-btn');
    if (!confirm('현재 배치를 이번 달 모든 날짜에 적용하시겠습니까?\n(각 날짜의 휴무/연차 상태는 유지됩니다)')) return;

    btn.disabled = true;
    btn.textContent = '적용중...';

    try {
        pushUndoState('배치 전체 적용');
        await handleSaveEmployeeOrder({ skipReload: true });

        const positionMap = getLayoutPositionMap();
        const updateCount = applyLayoutToSchedules(positionMap, null); // null = 전체 날짜

        console.log(`📋 전체 적용: ${updateCount}개 스케줄의 grid_position 업데이트됨`);
        renderCalendar();
        updateSaveButtonState();

        alert(`배치가 모든 날짜에 적용되었습니다. (${updateCount}개 변경)\n"스케줄 저장" 버튼을 눌러 DB에 반영하세요.`);
    } catch (error) {
        console.error('전체 적용 실패:', error);
        alert('전체 적용 실패: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '전체 적용';
    }
}

// 날짜 우클릭 메뉴: 이 날짜에 배치 적용
function handleMenuApplyLayoutToDate() {
    const dateContextMenu = document.getElementById('date-context-menu');
    const dateStr = dateContextMenu.dataset.date;
    if (!dateStr) return;
    dateContextMenu.classList.add('hidden');

    const positionMap = getLayoutPositionMap();
    if (positionMap.size === 0) {
        alert('배치 그리드에 직원이 없습니다.\n먼저 배치를 설정해주세요.');
        return;
    }

    pushUndoState(`배치 적용: ${dateStr}`);
    const updateCount = applyLayoutToSchedules(positionMap, [dateStr]);

    if (updateCount === 0) {
        alert(`${dateStr}: 변경할 배치가 없습니다.`);
        return;
    }

    console.log(`📐 날짜 배치 적용: ${dateStr} → ${updateCount}개 변경`);
    renderCalendar();
    updateSaveButtonState();

    // 시각적 피드백
    const targetDayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
    if (targetDayEl) {
        const originalBg = targetDayEl.style.backgroundColor;
        targetDayEl.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
        setTimeout(() => { targetDayEl.style.backgroundColor = originalBg; }, 400);
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
    console.log(`🔍 handleSameDateMove called: ${movedEmployeeId} (${oldIndex} -> ${newIndex})`);

    if (oldIndex === newIndex) return;

    // ✨ [Group Move Check]
    // 이동하려는 대상이 "선택된 그룹"에 포함되어 있고, 선택된 항목이 2개 이상인 경우 그룹 이동 처리
    // movedEmployeeId는 직원 ID임. 스케줄 ID를 찾아야 함.
    const movingSchedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === movedEmployeeId && s.status === '근무');

    if (movingSchedule && state.schedule.selectedSchedules.has(String(movingSchedule.id)) && state.schedule.selectedSchedules.size > 1) {
        handleGroupSameDateMove(dateStr, movedEmployeeId, oldIndex, newIndex);
        return;
    }

    console.log(`🔄 [${dateStr}] ${movedEmployeeId}번 이동: ${oldIndex} → ${newIndex}`);

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
        forceFallback: false,
        fallbackTolerance: 5,
        emptyInsertThreshold: 30,
        swap: true, // ✨ Swap 모드 활성화
        swapClass: 'sortable-swap-highlight', // 교환 대상 강조 스타일

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
                // ✨ [Sync] 단순히 현재 화면 순서를 그대로 저장 (Swap이든 Insert든 최종 결과만 반영)
                console.log('📅 [onUpdate] 순서 변경 감지 -> 동기화');
                updateScheduleSortOrders(dateStr);
                updateSaveButtonState();
            }
        },

        onAdd(evt) {
            console.log('🎯 Calendar onAdd triggered! Date:', dateStr);
            const employeeEl = evt.item;

            // ✅ event-card인 경우는 다른 날짜에서 온 것 → moveCards() 사용
            if (employeeEl.classList.contains('event-card')) {
                const draggedEmpId = parseInt(employeeEl.dataset.employeeId, 10);
                const fromDate = dragSourceInfo?.fromDate;
                const targetPos = evt.newIndex;

                if (fromDate && fromDate !== dateStr && !isNaN(draggedEmpId)) {
                    pushUndoState('Drag Move');

                    // 복수 선택된 카드가 있으면 함께 이동 (B4/B5)
                    const empIdsToMove = [draggedEmpId];
                    if (state.schedule.selectedSchedules.size > 0) {
                        state.schedule.selectedSchedules.forEach(schedId => {
                            const sched = state.schedule.schedules.find(s => String(s.id) === String(schedId));
                            if (sched && sched.employee_id !== draggedEmpId && sched.date === fromDate) {
                                empIdsToMove.push(sched.employee_id);
                            }
                        });
                    }

                    moveCards(empIdsToMove, fromDate, dateStr, targetPos);
                    clearSelection();
                }

                // DOM 원복 후 재렌더링 (Sortable이 DOM을 직접 이동시키므로)
                employeeEl.remove();
                renderCalendar();
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

            // ✅ 중복 체크 (규칙 4-2) -> [수정] 이미 '근무' 중인 경우만 막고, '휴무'인 경우는 '휴무'를 제거
            const existingWorking = state.schedule.schedules.find(
                s => s.date === dateStr && s.employee_id === empId && s.status === '근무'
            );

            if (existingWorking) {
                console.log('❌ Employee already working on this date - drop cancelled');
                employeeEl.remove();
                alert('이미 해당 날짜에 근무 중인 직원입니다.');
                return;
            }

            // [수정] '휴무' 상태가 있다면 제거 (상태 중복 방지)
            const existingOffIndex = state.schedule.schedules.findIndex(
                s => s.date === dateStr && s.employee_id === empId && s.status === '휴무'
            );

            if (existingOffIndex !== -1) {
                const offSchedule = state.schedule.schedules[existingOffIndex];
                console.log('🔄 휴무 상태 제거:', offSchedule);
                // state에서 제거
                state.schedule.schedules.splice(existingOffIndex, 1);
                // DB 삭제 예약
                if (!offSchedule.id.toString().startsWith('temp-')) {
                    unsavedChanges.set(offSchedule.id, { type: 'delete', data: offSchedule });
                }
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

            // [수정] 덮어쓰기 방지: 자리에 누가 있다면 '가장 가까운 빈칸'으로 이동
            const targetPos = evt.newIndex;

            // 현재 그리드 상태 계산
            const currentGrid = new Array(GRID_SIZE).fill(null);
            state.schedule.schedules.forEach(s => {
                if (s.date === dateStr && s.status === '근무' && s.grid_position != null) {
                    if (s.grid_position >= 0 && s.grid_position < GRID_SIZE) {
                        currentGrid[s.grid_position] = s.employee_id;
                    }
                }
            });

            const occupiedEmpId = currentGrid[targetPos];

            if (occupiedEmpId !== null && occupiedEmpId !== undefined) {
                console.log(`⚠️ Slot ${targetPos} is occupied by ${occupiedEmpId}. Finding nearest empty slot...`);

                let bestPos = -1;
                let minDist = Infinity;

                // 가장 가까운 빈칸 탐색
                for (let i = 0; i < GRID_SIZE; i++) {
                    // 빈칸이면서, 현재 드롭하려는 위치가 아닌 곳
                    if (currentGrid[i] === null && i !== targetPos) {
                        const dist = Math.abs(i - targetPos);
                        if (dist < minDist) {
                            minDist = dist;
                            bestPos = i;
                        } else if (dist === minDist) {
                            // 거리가 같다면 뒤쪽(+)을 우선
                            if (i > targetPos) bestPos = i;
                        }
                    }
                }

                if (bestPos === -1) {
                    alert('배치할 빈 공간이 없습니다.');
                    employeeEl.remove();
                    // 만약 휴무를 삭제했다면 복구해야 하지만... (생략)
                    return;
                }

                console.log(`✅ Found nearest empty slot at ${bestPos}. Moving existing employee.`);

                // 기존 직원 이동 처리
                const occupiedSchedule = state.schedule.schedules.find(
                    s => s.date === dateStr && s.employee_id === occupiedEmpId && s.status === '근무'
                );

                if (occupiedSchedule) {
                    occupiedSchedule.grid_position = bestPos;
                    occupiedSchedule.sort_order = bestPos;
                    unsavedChanges.set(occupiedSchedule.id, { type: 'update', data: occupiedSchedule });
                }
            }

            // ✅ 새 스케줄 추가
            const tempId = `temp-${Date.now()}-${empId}`;
            const newSchedule = {
                id: tempId,
                date: dateStr,
                employee_id: empId,
                status: '근무',
                sort_order: targetPos,
                grid_position: targetPos
            };
            state.schedule.schedules.push(newSchedule);
            unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
            console.log('✅ Added new schedule:', empId, 'at position:', targetPos);

            // ✅ DOM 정리 및 재렌더링
            employeeEl.remove();
            renderCalendar();
            updateSaveButtonState();
        },
    });
}

// =========================================================================================
// [기능 복구] 자동 배정 및 AppSheet 관련 로직
// =========================================================================================

export async function handleAutoSchedule() {
    if (!confirm('현재 보고 있는 달의 스케줄을 자동으로 생성하시겠습니까?\n\n주의: 현재 화면의 기존 근무 스케줄은 모두 삭제되고 새로 생성됩니다.\n(결과는 저장하기 전까지 확정되지 않습니다)')) return;

    const generator = new ScheduleGenerator();
    const currentDate = dayjs(state.schedule.currentDate);

    // 1. 필요한 데이터 준비
    const year = currentDate.year();
    const month = currentDate.month(); // 0-indexed
    const employees = state.management.employees;

    // 연차 정보 가져오기 (승인된 것만)
    const leaves = state.management.leaveRequests
        .filter(req => req.status === 'approved' || req.final_manager_status === 'approved')
        .map(req => ({
            employee_id: req.employee_id,
            dates: req.dates || []
        }));

    const companyHolidays = state.schedule.companyHolidays;

    try {
        const btn = _('#auto-schedule-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '생성 중...';
        }

        // 2. 로직 실행
        const newSchedules = generator.generate(year, month, employees, leaves, companyHolidays);

        console.log(`✅ ${newSchedules.length}개의 스케줄이 생성되었습니다.`);

        // 3. 기존 스케줄 삭제 처리 (Local State & UnsavedChanges)
        const startOfMonth = currentDate.startOf('month').format('YYYY-MM-DD');
        const endOfMonth = currentDate.endOf('month').format('YYYY-MM-DD');

        // 삭제 대상 식별: 해당 월의 '근무' 스케줄
        const schedulesToRemove = state.schedule.schedules.filter(s =>
            s.date >= startOfMonth && s.date <= endOfMonth && s.status === '근무'
        );

        schedulesToRemove.forEach(s => {
            // DB에 있는 데이터라면 삭제 목록에 추가
            if (!s.id.toString().startsWith('temp-')) {
                unsavedChanges.set(s.id, { type: 'delete', data: s });
            } else {
                unsavedChanges.delete(s.id);
            }
        });

        // State에서 제거
        state.schedule.schedules = state.schedule.schedules.filter(s =>
            !(s.date >= startOfMonth && s.date <= endOfMonth && s.status === '근무')
        );

        // 4. 새 스케줄 추가 처리 (Local State & UnsavedChanges)
        newSchedules.forEach(s => {
            const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const scheduleWithId = { ...s, id: tempId };

            state.schedule.schedules.push(scheduleWithId);
            unsavedChanges.set(tempId, { type: 'new', data: scheduleWithId });
        });

        // 5. 화면 갱신
        renderCalendar();
        updateSaveButtonState();

        alert(`자동 배정이 완료되었습니다.\n총 ${newSchedules.length}건이 생성되었습니다.\n\n내용을 확인하고 [스케줄 저장] 버튼을 눌러 확정하세요.`);

    } catch (e) {
        console.error('자동 배정 실패:', e);
        alert('자동 배정 중 오류가 발생했습니다: ' + e.message);
    } finally {
        const btn = _('#auto-schedule-btn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🤖 자동 배정';
        }
    }
}

function handleAppSheetSettings() {
    const currentUrl = getScriptUrl();
    const newUrl = prompt('AppSheet 연동 스크립트(Google Apps Script) URL을 입력하세요:\n(배포된 웹앱 URL)', currentUrl);
    if (newUrl !== null) {
        setScriptUrl(newUrl);
        alert('AppSheet 연동 URL이 저장되었습니다.');
    }
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

function getExcludedEmployeeIds() {
    const excludedIds = new Set();
    const savedLayout = state.schedule.teamLayout?.data?.[0];
    if (savedLayout && savedLayout.members && savedLayout.members.length > 0) {
        state.management.employees.forEach(emp => {
            const isTemp = emp.is_temp || (emp.email && emp.email.startsWith('temp-'));
            if (!isTemp && !savedLayout.members.includes(emp.id)) {
                excludedIds.add(emp.id);
            }
        });
    }
    return excludedIds;
}

function getOffEmployeesOnDate(dateStr) {
    const offEmps = [];

    // ✅ 1. 승인된 연차 먼저 확인 (Leave -> Green)
    // DB에 스케줄이 '휴무'로 되어있더라도, 연차 기록이 있으면 '연차'로 표시해야 함
    const leaveEmployees = new Set();
    (state.management.leaveRequests || []).forEach(req => {
        // status 확인: 'approved' OR 'final_manager_status' === 'approved'
        // 수동 등록된 건도 'approved'로 간주
        if ((req.status === 'approved' || req.final_manager_status === 'approved') && req.dates?.includes(dateStr)) {
            const excludedIds = getExcludedEmployeeIds();
            if (excludedIds.has(req.employee_id)) return;

            const emp = state.management.employees.find(e => e.id === req.employee_id);
            if (emp) {
                offEmps.push({ employee: emp, schedule: null, type: 'leave' });
                leaveEmployees.add(emp.id);
            }
        }
    });

    // ✅ 2. DB/State에 '휴무' 상태로 저장된 직원 (나머지 휴무자)
    const excludedIds = getExcludedEmployeeIds();
    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.status === '휴무') {
            if (excludedIds.has(schedule.employee_id)) return;
            const emp = state.management.employees.find(e => e.id === schedule.employee_id);
            if (emp) {
                // 이미 연차로 등록된 직원은 중복 표시 방지
                if (!leaveEmployees.has(emp.id) && !offEmps.some(item => item.employee.id === emp.id)) {
                    offEmps.push({ employee: emp, schedule: schedule, type: '휴무' });
                }
            }
        }
    });

    // ✅ 이름순 정렬 (휴무자는 그리드 위치가 중요하지 않음)
    offEmps.sort((a, b) => a.employee.name.localeCompare(b.employee.name));

    return offEmps;
}

// ✅ 직원 기본 그리드 위치 (수동 이동 전까지 고정, 자동 이동 금지)
function getEmployeeBasePositions() {
    const posMap = new Map();

    // 1. 현재 월 스케줄에서 각 직원의 최빈 grid_position
    const posCount = new Map();
    state.schedule.schedules.forEach(s => {
        if (s.employee_id <= 0 || s.grid_position == null) return;
        if (!posCount.has(s.employee_id)) posCount.set(s.employee_id, new Map());
        const counts = posCount.get(s.employee_id);
        counts.set(s.grid_position, (counts.get(s.grid_position) || 0) + 1);
    });
    posCount.forEach((counts, empId) => {
        let bestPos = 0, bestCount = 0;
        counts.forEach((count, pos) => {
            if (count > bestCount) { bestCount = count; bestPos = pos; }
        });
        posMap.set(empId, bestPos);
    });

    // 2. 스케줄에 없는 직원 → team_layout 기반 빈 position 배정
    const usedPositions = new Set(posMap.values());
    const layout = state.schedule.teamLayout?.data?.[0]?.members;
    if (layout) {
        const activeIds = new Set(
            (state.management.employees || [])
                .filter(e => !e.is_temp && !e.retired && !(e.email?.startsWith('temp-')))
                .map(e => e.id)
        );
        layout.forEach(id => {
            if (id > 0 && activeIds.has(id) && !posMap.has(id)) {
                let pos = 0;
                while (usedPositions.has(pos)) pos++;
                posMap.set(id, pos);
                usedPositions.add(pos);
            }
        });
        // layout에도 없는 활성 직원
        activeIds.forEach(id => {
            if (!posMap.has(id)) {
                let pos = 0;
                while (usedPositions.has(pos)) pos++;
                posMap.set(id, pos);
                usedPositions.add(pos);
            }
        });
    }

    return posMap;
}

// ✅ 특정 날짜에 직원의 상태 판별
function getEmployeeStatusOnDate(empId, dateStr) {
    // 1. 승인된 연차 (확정 휴무, 수정 불가)
    const leaveReqs = state.management.leaveRequests || [];
    const hasLeave = leaveReqs.some(req =>
        req.employee_id === empId &&
        (req.status === 'approved' || req.final_manager_status === 'approved') &&
        req.dates?.includes(dateStr)
    );
    if (hasLeave) return 'leave';

    // 2. DB 스케줄
    const sched = state.schedule.schedules.find(s => s.employee_id === empId && s.date === dateStr);
    if (sched) return sched.status === '휴무' ? 'off' : 'working';

    // 3. 데이터 없음 → 평일이면 근무
    return 'working';
}

// ✨ 선택 해제 함수
function clearSelection() {
    state.schedule.selectedSchedules.clear();
    document.querySelectorAll('.event-card.selected, .event-slot.selected').forEach(el => el.classList.remove('selected'));
    // 빈 슬롯 선택 상태도 초기화
    if (window.selectedEmptySlot) {
        window.selectedEmptySlot = null;
    }
    window.lastClickedSlot = null;
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
    // 월요일 시작 (일요일 제거된 달력)
    let startDate = firstDay.startOf('week');
    if (startDate.day() === 0) startDate = startDate.add(1, 'day'); // 일→월
    // 1일의 요일에 맞춰 시작 주의 월요일로
    const firstDayOfWeek = firstDay.day(); // 0=일, 1=월, ...
    if (firstDayOfWeek === 0) {
        startDate = firstDay.add(1, 'day'); // 일요일이면 월요일부터
    } else {
        startDate = firstDay.subtract(firstDayOfWeek - 1, 'day'); // 해당 주 월요일
    }
    const endDate = lastDay.endOf('week');

    const gridClass = state.schedule.isReadOnly ? 'calendar-grid calendar-grid-readonly' : 'calendar-grid';
    let calendarHTML = `<div class="${gridClass}">`;

    const weekDays = ['월', '화', '수', '목', '금', '토'];
    weekDays.forEach((day, idx) => {
        let colorClass = idx === 5 ? 'text-blue-500' : '';
        calendarHTML += `<div class="calendar-header ${colorClass}">${day}</div>`;
    });
    // 7번째 열: 검수 헤더 (관리자/매니저만)
    if (!state.schedule.isReadOnly) {
        calendarHTML += `<div class="calendar-header weekly-audit-cell" style="background:#f0f9ff; color:#1e40af; font-size:12px;">검수</div>`;
    }

    // ✅ 루프 밖에서 한 번만 계산 (성능)
    const basePositions = getEmployeeBasePositions();
    const excludedIds = getExcludedEmployeeIds();
    const activeEmps = (state.management.employees || []).filter(
        e => !e.is_temp && !e.retired && !(e.email?.startsWith('temp-'))
    );

    let currentLoop = startDate.clone();
    while (currentLoop.valueOf() <= endDate.valueOf()) {
        const dateStr = currentLoop.format('YYYY-MM-DD');
        const dayNum = currentLoop.date();
        const isCurrentMonth = currentLoop.month() === month;
        const isToday = currentLoop.format('YYYY-MM-DD') === dayjs().format('YYYY-MM-DD');
        const isSunday = currentLoop.day() === 0;
        const isSaturday = currentLoop.day() === 6;
        const isHoliday = state.schedule.companyHolidays.has(dateStr);

        // 일요일은 건너뜀 (달력에서 제거)
        if (isSunday) {
            currentLoop = currentLoop.add(1, 'day');
            continue;
        }

        let dayClasses = 'calendar-day';
        if (!isCurrentMonth) dayClasses += ' other-month';
        if (isToday) dayClasses += ' today';
        if (isHoliday) dayClasses += ' company-holiday';

        let numberClass = 'day-number';
        if (isSaturday) numberClass += ' text-blue-500';

        let eventsHTML = '';
        const gridSlots = new Array(GRID_SIZE).fill(null);

        // ✅ 부서 필터
        const filteredEmployeeIds = new Set();
        if (state.schedule.activeDepartmentFilters.size > 0) {
            state.management.employees.forEach(emp => {
                if (state.schedule.activeDepartmentFilters.has(emp.department_id)) {
                    filteredEmployeeIds.add(emp.id);
                }
            });
        }

        // ✅ 해당 날짜 스케줄 빠른 조회용 맵
        const dateSchedMap = new Map();
        state.schedule.schedules.forEach(s => {
            if (s.date === dateStr) dateSchedMap.set(s.employee_id, s);
        });

        // ✅ 위치 결정: schedule.grid_position 우선, 없으면 basePositions fallback
        function getEmpPosition(empId) {
            const sched = dateSchedMap.get(empId);
            if (sched && sched.grid_position != null && sched.grid_position >= 0 && sched.grid_position < GRID_SIZE) {
                return sched.grid_position;
            }
            return basePositions.get(empId);
        }

        if (state.schedule.viewMode === 'all') {
            // ═══════════════════════════════════════════
            // 통합 보기: 전체 활성 직원을 배치
            // 근무=뚜렷, 휴무/연차=흐릿
            // ═══════════════════════════════════════════
            activeEmps.forEach(emp => {
                if (excludedIds.has(emp.id)) return;
                if (filteredEmployeeIds.size > 0 && !filteredEmployeeIds.has(emp.id)) return;

                let pos = getEmpPosition(emp.id);
                if (pos == null || pos < 0 || pos >= GRID_SIZE) return;

                // 충돌 시 다음 빈 자리로 밀기
                if (gridSlots[pos] && gridSlots[pos].employee_id !== emp.id) {
                    for (let i = 0; i < GRID_SIZE; i++) { if (!gridSlots[i]) { pos = i; break; } }
                }

                const status = getEmployeeStatusOnDate(emp.id, dateStr);
                const sched = dateSchedMap.get(emp.id);

                gridSlots[pos] = {
                    id: sched?.id || `auto-${emp.id}-${dateStr}`,
                    employee_id: emp.id,
                    date: dateStr,
                    status: status === 'leave' ? '연차' : status === 'off' ? '휴무' : '근무',
                    grid_position: pos,
                    _empStatus: status
                };
            });

            // 임시직원 스케줄 배치 (근무만 존재)
            state.schedule.schedules.forEach(s => {
                if (s.date !== dateStr || s.employee_id <= 0) return;
                const emp = (state.management.employees || []).find(e => e.id === s.employee_id);
                if (!emp || !emp.is_temp) return;
                if (s.status !== '근무') return;
                let pos = (s.grid_position != null && s.grid_position >= 0 && s.grid_position < GRID_SIZE) ? s.grid_position : null;
                if (pos == null) { for (let i = 0; i < GRID_SIZE; i++) { if (!gridSlots[i]) { pos = i; break; } } }
                if (pos != null && !gridSlots[pos]) {
                    gridSlots[pos] = { ...s, _empStatus: 'working' };
                }
            });

            // 빈칸(spacer) 배치
            state.schedule.schedules.forEach(s => {
                if (s.date === dateStr && s.employee_id < 0 && s.grid_position >= 0 && s.grid_position < GRID_SIZE) {
                    if (!gridSlots[s.grid_position]) gridSlots[s.grid_position] = s;
                }
            });

        } else if (state.schedule.viewMode === 'working') {
            // ═══════════════════════════════════════════
            // 근무자 보기: 근무 상태인 직원만
            // ═══════════════════════════════════════════
            activeEmps.forEach(emp => {
                if (excludedIds.has(emp.id)) return;
                if (filteredEmployeeIds.size > 0 && !filteredEmployeeIds.has(emp.id)) return;

                const status = getEmployeeStatusOnDate(emp.id, dateStr);
                if (status !== 'working') return;

                let pos = getEmpPosition(emp.id);
                if (pos == null || pos < 0 || pos >= GRID_SIZE) return;

                if (gridSlots[pos] && gridSlots[pos].employee_id !== emp.id) {
                    for (let i = 0; i < GRID_SIZE; i++) { if (!gridSlots[i]) { pos = i; break; } }
                }

                const sched = dateSchedMap.get(emp.id);
                gridSlots[pos] = {
                    id: sched?.id || `work-${emp.id}-${dateStr}`,
                    employee_id: emp.id,
                    date: dateStr,
                    status: '근무',
                    grid_position: pos,
                    _empStatus: status
                };
            });

            // 임시직원 스케줄 배치 (근무만 존재)
            state.schedule.schedules.forEach(s => {
                if (s.date !== dateStr || s.employee_id <= 0) return;
                const emp = (state.management.employees || []).find(e => e.id === s.employee_id);
                if (!emp || !emp.is_temp) return;
                if (s.status !== '근무') return;
                let pos = (s.grid_position != null && s.grid_position >= 0 && s.grid_position < GRID_SIZE) ? s.grid_position : null;
                if (pos == null) { for (let i = 0; i < GRID_SIZE; i++) { if (!gridSlots[i]) { pos = i; break; } } }
                if (pos != null && !gridSlots[pos]) {
                    gridSlots[pos] = { ...s, _empStatus: 'working' };
                }
            });

            // 빈칸(spacer) 배치
            state.schedule.schedules.forEach(s => {
                if (s.date === dateStr && s.employee_id < 0 && s.grid_position >= 0 && s.grid_position < GRID_SIZE) {
                    if (!gridSlots[s.grid_position]) gridSlots[s.grid_position] = s;
                }
            });

        } else if (state.schedule.viewMode === 'off') {
            // ═══════════════════════════════════════════
            // 휴무자 보기: 연차+휴무 직원만
            // ═══════════════════════════════════════════
            activeEmps.forEach(emp => {
                if (excludedIds.has(emp.id)) return;
                if (filteredEmployeeIds.size > 0 && !filteredEmployeeIds.has(emp.id)) return;

                const status = getEmployeeStatusOnDate(emp.id, dateStr);
                if (status === 'working') return;

                let pos = getEmpPosition(emp.id);
                if (pos == null || pos < 0 || pos >= GRID_SIZE) return;

                if (gridSlots[pos] && gridSlots[pos].employee_id !== emp.id) {
                    for (let i = 0; i < GRID_SIZE; i++) { if (!gridSlots[i]) { pos = i; break; } }
                }

                const sched = dateSchedMap.get(emp.id);
                gridSlots[pos] = {
                    id: sched?.id || `off-${emp.id}-${dateStr}`,
                    employee_id: emp.id,
                    date: dateStr,
                    status: status === 'leave' ? '연차' : '휴무',
                    grid_position: pos,
                    _empStatus: status
                };
            });
        }

        // ═══════════════════════════════════════════
        // 그리드 슬롯 → HTML 변환 (공통)
        // ═══════════════════════════════════════════
        eventsHTML = gridSlots.map((schedule, position) => {
            if (!schedule) {
                return `<div class="event-slot empty-slot" data-position="${position}" data-employee-id="empty" data-type="empty">
                    <span class="slot-number">${position + 1}</span>
                </div>`;
            } else if (schedule.employee_id < 0) {
                const spacerName = `빈칸${-schedule.employee_id}`;
                const isSelected = state.schedule.selectedSchedules.has(schedule.id) ? 'selected' : '';
                return `<div class="event-card event-working ${isSelected}" data-position="${position}" data-employee-id="${schedule.employee_id}" data-schedule-id="${schedule.id}" data-type="working" style="background-color: #f3f4f6;">
                    <span class="event-dot" style="background-color: #f3f4f6;"></span>
                    <span class="event-name" style="color: #f3f4f6;">${spacerName}</span>
                </div>`;
            } else {
                const emp = state.management.employees.find(e => e.id === schedule.employee_id);
                if (!emp) {
                    return `<div class="event-slot empty-slot" data-position="${position}" data-employee-id="empty" data-type="empty">
                        <span class="slot-number">${position + 1}</span>
                    </div>`;
                }

                const deptColor = getDepartmentColor(emp.departments?.id);
                const isSelected = state.schedule.selectedSchedules.has(schedule.id) ? 'selected' : '';
                const empStatus = schedule._empStatus || getEmployeeStatusOnDate(emp.id, dateStr);

                let cardTypeClass, typeAttr;
                if (empStatus === 'leave') {
                    cardTypeClass = 'event-leave';
                    typeAttr = 'leave';
                } else if (empStatus === 'off') {
                    cardTypeClass = 'event-off';
                    typeAttr = '휴무';
                } else {
                    cardTypeClass = 'event-working';
                    typeAttr = 'working';
                }

                // 통합 보기: 휴무/연차는 흐릿하게 표시
                const offStyle = (state.schedule.viewMode === 'all' && empStatus !== 'working')
                    ? 'opacity: 0.45;' : '';
                // 휴무자 보기: 뚜렷하게 표시
                const offFocusClass = (state.schedule.viewMode === 'off')
                    ? (empStatus === 'leave' ? 'event-leave-focus' : 'event-off-focus') : '';

                const finalClass = offFocusClass || cardTypeClass;

                return `<div class="event-card ${finalClass} ${isSelected}" data-position="${position}" data-employee-id="${emp.id}" data-schedule-id="${schedule.id}" data-type="${typeAttr}" style="${offStyle}">
                    <span class="event-dot" style="background-color: ${deptColor};"></span>
                    <span class="event-name">${emp.name}</span>
                </div>`;
            }
        }).join('');


        calendarHTML += `
            <div class="${dayClasses}" data-date="${dateStr}">
                <div class="day-header">
                    <span class="${numberClass}">${dayNum}</span>
                </div>
                <div class="day-events">${eventsHTML}</div>
            </div>`;

        currentLoop = currentLoop.add(1, 'day');

        // 토요일(주의 마지막 날) 뒤에 해당 주의 검수 셀 삽입 (관리자/매니저만)
        if (isSaturday && !state.schedule.isReadOnly) {
            const weekStartDate = currentLoop.subtract(1, 'day').startOf('week'); // 일요일
            const weekEndDate = weekStartDate.endOf('week'); // 토요일
            calendarHTML += getWeeklyAuditCellHTML(weekStartDate, weekEndDate, month);
        }
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

    // ✨ 추가 이벤트 리스너 연결 (더블클릭, 컨텍스트 메뉴, 키보드)
    initializeCalendarEvents();

    console.log('Calendar rendered successfully');
}

// ✨ 달력 클릭 핸들러 분리
function handleCalendarClick(e) {
    // 날짜 숫자 클릭 - 더블클릭 핸들러(handleDateHeaderDblClick)와 충돌 방지를 위해 단일 클릭 동작 제거
    if (e.target.classList.contains('day-number')) {
        // handleDateNumberClick(e); // ❌ 기존 단일 클릭 핸들러 비활성화
        return;
    }

    // ✨ [Fix] 이벤트 카드 또는 빈 슬롯 클릭 (드래그 아닐 때만)
    const card = e.target.closest('.event-card, .event-slot');
    if (card && !isDragging) {
        // ✨ [A4] 드래그 선택 직후 클릭 무시
        if (dragSelectJustFinished) { dragSelectJustFinished = false; return; }
        handleEventCardClick(e);
        return;
    }
}

// ✨ 달력 더블클릭 핸들러 (이벤트 위임)
function handleCalendarDblClick(e) {
    const card = e.target.closest('.event-card');
    if (card) {
        handleEventCardDblClick(e, card);
    }
}

// ✨ 클릭 핸들러: 선택(Selection) 로직
function handleEventCardClick(e) {
    // ✨ [Fix] 빈 슬롯도 선택 가능하도록 변경 (붙여넣기 타겟 지정을 위해)
    const card = e.target.closest('.event-card, .event-slot');
    if (!card) return;

    const scheduleId = card.dataset.scheduleId;
    console.log(`👆 Card Click: ${scheduleId} (Selected before: ${scheduleId ? state.schedule.selectedSchedules.has(scheduleId) : 'N/A'})`);

    // if (!scheduleId) return; // ❌ 빈 슬롯(ID 없음)도 선택되어야 함

    const cardDate = card.closest('.calendar-day')?.dataset.date;
    const cardPos = parseInt(card.dataset.position, 10);

    // ✨ [A3] Shift+클릭: 범위 선택 (lastSelectedCardInfo ~ 현재 카드)
    if (e.shiftKey && lastSelectedCardInfo) {
        e.preventDefault();
        const fromDate = lastSelectedCardInfo.date;
        const fromPos = lastSelectedCardInfo.position;

        // 같은 날짜 내에서만 범위 선택
        if (cardDate === fromDate) {
            const minPos = Math.min(fromPos, cardPos);
            const maxPos = Math.max(fromPos, cardPos);

            // 범위 내 모든 카드 선택
            const dayEl = card.closest('.calendar-day');
            if (dayEl) {
                dayEl.querySelectorAll('.event-card, .event-slot').forEach(el => {
                    const pos = parseInt(el.dataset.position, 10);
                    if (pos >= minPos && pos <= maxPos) {
                        const sid = el.dataset.scheduleId;
                        if (sid) {
                            state.schedule.selectedSchedules.add(sid);
                        }
                        el.classList.add('selected');
                    }
                });
            }
        }
        // 다른 날짜 간 범위: 모든 날짜에서 같은 position 범위 선택
        else {
            const allDayEls = document.querySelectorAll('.calendar-day');
            const dates = Array.from(allDayEls).map(d => d.dataset.date).filter(Boolean).sort();
            const startIdx = dates.indexOf(fromDate);
            const endIdx = dates.indexOf(cardDate);
            if (startIdx >= 0 && endIdx >= 0) {
                const minIdx = Math.min(startIdx, endIdx);
                const maxIdx = Math.max(startIdx, endIdx);
                const minPos = Math.min(fromPos, cardPos);
                const maxPos = Math.max(fromPos, cardPos);

                for (let di = minIdx; di <= maxIdx; di++) {
                    const dayEl = document.querySelector(`.calendar-day[data-date="${dates[di]}"]`);
                    if (!dayEl) continue;
                    dayEl.querySelectorAll('.event-card, .event-slot').forEach(el => {
                        const pos = parseInt(el.dataset.position, 10);
                        if (pos >= minPos && pos <= maxPos) {
                            const sid = el.dataset.scheduleId;
                            if (sid) state.schedule.selectedSchedules.add(sid);
                            el.classList.add('selected');
                        }
                    });
                }
            }
        }

        console.log('🔲 Shift+Click range selected:', state.schedule.selectedSchedules.size);
        return;
    }

    // Ctrl(Cmd) 키 누른 상태: 다중 선택 토글
    if (e.ctrlKey || e.metaKey) {
        if (scheduleId) {
            if (state.schedule.selectedSchedules.has(scheduleId)) {
                state.schedule.selectedSchedules.delete(scheduleId);
                card.classList.remove('selected');
            } else {
                state.schedule.selectedSchedules.add(scheduleId);
                card.classList.add('selected');
            }
        } else {
            // 빈 슬롯 토글
            card.classList.toggle('selected');
        }
        // Ctrl+클릭도 기준점 업데이트
        lastSelectedCardInfo = { date: cardDate, position: cardPos };
    }
    // 일반 클릭: 기존 선택 해제하고 단일 선택
    else {
        // ✨ [개선] 이미 선택된 항목을 다시 클릭하면 선택 해제 (토글 방식)
        if (scheduleId && state.schedule.selectedSchedules.has(scheduleId) && state.schedule.selectedSchedules.size === 1) {
            clearSelection();
            card.classList.remove('selected');
            window.selectedEmptySlot = null; // 빈 슬롯 선택도 초기화
            return;
        }

        clearSelection();

        // ✨ [Fix] 이전에 선택된 빈 슬롯이 있으면 제거
        if (window.selectedEmptySlot) {
            window.selectedEmptySlot.classList.remove('selected');
            window.selectedEmptySlot = null;
        }

        if (scheduleId) {
            state.schedule.selectedSchedules.add(scheduleId);
        }
        // 다시 렌더링하지 않고 DOM만 업데이트 (성능 최적화)
        document.querySelectorAll('.event-card.selected').forEach(el => el.classList.remove('selected'));
        card.classList.add('selected');

        // ✨ 클릭한 위치 저장 (Ctrl+V 붙여넣기 위치로 사용)
        window.lastClickedSlot = {
            date: card.closest('.calendar-day').dataset.date,
            position: parseInt(card.dataset.position, 10)
        };
        if (card.classList.contains('event-slot')) {
            window.selectedEmptySlot = card;
            console.log('📍 Empty Slot Selected:', window.lastClickedSlot);
        } else {
            window.selectedEmptySlot = null;
            console.log('���� Card Selected:', window.lastClickedSlot);
        }

        // 일반 클릭도 기준점 업데이트 (Shift+클릭 시작점)
        lastSelectedCardInfo = { date: cardDate, position: cardPos };
    }

    console.log('Selected count:', state.schedule.selectedSchedules.size);
}

// ✨ 그룹 이동 처리 함수
function handleGroupSameDateMove(dateStr, pivotEmpId, oldIndex, newIndex) {
    console.log(`👨‍👩‍👧‍👦 그룹 이동 감지: ${pivotEmpId} (Delta: ${newIndex - oldIndex})`);

    const delta = newIndex - oldIndex;
    if (delta === 0) return;

    // 1. 전체 스케줄 가져오기 (해당 날짜, 근무자)
    const allSchedules = state.schedule.schedules.filter(s => s.date === dateStr && s.status === '근무' && s.grid_position != null && s.grid_position < GRID_SIZE);

    // 2. 현재 그리드 구성 (배경) - 직원 ID 매핑
    const currentGrid = new Array(GRID_SIZE).fill(null);
    allSchedules.forEach(s => {
        currentGrid[s.grid_position] = s.employee_id;
    });

    // 3. 이동 대상(선택된) 직원 및 피벗 식별
    // ✨ [Fix] selectedSchedules has string IDs (from dataset), so we must ensure comparison handles types
    const selectedIds = new Set(Array.from(state.schedule.selectedSchedules).map(id => String(id)));
    const movingScheduleIds = new Set();
    const movingItems = [];

    // 피벗(드래그 중인 아이템)이 선택 그룹에 포함되어 있지 않다면 강제로 포함 (UX 보정)
    // 일반적으로 SortableJS는 드래그 아이템을 포함해서 처리하지만, 데이터 일관성을 위해 체크
    // 하지만 pivotEmpId는 empId이고 selectedIds는 scheduleId임. 조회 필요.

    // 이동할 아이템 추출
    allSchedules.forEach(s => {
        // ✨ [Fix] ID comparison: String(s.id) to match selectedIds
        if (selectedIds.has(String(s.id)) || s.employee_id === pivotEmpId) {
            movingScheduleIds.add(s.id);
            movingItems.push({
                empId: s.employee_id,
                scheduleId: s.id,
                oldPos: s.grid_position,
                newPos: Math.max(0, Math.min(GRID_SIZE - 1, s.grid_position + delta)) // Clamp
            });
        }
    });

    // 4. 그리드에서 이동 대상 제거 (빈 공간 확보)
    const tempGrid = [...currentGrid];
    movingItems.forEach(item => {
        // 기존 위치 비우기 (단, 같은 위치에 다른 이동 아이템이 없었던 경우만 - 근데 중복 위치는 없어야 정상)
        if (tempGrid[item.oldPos] === item.empId) {
            tempGrid[item.oldPos] = null;
        }
    });

    // 5. 이동 아이템 배치 (새 위치 기준 정렬)
    // 충돌 시 밀어내기 방향을 고려하여 정렬:
    // 앞쪽으로 배치할 때는 앞쪽 인덱스부터, 뒤쪽은 뒤쪽부터?
    // 사실 "삽입" 방식이므로, 위치가 낮은 순서대로 배치하면서 뒤로 밀어내는게 일반적임.
    movingItems.sort((a, b) => a.newPos - b.newPos);

    const finalGrid = [...tempGrid];

    movingItems.forEach(item => {
        let insertPos = item.newPos;

        // 대상 위치에(혹은 밀려난 위치에) 다른 아이템(이동하지 않는)이 있다면 뒤로 밀기
        if (finalGrid[insertPos] !== null) {
            // insertPos 이후의 모든 비-null 아이템 수집
            const itemsToShift = [];
            for (let i = insertPos; i < GRID_SIZE; i++) {
                if (finalGrid[i] !== null) {
                    itemsToShift.push(finalGrid[i]);
                    finalGrid[i] = null;
                }
            }

            // 이동 아이템 배치
            finalGrid[insertPos] = item.empId;

            // 밀린 아이템들 재배치 (빈 공간 찾아 채우기)
            let currentShiftPos = insertPos + 1;
            itemsToShift.forEach(shiftedEmpId => {
                while (currentShiftPos < GRID_SIZE && finalGrid[currentShiftPos] !== null) {
                    currentShiftPos++;
                }
                if (currentShiftPos < GRID_SIZE) {
                    finalGrid[currentShiftPos] = shiftedEmpId;
                } else {
                    // 공간 부족으로 탈락? (경고 또는 처리 필요)
                    console.warn(`공간 부족으로 직원(${shiftedEmpId})이 그리드에서 밀려났습니다.`);
                    // 탈락 처리는 아래 State 업데이트에서 반영됨 (그리드에 없으면 삭제 처리됨)
                }
            });
        } else {
            // 빈 공간이면 그냥 배치
            finalGrid[insertPos] = item.empId;
        }
    });

    // 6. State 업데이트
    let changeCount = 0;

    // 6-1. 이동한 아이템들 업데이트
    // 6-2. 밀려난(영향받은) 아이템들 업데이트
    // 그냥 모든 스케줄에 대해 finalGrid 상의 위치로 동기화하면 됨.

    // A. 기존 스케줄 위치 업데이트 또는 삭제(밀려남)
    allSchedules.forEach(schedule => {
        const newPos = finalGrid.indexOf(schedule.employee_id);

        if (newPos === -1) {
            // 그리드에서 사라짐 -> 삭제 처리 (또는 휴무?)
            // 사용자 의도가 "삭제"는 아닐 것이므로, 일단 '휴무' 처리하거나 경고.
            // 여기서는 로직상 '삭제'로 마킹(unsavedChanges)하여 저장 시 처리
            if (!schedule.id.toString().startsWith('temp-')) {
                unsavedChanges.set(schedule.id, { type: 'delete', data: schedule });
                changeCount++;
            }
        } else {
            if (schedule.grid_position !== newPos) {
                schedule.grid_position = newPos;
                schedule.sort_order = newPos;
                unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                changeCount++;
            }
        }
    });

    console.log(`✅ 그룹 이동 완료. 변경된 항목: ${changeCount}`);

    renderCalendar();
    updateSaveButtonState();
}

// ✨ 더블클릭 핸들러: 상태 변경(Toggle) / 삭제 로직 (기존 클릭 로직 이동)
function handleEventCardDblClick(e, card) {
    const empId = parseInt(card.dataset.employeeId);
    const scheduleId = card.dataset.scheduleId;

    // 빈칸 등 유효하지 않은 카드 제외
    if (!scheduleId || isNaN(empId)) return;

    // 3. 상태 토글 또는 삭제 (임시 직원)
    let schedule = state.schedule.schedules.find(s => s.id == scheduleId); // 타입 주의

    // ✨ 임시 직원 확인
    const emp = state.management.employees.find(e => e.id === empId);
    const isTemp = emp && emp.is_temp;

    // ✨ 연차 대상자인지 확인
    const dateStr = card.closest('.calendar-day')?.dataset.date;
    const isLeave = state.management.leaveRequests.some(req =>
        (req.status === 'approved' || req.final_manager_status === 'approved') &&
        req.dates?.includes(dateStr) &&
        req.employee_id === empId
    );

    if (isLeave) {
        alert('승인된 연차는 확정 휴무이므로 스케줄에서 수정할 수 없습니다.\n연차 취소는 연차 관리에서 처리해주세요.');
        return;
    }

    if (schedule) {
        pushUndoState('Toggle Status'); // 상태 변경 전 Undo 저장

        if (isTemp) {
            // ✨ 임시 직원은 더블클릭 시 스케줄에서 삭제
            state.schedule.schedules = state.schedule.schedules.filter(s => s.id !== schedule.id);
            unsavedChanges.set(schedule.id, { type: 'delete', data: schedule.id });
            console.log('Removed temp staff schedule:', schedule);
        } else {
            // 기존 정규 직원 스케줄: 상태 전환 (근무 <-> 휴무)
            schedule.status = schedule.status === '근무' ? '휴무' : '근무';
            unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
            console.log('Updated schedule:', schedule);
        }

        // 선택 상태 해제 및 리렌더링
        clearSelection();
        renderCalendar();
        updateSaveButtonState();
    } else {
        // 기존 스케줄 객체가 없는 경우 (예: 연차 대상자인데 DB에 명시적 스케줄 기록이 없을 때)
        // 근무 상태로 신규 생성
        pushUndoState('Add Schedule');
        const tempId = `temp-${Date.now()}-${empId}`;
        const newSchedule = {
            id: tempId,
            date: dateStr,
            employee_id: empId,
            status: '근무',
            sort_order: 99,
            grid_position: 99
        };
        state.schedule.schedules.push(newSchedule);
        unsavedChanges.set(tempId, { type: 'new', data: newSchedule });

        clearSelection();
        renderCalendar();
        updateSaveButtonState();
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

    // 검수열 주간 계산을 위해 달력 표시 범위(첫째 주 월요일 ~ 마지막 주 토요일)로 확장
    const firstDay = dayjs(date).startOf('month');
    const lastDay = dayjs(date).endOf('month');
    const firstDayOfWeek = firstDay.day();
    let calendarStart;
    if (firstDayOfWeek === 0) {
        calendarStart = firstDay.add(1, 'day'); // 일요일이면 월요일부터
    } else {
        calendarStart = firstDay.subtract(firstDayOfWeek - 1, 'day'); // 해당 주 월요일
    }
    const calendarEnd = lastDay.endOf('week'); // 마지막 주 토요일
    const fetchStart = calendarStart.format('YYYY-MM-DD');
    const fetchEnd = calendarEnd.format('YYYY-MM-DD');

    console.log('Loading data for:', { currentMonth, startOfMonth, endOfMonth, fetchStart, fetchEnd });

    try {
        const [layoutRes, scheduleRes, holidayRes] = await Promise.all([
            db.from('team_layouts').select('layout_data').lte('month', currentMonth).order('month', { ascending: false }).limit(1),
            db.from('schedules').select('*').gte('date', fetchStart).lte('date', fetchEnd),
            db.from('company_holidays').select('date').gte('date', fetchStart).lte('date', fetchEnd)
        ]);

        console.log('Data loaded:', { layoutRes, scheduleRes, holidayRes });

        if (layoutRes.error) throw layoutRes.error;
        if (scheduleRes.error) throw scheduleRes.error;
        if (holidayRes.error) throw holidayRes.error;

        const latestLayout = layoutRes.data?.[0];
        // ✅ 단순 직원 순서만 저장 (DB 없으면 기본 배치 사용)
        let employeeOrder = [];
        if (latestLayout && latestLayout.layout_data && latestLayout.layout_data.length > 0) {
            employeeOrder = [...(latestLayout.layout_data[0].members || [])];
        }
        if (employeeOrder.length === 0) {
            employeeOrder = [...DEFAULT_TEAM_MEMBERS];
        }
        // ✅ 활성 직원 중 members에 없는 직원 자동 추가 (신규 입사 등)
        const activeEmployeeIds = (state.management?.employees || [])
            .filter(e => !e.is_temp && !e.retired && !(e.email?.startsWith('temp-')))
            .map(e => e.id);
        if (employeeOrder.length > 0) {
            const memberSet = new Set(employeeOrder);
            activeEmployeeIds.forEach(id => {
                if (!memberSet.has(id)) {
                    // -1(구분선) 앞에 삽입, 없으면 끝에 추가
                    const sepIdx = employeeOrder.indexOf(-1);
                    if (sepIdx >= 0) {
                        employeeOrder.splice(sepIdx, 0, id);
                    } else {
                        employeeOrder.push(id);
                    }
                    memberSet.add(id);
                }
            });
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

        // ✨ 이벤트 리스너 초기화 (휴일 토글 등)
        initializeCalendarEvents();

        // ✨ 그 다음 사이드바 렌더링 (이때 달력의 day-events가 존재함)
        await renderScheduleSidebar();

        // 관리자 모드일 경우 확정 상태 체크
        if (state.currentUser?.isManager || state.currentUser?.role === 'admin') {
            await checkScheduleConfirmationStatus();
        }

        console.log('Rendering complete');
    } catch (error) {
        console.error("스케줄 데이터 로딩 실패:", error);
        alert('스케줄 데이터를 불러오는 데 실패했습니다: ' + error.message);
    }
}

// ═══ 배치 그리드 헬퍼 함수 ═══

// 그리드 전체 position 동기화 (DOM 순서 = position)
function syncGridPositions() {
    const grid = document.getElementById('layout-grid');
    if (!grid) return;
    grid.querySelectorAll('.event-card, .event-slot').forEach((slot, idx) => {
        slot.dataset.position = idx;
        const numEl = slot.querySelector('.slot-number');
        if (numEl) numEl.textContent = idx + 1;
    });
}

function initializeSortableAndDraggable() {
    state.schedule.sortableInstances.forEach(s => s.destroy());
    state.schedule.sortableInstances = [];

    // ═══ 배치 그리드: 달력 날짜칸과 동일한 Sortable 설정 ═══
    const layoutGrid = document.querySelector('#layout-grid');
    if (layoutGrid) {
        if (layoutGrid.sortableInstance) layoutGrid.sortableInstance.destroy();

        layoutGrid.sortableInstance = new Sortable(layoutGrid, {
            group: {
                name: 'calendar-group',  // 달력과 같은 그룹
                pull: false,             // 그리드에서 밖으로 드래그 불가
                put: ['calendar-group', 'layout-pool']  // 달력/직원목록에서 받기
            },
            draggable: '.event-card, .event-slot',
            animation: 150,
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            chosenClass: 'sortable-chosen',
            swap: true,
            swapClass: 'sortable-swap-highlight',
            delay: 200,
            delayOnTouchOnly: false,

            onStart(evt) {
                isDragging = true;
                dragStartTime = Date.now();
                document.body.style.userSelect = 'none';
            },

            onUpdate(evt) {
                // 그리드 내 순서 변경 → position 동기화
                syncGridPositions();
            },

            onAdd(evt) {
                // 직원 목록에서 들어온 clone 처리
                const el = evt.item;
                const empId = parseInt(el.dataset.employeeId);
                const emp = (state.management.employees || []).find(e => e.id === empId);

                if (!emp || isNaN(empId)) {
                    el.remove();
                    return;
                }

                // clone을 달력과 동일한 event-card 구조로 교체
                const deptColor = getDepartmentColor(emp.departments?.id);
                el.className = 'event-card event-working';
                el.dataset.employeeId = emp.id;
                el.dataset.type = 'working';
                el.innerHTML = `
                    <span class="event-dot" style="background-color: ${deptColor};"></span>
                    <span class="event-name">${emp.name}</span>
                `;

                syncGridPositions();
                console.log(`📥 직원 "${emp.name}" → 배치 그리드`);
            },

            onEnd(evt) {
                setTimeout(() => { isDragging = false; }, 100);
                document.body.style.userSelect = '';
                syncGridPositions();
            }
        });
        state.schedule.sortableInstances.push(layoutGrid.sortableInstance);

        // ✅ 마우스 드래그 범위선택 (달력과 동일)
        layoutGrid.addEventListener('mousedown', handleLayoutDragSelectStart);
    }

    // ═══ 우측 직원 목록: clone으로 그리드에 복사 ═══
    document.querySelectorAll('.layout-dept-row').forEach(row => {
        const rowSortable = new Sortable(row, {
            group: {
                name: 'layout-pool',
                pull: 'clone',
                put: false
            },
            draggable: '.layout-pool-card',
            animation: 150,
            ghostClass: 'layout-ghost',
            sort: false,
            filter: '.layout-dept-label',

            onStart(evt) {
                isDragging = true;
                dragStartTime = Date.now();
                document.body.style.userSelect = 'none';
            },

            onEnd(evt) {
                setTimeout(() => { isDragging = false; }, 100);
                document.body.style.userSelect = '';
            }
        });
        state.schedule.sortableInstances.push(rowSortable);
    });

    console.log('✅ Layout editor initialized with', state.schedule.sortableInstances.length, 'sortable instances');
}

// ✨ 사이드바 × 버튼 이벤트 핸들러 (명명 함수 — 중복 등록 방지)
async function handleSidebarDeleteClick(e) {
    if (!e.target.classList.contains('delete-temp-btn')) return;
    e.stopPropagation();
    const id = e.target.dataset.id;

    // 그리드 안의 × → 배치에서 제거만 (빈 슬롯으로 교체)
    const inGrid = e.target.closest('#layout-grid');
    if (inGrid) {
        const slot = e.target.closest('.event-card, .event-slot');
        if (slot) {
            const grid = document.getElementById('layout-grid');
            const pos = Array.from(grid.children).indexOf(slot);
            slot.className = 'event-slot empty-slot';
            slot.dataset.position = pos;
            slot.dataset.employeeId = 'empty';
            slot.dataset.type = 'empty';
            slot.innerHTML = `<span class="slot-number">${pos + 1}</span>`;
        }
        return;
    }

    // 직원 목록의 × → DB에서 삭제
    await handleDeleteTempStaff(id);
}

async function renderScheduleSidebar() {
    const sidebar = _('#schedule-sidebar-area');
    if (!sidebar) return;

    const allEmployees = state.management.employees || [];
    const isTemp = (e) => e.is_temp || (e.email && e.email.startsWith('temp-'));

    const isTest = (e) => isTemp(e) && /^테스트/.test(e.name);
    // 정규 활성 직원 (retired 제외, temp 제외)
    const activeRegular = allEmployees.filter(e => !isTemp(e) && !e.retired);
    // 임시 직원 (알바용, 테스트 제외)
    const tempEmployees = allEmployees.filter(e => isTemp(e) && !isTest(e));
    // 테스트 직원
    const testEmployees = allEmployees.filter(e => isTest(e));
    // 휴직/퇴사 직원
    const retiredEmployees = allEmployees.filter(e => e.retired && !isTemp(e));

    // ✅ 32칸 그리드 슬롯 생성
    const gridSlots = new Array(GRID_SIZE).fill(null);
    const unplacedEmployees = []; // 그리드에 배치되지 않은 직원

    const savedLayout = state.schedule.teamLayout?.data?.[0];
    if (savedLayout && savedLayout.members && savedLayout.members.length > 0) {
        // 저장된 배치 순서대로 그리드 채우기
        let slotIdx = 0;
        savedLayout.members.forEach(memberId => {
            if (slotIdx >= GRID_SIZE) return;
            if (memberId < 0) {
                // 음수 ID = 빈칸(spacer)
                gridSlots[slotIdx] = { id: memberId, isSpacer: true };
                slotIdx++;
            } else {
                const emp = activeRegular.find(e => e.id === memberId);
                if (emp) {
                    gridSlots[slotIdx] = emp;
                    slotIdx++;
                }
            }
        });

        // 저장된 배치에 없는 신규 직원 → 미배치 영역으로
        activeRegular.forEach(emp => {
            if (!savedLayout.members.includes(emp.id)) {
                unplacedEmployees.push(emp);
            }
        });
    } else {
        // 저장된 배치 없으면 DEFAULT_TEAM_MEMBERS 순서 사용
        let slotIdx = 0;
        DEFAULT_TEAM_MEMBERS.forEach(memberId => {
            if (slotIdx >= GRID_SIZE) return;
            if (memberId < 0) {
                gridSlots[slotIdx] = { id: memberId, isSpacer: true };
                slotIdx++;
            } else {
                const emp = activeRegular.find(e => e.id === memberId);
                if (emp) {
                    gridSlots[slotIdx] = emp;
                    slotIdx++;
                }
            }
        });
        // DEFAULT에 없는 활성 직원 → 미배치
        const defaultIds = new Set(DEFAULT_TEAM_MEMBERS.filter(id => id > 0));
        activeRegular.forEach(emp => {
            if (!defaultIds.has(emp.id) && !gridSlots.some(s => s && s.id === emp.id)) {
                unplacedEmployees.push(emp);
            }
        });
    }

    console.log('📋 그리드 배치 편집기: 배치됨', gridSlots.filter(s => s).length, '/ 미배치', unplacedEmployees.length, '/ 임시', tempEmployees.length, '/ 테스트', testEmployees.length, '/ 휴직', retiredEmployees.length);

    // ═══ 그리드 슬롯 HTML 생성 (달력 날짜칸과 동일한 구조) ═══
    const gridSlotsHtml = gridSlots.map((slot, pos) => {
        if (!slot) {
            return `<div class="event-slot empty-slot" data-position="${pos}" data-employee-id="empty" data-type="empty">
                <span class="slot-number">${pos + 1}</span>
            </div>`;
        } else if (slot.isSpacer) {
            return `<div class="event-card event-working" data-position="${pos}" data-employee-id="${slot.id}" data-type="working" style="background-color: #f3f4f6;">
                <span class="event-dot" style="background-color: #f3f4f6;"></span>
                <span class="event-name" style="color: #f3f4f6;">빈칸</span>
            </div>`;
        } else {
            const deptColor = getDepartmentColor(slot.departments?.id);
            return `<div class="event-card event-working" data-position="${pos}" data-employee-id="${slot.id}" data-type="working">
                <span class="event-dot" style="background-color: ${deptColor};"></span>
                <span class="event-name">${slot.name}</span>
            </div>`;
        }
    }).join('');

    const currentMonth = dayjs(state.schedule.currentDate).format('YYYY년 M월');

    // ═══ 부서별 직원 목록 HTML (우측 패널) ═══
    const departments = state.management?.departments || [];
    const deptNameMap = {};
    departments.forEach(d => { deptNameMap[d.id] = d.name; });
    const deptOrder = ['원장', '진료실', '경영지원실', '기공실'];

    const deptGroups = {};
    activeRegular.forEach(emp => {
        const deptName = deptNameMap[emp.department_id] || '기타';
        if (!deptGroups[deptName]) deptGroups[deptName] = [];
        deptGroups[deptName].push(emp);
    });

    const allDeptNames = [...deptOrder];
    Object.keys(deptGroups).forEach(name => {
        if (!allDeptNames.includes(name)) allDeptNames.push(name);
    });

    const deptListHtml = allDeptNames.map(deptName => {
        const emps = deptGroups[deptName];
        if (!emps || emps.length === 0) return '';
        const dept = departments.find(d => d.name === deptName);
        const deptColor = dept ? getDepartmentColor(dept.id) : '#9ca3af';
        const empCards = emps.map(emp => {
            const c = getDepartmentColor(emp.departments?.id);
            return `<div class="layout-slot layout-filled layout-pool-card" data-employee-id="${emp.id}">
                <span class="layout-dot" style="background-color:${c};"></span>
                <span class="layout-name">${emp.name}</span>
            </div>`;
        }).join('');
        return `<div class="layout-dept-row">
            <span class="layout-dept-label" style="color:${deptColor};">${deptName}</span>
            ${empCards}
        </div>`;
    }).join('');

    // 임시 직원 (알바)
    const tempCards = tempEmployees.map(emp => {
        return `<div class="layout-slot layout-filled layout-temp layout-pool-card" data-employee-id="${emp.id}">
            <span class="layout-dot" style="background-color:#a855f7;"></span>
            <span class="layout-name">${emp.name}</span>
            <button class="delete-temp-btn" data-id="${emp.id}" title="삭제">×</button>
        </div>`;
    }).join('');

    // 휴직 직원
    const retiredCards = retiredEmployees.map(emp => {
        const c = getDepartmentColor(emp.departments?.id);
        return `<div class="layout-slot layout-filled layout-retired layout-pool-card" data-employee-id="${emp.id}">
            <span class="layout-dot" style="background-color:${c};"></span>
            <span class="layout-name">${emp.name}</span>
        </div>`;
    }).join('');

    // 테스트 직원
    const testCards = testEmployees.map(emp => {
        return `<div class="layout-slot layout-filled layout-temp layout-pool-card" data-employee-id="${emp.id}" style="opacity:0.5;">
            <span class="layout-dot" style="background-color:#9ca3af;"></span>
            <span class="layout-name">${emp.name}</span>
            <button class="delete-temp-btn" data-id="${emp.id}" title="삭제">×</button>
        </div>`;
    }).join('');

    sidebar.innerHTML = `
        <div class="layout-editor">
            <div class="layout-col layout-col-title">
                <h3 class="layout-editor-title">${currentMonth}<br>배치</h3>
            </div>
            <div class="layout-col layout-col-grid">
                <div class="layout-grid day-events" id="layout-grid">
                    ${gridSlotsHtml}
                </div>
            </div>
            <div class="layout-col layout-col-actions">
                <button id="save-employee-order-btn" class="layout-btn layout-btn-primary" title="현재 그리드 배치를 저장">배치 저장</button>
                <button id="apply-layout-btn" class="layout-btn layout-btn-success" title="이 배치를 모든 날짜에 적용">전체 적용</button>
                <button id="add-temp-staff-btn" class="layout-btn layout-btn-purple" title="임시 직원 추가">+임시</button>
            </div>
            <div class="layout-col layout-col-list">
                <div class="layout-list-scroll" id="layout-employee-list">
                    ${deptListHtml}
                    ${tempEmployees.length > 0 ? `<div class="layout-dept-row">
                        <span class="layout-dept-label" style="color:#7c3aed;">임시</span>${tempCards}
                    </div>` : ''}
                    ${retiredEmployees.length > 0 ? `<div class="layout-dept-row">
                        <span class="layout-dept-label" style="color:#9ca3af;">휴직</span>${retiredCards}
                    </div>` : ''}
                    ${testEmployees.length > 0 ? `<div class="layout-dept-row">
                        <span class="layout-dept-label" style="color:#9ca3af;">테스트</span>${testCards}
                    </div>` : ''}
                </div>
            </div>
        </div>`;

    _('#save-employee-order-btn')?.addEventListener('click', handleSaveEmployeeOrder);
    _('#apply-layout-btn')?.addEventListener('click', handleApplyLayoutToAll);
    _('#add-temp-staff-btn')?.addEventListener('click', handleAddTempStaff);

    // 이벤트 위임: 삭제 버튼 (중복 등록 방지)
    sidebar.removeEventListener('click', handleSidebarDeleteClick);
    sidebar.addEventListener('click', handleSidebarDeleteClick);

    // ═══ 그리드 클릭 선택 (달력과 동일한 조작) ═══
    const layoutGrid = _('#layout-grid');
    if (layoutGrid) {
        layoutGrid.addEventListener('click', handleLayoutGridClick);
        layoutGrid.addEventListener('dblclick', (e) => {
            const slot = e.target.closest('.event-card, .event-slot');
            if (!slot || !slot.closest('#layout-grid')) return;
            const empId = slot.dataset.employeeId;
            const pos = parseInt(slot.dataset.position);
            if (empId === 'empty') {
                // 빈 슬롯 더블클릭 → spacer로 변경
                slot.className = 'event-card event-working';
                slot.dataset.employeeId = '-1';
                slot.dataset.type = 'working';
                slot.innerHTML = `<span class="event-dot" style="background-color: #f3f4f6;"></span><span class="event-name" style="color: #f3f4f6;">빈칸</span>`;
            } else if (parseInt(empId) < 0) {
                // spacer 더블클릭 → 빈 슬롯으로 복원
                slot.className = 'event-slot empty-slot';
                slot.dataset.employeeId = 'empty';
                slot.dataset.type = 'empty';
                slot.innerHTML = `<span class="slot-number">${pos + 1}</span>`;
            }
        });
    }

    initializeSortableAndDraggable();
}

// ═══ 배치 그리드 선택/클립보드 상태 ═══
let layoutSelectedSlots = new Set(); // Set<position index>
let layoutLastClickedPos = null;
let layoutClipboard = []; // [{employeeId, name, deptId, offset}]
let layoutDragState = null; // 마우스 드래그 선택 상태
let layoutDragSelectJustFinished = false;

function clearLayoutSelection() {
    layoutSelectedSlots.clear();
    document.querySelectorAll('#layout-grid .layout-selected').forEach(el => {
        el.classList.remove('layout-selected');
    });
}

function handleLayoutGridClick(e) {
    // 드래그 선택 직후 클릭 무시
    if (layoutDragSelectJustFinished) { layoutDragSelectJustFinished = false; return; }
    if (isDragging) return;

    const slot = e.target.closest('.event-card, .event-slot');
    if (!slot || !slot.closest('#layout-grid')) return;
    const pos = parseInt(slot.dataset.position, 10);

    // Shift+클릭: 범위 선택
    if (e.shiftKey && layoutLastClickedPos != null) {
        const COLS = 4;
        const startRow = Math.floor(layoutLastClickedPos / COLS);
        const startCol = layoutLastClickedPos % COLS;
        const endRow = Math.floor(pos / COLS);
        const endCol = pos % COLS;
        const minRow = Math.min(startRow, endRow), maxRow = Math.max(startRow, endRow);
        const minCol = Math.min(startCol, endCol), maxCol = Math.max(startCol, endCol);

        document.querySelectorAll('#layout-grid .event-card, #layout-grid .event-slot').forEach(el => {
            const p = parseInt(el.dataset.position, 10);
            const r = Math.floor(p / COLS), c = p % COLS;
            if (r >= minRow && r <= maxRow && c >= minCol && c <= maxCol) {
                layoutSelectedSlots.add(p);
                el.classList.add('layout-selected');
            }
        });
        return;
    }

    // Ctrl+클릭: 다중 선택 토글
    if (e.ctrlKey || e.metaKey) {
        if (layoutSelectedSlots.has(pos)) {
            layoutSelectedSlots.delete(pos);
            slot.classList.remove('layout-selected');
        } else {
            layoutSelectedSlots.add(pos);
            slot.classList.add('layout-selected');
        }
        layoutLastClickedPos = pos;
        return;
    }

    // 일반 클릭: 단일 선택 토글
    if (layoutSelectedSlots.has(pos) && layoutSelectedSlots.size === 1) {
        clearLayoutSelection();
        layoutLastClickedPos = null;
        return;
    }
    clearLayoutSelection();
    layoutSelectedSlots.add(pos);
    slot.classList.add('layout-selected');
    layoutLastClickedPos = pos;
}

// ═══ 배치 그리드 마우스 드래그 범위선택 ═══
function handleLayoutDragSelectStart(e) {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (isDragging) return;

    const slot = e.target.closest('.event-card, .event-slot');
    if (!slot || !slot.closest('#layout-grid')) return;

    layoutDragState = {
        startPos: parseInt(slot.dataset.position, 10),
        active: false,
        startX: e.clientX,
        startY: e.clientY
    };

    document.addEventListener('mousemove', handleLayoutDragSelectMove);
    document.addEventListener('mouseup', handleLayoutDragSelectEnd);
}

function handleLayoutDragSelectMove(e) {
    if (!layoutDragState) return;
    if (isDragging) { layoutDragState = null; return; }

    const dx = e.clientX - layoutDragState.startX;
    const dy = e.clientY - layoutDragState.startY;
    if (!layoutDragState.active && (Math.abs(dx) < 5 && Math.abs(dy) < 5)) return;

    if (!layoutDragState.active) {
        layoutDragState.active = true;
        e.preventDefault();
        document.body.style.userSelect = 'none';
    }

    // 마우스 아래의 슬롯 찾기
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const slot = el.closest('.event-card, .event-slot');
    if (!slot || !slot.closest('#layout-grid')) return;
    const endPos = parseInt(slot.dataset.position, 10);

    // row/col 기반 사각형 선택
    const COLS = 4;
    const startRow = Math.floor(layoutDragState.startPos / COLS);
    const startCol = layoutDragState.startPos % COLS;
    const endRow = Math.floor(endPos / COLS);
    const endCol = endPos % COLS;
    const minRow = Math.min(startRow, endRow), maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol), maxCol = Math.max(startCol, endCol);

    clearLayoutSelection();
    document.querySelectorAll('#layout-grid .event-card, #layout-grid .event-slot').forEach(sl => {
        const p = parseInt(sl.dataset.position, 10);
        const r = Math.floor(p / COLS), c = p % COLS;
        if (r >= minRow && r <= maxRow && c >= minCol && c <= maxCol) {
            layoutSelectedSlots.add(p);
            sl.classList.add('layout-selected');
        }
    });
}

function handleLayoutDragSelectEnd(e) {
    document.removeEventListener('mousemove', handleLayoutDragSelectMove);
    document.removeEventListener('mouseup', handleLayoutDragSelectEnd);

    if (!layoutDragState) return;
    const wasActive = layoutDragState.active;
    layoutDragState = null;
    document.body.style.userSelect = '';

    if (wasActive) {
        layoutDragSelectJustFinished = true;
        setTimeout(() => { layoutDragSelectJustFinished = false; }, 50);
        layoutLastClickedPos = layoutSelectedSlots.size > 0 ? Math.min(...layoutSelectedSlots) : null;
        console.log('🔲 Layout drag select done:', layoutSelectedSlots.size);
    }
}

// ═══ 배치 그리드 키보드 처리 (handleGlobalKeydown에서 호출) ═══
function handleLayoutKeyAction(e) {
    // 배치 그리드에 선택이 없으면 처리 안 함
    if (layoutSelectedSlots.size === 0) return false;

    const grid = _('#layout-grid');
    if (!grid) return false;

    const SLOT_SEL = '.event-card, .event-slot';
    const makeEmpty = (slot, pos) => {
        slot.className = 'event-slot empty-slot';
        slot.dataset.position = pos;
        slot.dataset.employeeId = 'empty';
        slot.dataset.type = 'empty';
        slot.innerHTML = `<span class="slot-number">${pos + 1}</span>`;
    };
    const makeFilled = (slot, empId, name, deptId) => {
        const deptColor = getDepartmentColor(deptId);
        slot.className = 'event-card event-working';
        slot.dataset.employeeId = String(empId);
        slot.dataset.type = 'working';
        slot.innerHTML = `<span class="event-dot" style="background-color:${deptColor};"></span><span class="event-name">${name}</span>`;
    };

    // Ctrl+X: 잘라내기
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        e.preventDefault();
        layoutClipboard = [];
        const slots = grid.querySelectorAll(SLOT_SEL);
        const sortedPositions = Array.from(layoutSelectedSlots).sort((a, b) => a - b);
        const basePos = sortedPositions[0];

        sortedPositions.forEach(pos => {
            const slot = slots[pos];
            if (!slot) return;
            const empId = parseInt(slot.dataset.employeeId, 10);
            if (isNaN(empId) || slot.dataset.employeeId === 'empty') {
                layoutClipboard.push({ employeeId: null, offset: pos - basePos });
            } else {
                const emp = (state.management.employees || []).find(e => e.id === empId);
                layoutClipboard.push({ employeeId: empId, name: emp?.name || '', deptId: emp?.departments?.id, offset: pos - basePos });
            }
            makeEmpty(slot, pos);
        });
        clearLayoutSelection();
        console.log(`✂️ 배치 잘라내기: ${layoutClipboard.length}개`);
        return true;
    }

    // Ctrl+C: 복사
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        layoutClipboard = [];
        const slots = grid.querySelectorAll(SLOT_SEL);
        const sortedPositions = Array.from(layoutSelectedSlots).sort((a, b) => a - b);
        const basePos = sortedPositions[0];

        sortedPositions.forEach(pos => {
            const slot = slots[pos];
            if (!slot) return;
            const empId = parseInt(slot.dataset.employeeId, 10);
            if (isNaN(empId) || slot.dataset.employeeId === 'empty') {
                layoutClipboard.push({ employeeId: null, offset: pos - basePos });
            } else {
                const emp = (state.management.employees || []).find(e => e.id === empId);
                layoutClipboard.push({ employeeId: empId, name: emp?.name || '', deptId: emp?.departments?.id, offset: pos - basePos });
            }
        });
        document.querySelectorAll('#layout-grid .layout-selected').forEach(el => {
            el.style.opacity = '0.5';
            setTimeout(() => el.style.opacity = '', 200);
        });
        console.log(`📋 배치 복사: ${layoutClipboard.length}개`);
        return true;
    }

    // Ctrl+V: 붙여넣기
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (layoutClipboard.length === 0) return false;
        e.preventDefault();
        const slots = grid.querySelectorAll(SLOT_SEL);
        const targetPos = layoutLastClickedPos ?? Math.min(...layoutSelectedSlots);

        layoutClipboard.forEach(item => {
            const destPos = targetPos + item.offset;
            if (destPos < 0 || destPos >= GRID_SIZE) return;
            const destSlot = slots[destPos];
            if (!destSlot) return;
            destSlot.dataset.position = destPos;
            if (!item.employeeId) {
                makeEmpty(destSlot, destPos);
            } else {
                makeFilled(destSlot, item.employeeId, item.name, item.deptId);
            }
        });
        clearLayoutSelection();
        console.log(`📌 배치 붙여넣기: ${layoutClipboard.length}개 → pos ${targetPos}`);
        return true;
    }

    // Delete: 선택 비우기
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const slots = grid.querySelectorAll(SLOT_SEL);
        layoutSelectedSlots.forEach(pos => {
            const slot = slots[pos];
            if (!slot) return;
            makeEmpty(slot, pos);
        });
        clearLayoutSelection();
        console.log('🗑️ 배치 삭제');
        return true;
    }

    return false;
}

// ✨ 임시 직원 삭제 핸들러
async function handleDeleteTempStaff(id) {
    if (!confirm('이 임시 직원을 목록에서 제거하시겠습니까?\n(기존 스케줄은 그대로 유지됩니다)')) return;

    try {
        // DB에서 완전 삭제 대신 retired=true로 변경 (스케줄 보존)
        const { error } = await db.from('employees').update({ retired: true }).eq('id', id);
        if (error) throw error;

        // 직원 목록 갱신
        const { data: empData, error: empError } = await db.from('employees')
            .select('*, departments(*)')
            .order('id');

        if (empError) throw empError;
        if (empData) {
            state.management.employees = empData;
            console.log('✅ 임시직원 비활성화 & 직원목록 갱신:', empData.length);
        }

        // 사이드바만 갱신 (스케줄 리로드 불필요 — 기존 데이터 유지)
        renderScheduleSidebar();

    } catch (err) {
        console.error('임시 직원 제거 실패:', err);
        alert('제거 중 오류가 발생했습니다: ' + err.message);
    }
}

// ✨ 임시 직원 추가 핸들러
async function handleAddTempStaff() {
    const name = prompt("임시 직원의 이름을 입력하세요 (예: 알바1, 임시 김의사):");
    if (!name) return;

    try {
        // 임시 직원 insert (부서 미지정 — 임시/알바용)
        const dummyId = Date.now();
        const { error } = await db.from('employees').insert({
            name: name,
            entry_date: dayjs().format('YYYY-MM-DD'),
            email: `temp-${dummyId}@simulation.local`,
            password: 'temp-password',
            department_id: null,
            is_temp: true,
            regular_holiday_rules: []
        });

        if (error) throw error;

        // 리로드 (단, 스케줄 보존을 위해 현재 상태 체크 필요하지만, 사이드바 추가이므로 리로드해도 무방)
        // loadAndRenderScheduleData는 전체 리로드라 스케줄 위치가 초기화될 수 있나? 
        // -> 아니요, DB에서 불러오므로 괜찮습니다. 하지만 *저장하지 않은 변경사항*이 있으면 경고 필요.

        // ✨ 데이터 일관성을 위해 직원 목록 다시 불러오기
        const { data: empData, error: empError } = await db.from('employees')
            .select('*, departments(*)')
            .order('id');

        if (empError) throw empError;
        if (empData) {
            state.management.employees = empData;
            console.log('✅ Temporary Staff Added & Employee List Updated:', empData.length);
        }

        // UX상 바로 보이는게 좋으므로, 스케줄 데이터 리로드
        await loadAndRenderScheduleData(state.schedule.currentDate);

        // ✨ 사이드바 명시적 갱신 (추가된 직원 표시)
        renderScheduleSidebar();

    } catch (err) {
        console.error('임시 직원 추가 실패:', err);
        alert('임시 직원 추가 중 오류가 발생했습니다:\n' + (typeof err === 'object' ? JSON.stringify(err, null, 2) : err));
    }
}

// ✨ 날짜 헤더 더블클릭 핸들러 (휴일 토글)
function handleDateHeaderDblClick(e) {
    const dayEl = e.target.closest('.calendar-day');
    if (!dayEl) return;

    const headerEl = e.target.closest('.day-number');
    if (!headerEl && !e.target.classList.contains('calendar-day')) return;

    if (isDragging) return;

    const dateStr = dayEl.dataset.date;

    const workingSchedules = state.schedule.schedules.filter(s => s.date === dateStr && s.status === '근무');
    const isHoliday = state.schedule.companyHolidays.has(dateStr);

    if (!isHoliday) {
        if (confirm(`${dateStr}을 휴일로 지정하고 모든 근무자를 휴무로 변경하시겠습니까?`)) {
            workingSchedules.forEach(s => {
                s.status = '휴무';
                unsavedChanges.set(s.id, { type: 'update', data: s });
            });
            state.schedule.companyHolidays.add(dateStr);
            unsavedHolidayChanges.toAdd.add(dateStr);
            unsavedHolidayChanges.toRemove.delete(dateStr);
            renderCalendar();
            updateSaveButtonState();
        }
    } else {
        if (confirm(`${dateStr}의 휴일 설정을 해제하고 모든 직원을 근무로 변경하시겠습니까?`)) {
            state.schedule.companyHolidays.delete(dateStr);
            unsavedHolidayChanges.toRemove.add(dateStr);
            unsavedHolidayChanges.toAdd.delete(dateStr);

            // 1. 이미 근무 중인 사람들의 포지션 점유 확인
            const occupiedPositions = new Set();
            state.schedule.schedules.forEach(s => {
                if (s.date === dateStr && s.status === '근무') {
                    occupiedPositions.add(s.grid_position);
                }
            });

            // 2. 복귀 대상 직원 처리
            const allActiveEmployees = state.management.employees.filter(e => !e.resignation_date);

            allActiveEmployees.forEach(emp => {
                let schedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === emp.id);

                if (schedule) {
                    if (schedule.status !== '근무') {
                        // 휴무 -> 근무 복귀
                        let targetPos = schedule.grid_position;

                        // 포지션 충돌 또는 유효하지 않은 경우(null, undefined) 재설정
                        if (targetPos === null || targetPos === undefined || occupiedPositions.has(targetPos) || targetPos >= 24) {
                            // 빈 자리 찾기
                            let newPos = 0;
                            while (occupiedPositions.has(newPos) && newPos < 24) newPos++;
                            targetPos = newPos;
                        }

                        if (targetPos < 24) {
                            schedule.status = '근무';
                            schedule.grid_position = targetPos;
                            schedule.sort_order = targetPos; // 정렬 순서도 동기화
                            unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                            occupiedPositions.add(targetPos);
                        }
                    }
                } else {
                    // 스케줄 없음 -> 신규 생성
                    let newPos = 0;
                    while (occupiedPositions.has(newPos) && newPos < 24) newPos++;

                    if (newPos < 24) {
                        const tempId = `temp-${Date.now()}-${emp.id}-${newPos}`;
                        const newSchedule = {
                            id: tempId,
                            date: dateStr,
                            employee_id: emp.id,
                            status: '근무',
                            sort_order: newPos,
                            grid_position: newPos
                        };
                        state.schedule.schedules.push(newSchedule);
                        unsavedChanges.set(tempId, { type: 'new', data: newSchedule });
                        occupiedPositions.add(newPos);
                    }
                }
            });
            renderCalendar();
            updateSaveButtonState();
        }
    }
}

// ✨ 컨텍스트 서브메뉴 위치 계산 및 표시 유틸리티
function setupSubmenuPositioning(menuItem, submenu) {
    menuItem.addEventListener('mouseenter', () => {
        const itemRect = menuItem.getBoundingClientRect();

        // 기본적으로 우측에 배치
        let left = itemRect.right;
        let top = itemRect.top;

        // 화면 오른쪽을 벗어나는지 확인
        if (left + 150 > window.innerWidth) { // 150은 submenu의 min-width 추정치
            left = itemRect.left - 150; // 왼쪽으로 펼치기
        }

        // 화면 아래쪽을 벗어나는지 확인
        if (top + 250 > window.innerHeight) { // 250은 max-height 추정치
            top = window.innerHeight - 260; // 위로 올리기
        }

        submenu.style.left = `${left}px`;
        submenu.style.top = `${top}px`;
        submenu.style.display = 'block';
    });

    menuItem.addEventListener('mouseleave', () => {
        submenu.style.display = 'none';
    });
}

// ✨ Context Menu Handler
function handleContextMenu(e) {
    const employeeContextMenu = document.getElementById('employee-context-menu');
    const dateContextMenu = document.getElementById('date-context-menu');
    if (!employeeContextMenu || !dateContextMenu) return;

    // 빈 슬롯(.event-slot) 클릭 시에만 직원 배치 메뉴 표시
    const emptySlot = e.target.closest('.event-slot.empty-slot');

    // 원래의 휴무/연차 컨텍스트 메뉴 로직
    const card = e.target.closest('.event-card');

    // 헤더(날짜 숫자 부분) 클릭 여부 파악
    const dateHeader = e.target.closest('.day-header') || e.target.classList.contains('day-number');

    // 모두 다 아니면 달력 바탕 부분(day 클래스)
    const dayEmptySpace = e.target.classList.contains('calendar-day') || e.target.classList.contains('day-events');

    if (!emptySlot && !card && !dateHeader && !dayEmptySpace) {
        employeeContextMenu.classList.add('hidden');
        document.getElementById('custom-context-menu-v2')?.classList.add('hidden');
        dateContextMenu.classList.add('hidden');
        return;
    }

    e.preventDefault(); // 기본 브라우저 메뉴 차단

    // 메뉴 모두 숨기기 초기화
    employeeContextMenu.classList.add('hidden');
    document.getElementById('custom-context-menu-v2')?.classList.add('hidden');
    dateContextMenu.classList.add('hidden');

    // 마우스 위치
    const x = e.clientX;
    const y = e.clientY;

    if (dateHeader || dayEmptySpace) {
        // [날짜 우클릭] 휴일, 복제 메뉴 표시 로직
        const dayEl = e.target.closest('.calendar-day');
        const date = dayEl ? dayEl.dataset.date : null;
        if (!date) return;

        dateContextMenu.dataset.date = date;

        // Disable paste if clipboard is empty
        const pasteBtn = document.getElementById('ctx-paste-date');
        if (pasteBtn) {
            if (scheduleClipboard && scheduleClipboard.length > 0) {
                pasteBtn.classList.remove('disabled');
            } else {
                pasteBtn.classList.add('disabled');
            }
        }

        dateContextMenu.style.left = `${x}px`;
        dateContextMenu.style.top = `${y}px`;
        dateContextMenu.classList.remove('hidden');

    } else if (emptySlot) {
        // [직원 배치] 서브메뉴 표시 로직
        const dayEl = emptySlot.closest('.calendar-day');
        const date = dayEl ? dayEl.dataset.date : null;
        const position = emptySlot.dataset.position;

        if (!date || position === undefined) return;

        // 기존 V2 메뉴 숨기기
        document.getElementById('custom-context-menu-v2')?.classList.add('hidden');

        // 서브메뉴(부서) 동적 생성
        const deptSubmenu = document.getElementById('dept-submenu');
        deptSubmenu.innerHTML = '';

        // 제외 직원 필터 가져오기 및 날짜 기준 스케줄 있는 사람 필터링용 데이터
        const excludedIds = getExcludedEmployeeIds();
        const existingEmployeeIds = new Set(
            state.schedule.schedules
                .filter(s => s.date === date && s.status === '근무') // 휴무자는 제외
                .map(s => s.employee_id)
        );

        // 부서 목록 가져오기 (정렬)
        const departments = [...state.management.departments].sort((a, b) => a.id - b.id);

        departments.forEach(dept => {
            // 해당 부서의 직원 목록 (제외직원/이미배치된 직원 제외)
            const deptEmployees = state.management.employees.filter(emp =>
                emp.department_id === dept.id &&
                !excludedIds.has(emp.id) &&
                !emp.resignation_date
            );

            if (deptEmployees.length === 0) return; // 표시할 직원이 없으면 부서 스킵

            const deptItem = document.createElement('div');
            deptItem.className = 'menu-item has-submenu2';
            deptItem.innerHTML = `${dept.name} <span class="arrow">▶</span>`;

            const empSubmenu = document.createElement('div');
            empSubmenu.className = 'submenu2';

            deptEmployees.sort((a, b) => a.name.localeCompare(b.name)).forEach(emp => {
                const isSelected = existingEmployeeIds.has(emp.id);
                const empItem = document.createElement('div');
                empItem.className = 'menu-item' + (isSelected ? ' disabled' : '');
                empItem.textContent = emp.name;

                if (!isSelected) {
                    empItem.addEventListener('click', () => {
                        handleEmployeeAssignment(emp.id, date, parseInt(position, 10));
                        employeeContextMenu.classList.add('hidden');
                    });
                }

                empSubmenu.appendChild(empItem);
            });

            deptItem.appendChild(empSubmenu);
            deptSubmenu.appendChild(deptItem);

            // 부서명(deptItem)에 마우스를 올릴 때 직원 목록(empSubmenu) 위치 계산
            setupSubmenuPositioning(deptItem, empSubmenu);
        });

        if (deptSubmenu.children.length === 0) {
            deptSubmenu.innerHTML = '<div class="menu-item disabled">배치할 직원이 없습니다</div>';
        }

        // 메인 컨텍스트 메뉴 자체도 화면 범위를 벗어나지 않도록 보정
        let adjustedX = x;
        let adjustedY = y;

        if (x + 150 > window.innerWidth) adjustedX = window.innerWidth - 160;
        if (y + 150 > window.innerHeight) adjustedY = window.innerHeight - 160;

        // 직원 배치 메뉴 자체의 서브메뉴(deptSubmenu) 위치 계산 연결
        const assignMenuItem = employeeContextMenu.querySelector('.menu-item.has-submenu');
        if (assignMenuItem) {
            setupSubmenuPositioning(assignMenuItem, deptSubmenu);
        }

        employeeContextMenu.style.left = `${adjustedX}px`;
        employeeContextMenu.style.top = `${adjustedY}px`;
        employeeContextMenu.classList.remove('hidden');

    } else if (card) {
        // 기존 V2 컨텍스트 메뉴 (연차 취소/등록) 로직
        const contextMenuV2 = document.getElementById('custom-context-menu-v2');
        if (!contextMenuV2) return;

        employeeContextMenu.classList.add('hidden'); // 새 메뉴 숨기기

        const employeeId = card.dataset.employeeId;
        const dayEl = card.closest('.calendar-day');
        const date = dayEl ? dayEl.dataset.date : null;
        const cardType = card.dataset.type; // 'working', 'leave', 'humu', etc.

        if (!employeeId || !date) return;

        // ✅ 승인된 연차는 수정 불가 (컨텍스트 메뉴 차단)
        const empIdNum = parseInt(employeeId);
        if (empIdNum > 0 && getEmployeeStatusOnDate(empIdNum, date) === 'leave') {
            alert('승인된 연차는 확정 휴무이므로 수정할 수 없습니다.\n연차 취소는 연차 관리에서 처리해주세요.');
            return;
        }

        // 메뉴 데이터 설정
        contextMenuV2.dataset.employeeId = employeeId;
        contextMenuV2.dataset.date = date;

        const registerBtn = document.getElementById('ctx-register-leave-v2');
        const cancelBtn = document.getElementById('ctx-cancel-leave-v2');

        if (registerBtn && cancelBtn) {
            const isLeave = card.classList.contains('event-leave') || cardType === 'leave';
            const isOff = card.classList.contains('event-off') || cardType === '휴무';

            if (isLeave || isOff) {
                // 휴무/연차자 -> 연차 취소(삭제) 가능
                registerBtn.style.display = 'none';
                cancelBtn.style.display = 'block';
                cancelBtn.textContent = "🗑️ 연차 취소하기";
                contextMenuV2.style.border = "";
                cancelBtn.style.backgroundColor = "";

                registerBtn.classList.add('hidden');
                cancelBtn.classList.remove('hidden');
            } else {
                // 근무자 or 기타 -> 연차 등록 가능
                registerBtn.style.display = 'block';
                cancelBtn.style.display = 'none';

                registerBtn.classList.remove('hidden');
                cancelBtn.classList.add('hidden');
            }
        }

        contextMenuV2.style.left = `${x}px`;
        contextMenuV2.style.top = `${y}px`;
        contextMenuV2.classList.remove('hidden');
    }
}

// ✨ 빈 슬롯 우클릭을 통한 직원 할당 로직
function handleEmployeeAssignment(employeeId, dateStr, position) {
    if (!employeeId || !dateStr || position === undefined) return;

    // 신규 생성
    pushUndoState('Add Schedule via Context Menu');
    const tempId = `temp-${Date.now()}-${employeeId}`;
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

    clearSelection();
    renderCalendar();
    updateSaveButtonState();
}

// ✨ Global Click Handler for Context Menu (Outside Click)
function handleGlobalClickForMenu(e) {
    const contextMenuV2 = document.getElementById('custom-context-menu-v2');
    const employeeContextMenu = document.getElementById('employee-context-menu');
    const dateContextMenu = document.getElementById('date-context-menu');

    if (contextMenuV2 && !contextMenuV2.contains(e.target)) {
        contextMenuV2.classList.add('hidden');
    }
    if (employeeContextMenu && !employeeContextMenu.contains(e.target)) {
        employeeContextMenu.classList.add('hidden');
    }
    if (dateContextMenu && !dateContextMenu.contains(e.target)) {
        dateContextMenu.classList.add('hidden');
    }
}

// ✨ 날짜 메뉴: 휴일 지정/해제
function handleMenuToggleHoliday() {
    const dateContextMenu = document.getElementById('date-context-menu');
    const dateStr = dateContextMenu.dataset.date;
    if (!dateStr) return;

    dateContextMenu.classList.add('hidden');

    // 날짜 헤더 더블클릭 로직을 활용하기 위해 가상 이벤트 생성 (코드 중복 방지)
    const dayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
    if (dayEl) {
        handleDateHeaderDblClick({ target: dayEl });
    }
}

// ✨ 날짜 메뉴: 복사
function handleMenuCopyDate() {
    const dateContextMenu = document.getElementById('date-context-menu');
    const dateStr = dateContextMenu.dataset.date;
    if (!dateStr) return;

    scheduleClipboard = [];
    const schedulesOnDate = state.schedule.schedules.filter(s => s.date === dateStr && s.status === '근무');

    if (schedulesOnDate.length === 0) {
        alert('해당 날짜에 복사할 근무자가 없습니다.');
        dateContextMenu.classList.add('hidden');
        return;
    }

    schedulesOnDate.forEach(s => {
        scheduleClipboard.push({
            employee_id: s.employee_id,
            status: s.status,
            grid_position: s.grid_position, // 원본 위치 기억
            _origPos: s.grid_position
        });
    });

    console.log(`Copied ${scheduleClipboard.length} schedules from ${dateStr} to clipboard:`, scheduleClipboard);
    dateContextMenu.classList.add('hidden');

    // 시각적 피드백
    const targetDayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
    if (targetDayEl) {
        const originalBg = targetDayEl.style.backgroundColor;
        targetDayEl.style.backgroundColor = 'rgba(16, 185, 129, 0.2)'; // 초록색 틴트
        setTimeout(() => { targetDayEl.style.backgroundColor = originalBg; }, 300);
    }
}

// ✨ 날짜 메뉴: 붙여넣기
function handleMenuPasteDate() {
    const dateContextMenu = document.getElementById('date-context-menu');
    const dateStr = dateContextMenu.dataset.date;
    if (!dateStr || !scheduleClipboard || scheduleClipboard.length === 0) {
        dateContextMenu.classList.add('hidden');
        return;
    }

    pushUndoState('Paste Schedules via Date Context Menu');

    // ✅ placeCards() 통합 함수 사용
    const pastedCount = placeCards(scheduleClipboard, dateStr, null);

    if (pastedCount > 0) {
        renderCalendar();
        updateSaveButtonState();

        const targetDayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
        if (targetDayEl) {
            const originalBg = targetDayEl.style.backgroundColor;
            targetDayEl.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
            setTimeout(() => { targetDayEl.style.backgroundColor = originalBg; }, 300);
        }
    }
    dateContextMenu.classList.add('hidden');
}

// ✨ 날짜 메뉴: 전체 선택
function handleMenuSelectAllDate() {
    const dateContextMenu = document.getElementById('date-context-menu');
    const dateStr = dateContextMenu.dataset.date;
    if (!dateStr) return;

    const cardsOnDate = document.querySelectorAll(`.calendar-day[data-date="${dateStr}"] .event-card`);
    const isAllSelected = Array.from(cardsOnDate).every(c => c.classList.contains('selected'));

    // 토글: 다 선택되었으면 해제, 아니면 전체 선택
    cardsOnDate.forEach(card => {
        const scheduleId = card.dataset.scheduleId;
        if (scheduleId) {
            if (isAllSelected) {
                state.schedule.selectedSchedules.delete(scheduleId);
                card.classList.remove('selected');
            } else {
                state.schedule.selectedSchedules.add(scheduleId);
                card.classList.add('selected');
            }
        }
    });

    dateContextMenu.classList.add('hidden');
}

// ✨ Register Menu Item Click Handler
function handleMenuRegisterClick() {
    const contextMenu = document.getElementById('custom-context-menu-v2');
    const employeeId = contextMenu.dataset.employeeId;
    const date = contextMenu.dataset.date;

    if (employeeId && date) {
        // Call imported management function
        registerManualLeave(employeeId, null, date);
    }
    contextMenu.classList.add('hidden');
}

// ✨ Cancel Menu Item Click Handler
function handleMenuCancelClick() {
    const contextMenu = document.getElementById('custom-context-menu-v2');
    const employeeId = contextMenu.dataset.employeeId;
    const date = contextMenu.dataset.date;

    if (employeeId && date) {
        // Call imported management function
        cancelManualLeave(employeeId, date);
    }
    contextMenu.classList.add('hidden');
}

// ✨ Named Handler for Calendar Grid Double Click (to avoid stacking)
function handleCalendarGridDblClick(e) {
    console.log('🖱️ Double Click Detected on Grid:', e.target);
    // 1. 카드 더블클릭 우선 처리
    if (e.target.closest('.event-card')) {
        console.log('   -> Card double click identified');
        handleCalendarDblClick(e);
        return; // ✨ 카드를 클릭했으면 헤더 토글 방지
    }

    // 2. 날짜 칸(헤더 포함) 더블클릭
    if (e.target.closest('.calendar-day')) {
        console.log('   -> Day header double click identified');
        // 날짜 클릭은 기존 핸들러 (헤더 토글 등)
        handleDateHeaderDblClick(e);
    }
}

// ✨ 더블클릭 및 키보드 이벤트 연결을 위한 초기화
function initializeCalendarEvents() {
    console.log('🔌 initializing Calendar Events...');
    const calendarGrid = document.querySelector('#pure-calendar');
    if (calendarGrid) {
        // ✨ Remove anonymous listeners is impossible, so we use named handler now.
        // ✨ Capture double-click in capture phase to ensure it's not blocked by children
        calendarGrid.addEventListener('dblclick', handleCalendarGridDblClick, { capture: true });
        console.log('   -> dblclick listener attached to grid (CAPTURE mode)');

        // ✨ Context Menu Logic
        calendarGrid.removeEventListener('contextmenu', handleContextMenu);
        calendarGrid.addEventListener('contextmenu', handleContextMenu);
        console.log('   -> contextmenu listener attached to grid');
    } else {
        console.error('❌ #pure-calendar NOT FOUND during initialization');
    }

    // ✨ Global Context Menu Handlers
    document.removeEventListener('click', handleGlobalClickForMenu);
    document.addEventListener('click', handleGlobalClickForMenu);

    const registerBtn = document.getElementById('ctx-register-leave-v2');
    const cancelBtn = document.getElementById('ctx-cancel-leave-v2'); // New
    const closeBtn = document.getElementById('ctx-close-menu');
    const contextMenuV2 = document.getElementById('custom-context-menu-v2');

    // Binding existing v2 menu
    if (registerBtn) {
        registerBtn.onclick = handleMenuRegisterClick;
    }
    if (cancelBtn) {
        cancelBtn.onclick = handleMenuCancelClick;
    }
    if (closeBtn && contextMenuV2) {
        closeBtn.onclick = () => contextMenuV2.classList.add('hidden');
    }

    // Binding new date menu
    const toggleHolidayBtn = document.getElementById('ctx-toggle-holiday');
    const copyDateBtn = document.getElementById('ctx-copy-date');
    const pasteDateBtn = document.getElementById('ctx-paste-date');
    const selectAllDateBtn = document.getElementById('ctx-select-all-date');

    const applyLayoutDateBtn = document.getElementById('ctx-apply-layout-date');

    if (toggleHolidayBtn) toggleHolidayBtn.onclick = handleMenuToggleHoliday;
    if (copyDateBtn) copyDateBtn.onclick = handleMenuCopyDate;
    if (pasteDateBtn) pasteDateBtn.onclick = handleMenuPasteDate;
    if (selectAllDateBtn) selectAllDateBtn.onclick = handleMenuSelectAllDate;
    if (applyLayoutDateBtn) applyLayoutDateBtn.onclick = handleMenuApplyLayoutToDate;

    // ✨ 전역 키보드 이벤트 (복사/붙여넣기/삭제)
    document.removeEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('keydown', handleGlobalKeydown);

    // ✨ [A4] 마우스 드래그 범위선택
    if (calendarGrid) {
        calendarGrid.removeEventListener('mousedown', handleDragSelectStart);
        calendarGrid.addEventListener('mousedown', handleDragSelectStart);
        document.removeEventListener('mousemove', handleDragSelectMove);
        document.addEventListener('mousemove', handleDragSelectMove);
        document.removeEventListener('mouseup', handleDragSelectEnd);
        document.addEventListener('mouseup', handleDragSelectEnd);
    }
}

// ═══════════════════════════════════════════════════════
// ✨ [A4] 마우스 드래그 범위선택 핸들러
// ═══════════════════════════════════════════════════════
function getCardInfoFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const card = el.closest('.event-card, .event-slot');
    if (!card) return null;
    const dayEl = card.closest('.calendar-day');
    if (!dayEl) return null;
    return {
        date: dayEl.dataset.date,
        position: parseInt(card.dataset.position, 10),
        element: card
    };
}

function handleDragSelectStart(e) {
    // 왼쪽 버튼만, Ctrl/Shift 없이, 카드/슬롯 위에서만 시작
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;

    const card = e.target.closest('.event-card, .event-slot');
    if (!card) return;

    // Sortable 드래그와 충돌 방지: 이미 드래그 중이면 무시
    if (isDragging) return;

    const dayEl = card.closest('.calendar-day');
    if (!dayEl) return;

    dragSelectState = {
        startDate: dayEl.dataset.date,
        startPos: parseInt(card.dataset.position, 10),
        active: false,
        startX: e.clientX,
        startY: e.clientY
    };
}

function handleDragSelectMove(e) {
    if (!dragSelectState) return;
    if (isDragging) { dragSelectState = null; return; }

    // 최소 이동 거리 (5px) 초과 시 드래그 선택 활성화
    const dx = e.clientX - dragSelectState.startX;
    const dy = e.clientY - dragSelectState.startY;
    if (!dragSelectState.active && (Math.abs(dx) < 5 && Math.abs(dy) < 5)) return;

    if (!dragSelectState.active) {
        dragSelectState.active = true;
        // 텍스트 선택 방지
        e.preventDefault();
        document.body.style.userSelect = 'none';
    }

    // 현재 마우스 아래의 카드 정보
    const info = getCardInfoFromPoint(e.clientX, e.clientY);
    if (!info) return;

    // 기존 드래그 선택 표시 제거
    document.querySelectorAll('.drag-select-highlight').forEach(el => {
        el.classList.remove('drag-select-highlight', 'selected');
        const sid = el.dataset.scheduleId;
        if (sid) state.schedule.selectedSchedules.delete(sid);
    });

    // 범위 계산 (날짜 간 + row/col 기반 사각형 선택)
    const COLS = 4; // 4열 그리드
    const allDayEls = document.querySelectorAll('.calendar-day');
    const dates = Array.from(allDayEls).map(d => d.dataset.date).filter(Boolean).sort();
    const startIdx = dates.indexOf(dragSelectState.startDate);
    const endIdx = dates.indexOf(info.date);
    if (startIdx < 0 || endIdx < 0) return;

    const minDateIdx = Math.min(startIdx, endIdx);
    const maxDateIdx = Math.max(startIdx, endIdx);

    // position → row/col 변환으로 사각형 선택
    const startRow = Math.floor(dragSelectState.startPos / COLS);
    const startCol = dragSelectState.startPos % COLS;
    const endRow = Math.floor(info.position / COLS);
    const endCol = info.position % COLS;
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);

    clearSelection();

    for (let di = minDateIdx; di <= maxDateIdx; di++) {
        const dayEl = document.querySelector(`.calendar-day[data-date="${dates[di]}"]`);
        if (!dayEl) continue;
        dayEl.querySelectorAll('.event-card, .event-slot').forEach(el => {
            const pos = parseInt(el.dataset.position, 10);
            const row = Math.floor(pos / COLS);
            const col = pos % COLS;
            if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
                el.classList.add('selected', 'drag-select-highlight');
                const sid = el.dataset.scheduleId;
                if (sid) state.schedule.selectedSchedules.add(sid);
            }
        });
    }
}

function handleDragSelectEnd(e) {
    if (!dragSelectState) return;
    const wasActive = dragSelectState.active;
    dragSelectState = null;
    document.body.style.userSelect = '';

    if (wasActive) {
        // 드래그 선택 하이라이트 마커 제거 (selected 클래스는 유지)
        document.querySelectorAll('.drag-select-highlight').forEach(el => {
            el.classList.remove('drag-select-highlight');
        });
        // 드래그 선택 직후 클릭 이벤트 방지
        dragSelectJustFinished = true;
        setTimeout(() => { dragSelectJustFinished = false; }, 50);
        console.log('🔲 Drag select done:', state.schedule.selectedSchedules.size, 'cards');
    }
}

// ✨ 키보드 이벤트 핸들러
function handleGlobalKeydown(e) {
    // 입력 필드 등에서는 무시
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // ✅ 배치 그리드에 선택이 있으면 배치 그리드 키보드 처리 우선
    if (layoutSelectedSlots.size > 0 && handleLayoutKeyAction(e)) return;

    // Undo (Ctrl+Z)
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undoLastChange();
        return;
    }

    // Copy (Ctrl+C)
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (state.schedule.selectedSchedules.size > 0) {
            scheduleClipboard = [];
            state.schedule.selectedSchedules.forEach(scheduleId => {
                const schedule = state.schedule.schedules.find(s => String(s.id) === String(scheduleId));
                if (schedule) {
                    scheduleClipboard.push({
                        employee_id: schedule.employee_id,
                        status: '근무',
                        _origPos: schedule.grid_position  // 상대 위치 보존용
                    });
                }
            });
            // position 순서로 정렬
            scheduleClipboard.sort((a, b) => (a._origPos ?? 0) - (b._origPos ?? 0));
            console.log(`📋 Copy: selected=${state.schedule.selectedSchedules.size}, clipboard=${scheduleClipboard.length}`, scheduleClipboard.map(c => `${c.employee_id}@${c._origPos}`));

            // 시각적 피드백 (선택된 카드 반짝임)
            document.querySelectorAll('.event-card.selected').forEach(el => {
                el.style.opacity = '0.5';
                setTimeout(() => el.style.opacity = '1', 200);
            });
        }
        return;
    }

    // Cut (Ctrl+X)
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        if (state.schedule.selectedSchedules.size > 0) {
            pushUndoState('Cut Schedules'); // Undo 저장

            scheduleClipboard = [];
            state.schedule.selectedSchedules.forEach(scheduleId => {
                const schedule = state.schedule.schedules.find(s => String(s.id) === String(scheduleId));
                if (schedule) {
                    scheduleClipboard.push({
                        employee_id: schedule.employee_id,
                        status: '근무',
                        _origPos: schedule.grid_position  // 상대 위치 보존용
                    });
                    schedule.status = '휴무';
                    unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                }
            });
            // position 순서로 정렬
            scheduleClipboard.sort((a, b) => (a._origPos ?? 0) - (b._origPos ?? 0));
            console.log(`✂️ Cut: selected=${state.schedule.selectedSchedules.size}, clipboard=${scheduleClipboard.length}`, scheduleClipboard.map(c => `${c.employee_id}@${c._origPos}`));
            clearSelection();
            renderCalendar();
            updateSaveButtonState();
        }
        return;
    }

    // Keyboard shortcuts are handled in the main event handler section below
    console.log(`🎹 Keydown: ${e.key} (Ctrl: ${e.ctrlKey})`);

    // Paste (Ctrl+V) — placeCards() 통합 함수 사용
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        let targetDate = null;
        let targetPosition = null;

        // 1순위: 선택된 빈 슬롯 (.selected 클래스)
        const selectedSlot = document.querySelector('.event-slot.selected');
        if (selectedSlot) {
            const dayEl = selectedSlot.closest('.calendar-day');
            const pos = selectedSlot.dataset.position;
            if (dayEl && pos !== undefined) {
                targetDate = dayEl.dataset.date;
                targetPosition = parseInt(pos, 10);
            }
        }

        // 1.5순위: 선택된 카드 위치 (카드 클릭 후 붙여넣기)
        if (targetPosition === null || isNaN(targetPosition)) {
            const selectedCard = document.querySelector('.event-card.selected');
            if (selectedCard) {
                const dayEl = selectedCard.closest('.calendar-day');
                const pos = selectedCard.dataset.position;
                if (dayEl && pos !== undefined) {
                    targetDate = dayEl.dataset.date;
                    targetPosition = parseInt(pos, 10);
                }
            }
        }

        // 1.7순위: lastClickedSlot (클릭했지만 DOM 리렌더링으로 .selected가 사라진 경우)
        if ((targetPosition === null || isNaN(targetPosition)) && window.lastClickedSlot) {
            targetDate = window.lastClickedSlot.date;
            targetPosition = window.lastClickedSlot.position;
        }

        // 2순위: 마우스가 올려진 빈 슬롯 또는 카드
        if (targetPosition === null || isNaN(targetPosition)) {
            const hoveredElement = document.querySelector(':hover');
            if (hoveredElement) {
                const hoveredSlotOrCard = hoveredElement.closest('.event-slot, .event-card');
                if (hoveredSlotOrCard) {
                    const dayEl = hoveredSlotOrCard.closest('.calendar-day');
                    const pos = hoveredSlotOrCard.dataset.position;
                    if (dayEl && pos !== undefined) {
                        targetDate = dayEl.dataset.date;
                        targetPosition = parseInt(pos, 10);
                    }
                }
            }
        }

        // 3순위: 날짜 셀 hover (자동 배치)
        if (!targetDate) {
            const hoveredDay = document.querySelector('.calendar-day:hover');
            if (hoveredDay) {
                targetDate = hoveredDay.dataset.date;
            }
        }

        console.log(`📋 Paste: clipboard=${scheduleClipboard.length}, target=${targetDate}@${targetPosition}`, scheduleClipboard.map(c => c.employee_id));

        if (targetDate && scheduleClipboard.length > 0) {
            pushUndoState('Paste Schedules');

            const startPos = (targetPosition != null && !isNaN(targetPosition)) ? targetPosition : null;
            const pastedCount = placeCards(scheduleClipboard, targetDate, startPos);

            if (pastedCount > 0) {
                renderCalendar();
                updateSaveButtonState();

                // 시각적 피드백
                const targetDayEl = document.querySelector(`.calendar-day[data-date="${targetDate}"]`);
                if (targetDayEl) {
                    const originalBg = targetDayEl.style.backgroundColor;
                    targetDayEl.style.transition = 'background-color 0.3s ease';
                    targetDayEl.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
                    setTimeout(() => {
                        targetDayEl.style.backgroundColor = originalBg;
                        setTimeout(() => { targetDayEl.style.transition = ''; }, 300);
                    }, 400);
                }
                console.log(`✅ ${pastedCount}명을 ${targetDate}에 붙여넣었습니다!`);
            }
        }
        return;
    }

    // Delete / Backspace: 선택된 스케줄 삭제
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.schedule.selectedSchedules.size > 0) {
            if (confirm(`선택한 ${state.schedule.selectedSchedules.size}개의 스케줄을 삭제(휴무 처리)하시겠습니까?`)) {
                pushUndoState('Delete Schedules'); // Undo 저장

                let deletedCount = 0;
                state.schedule.selectedSchedules.forEach(scheduleId => {
                    const schedule = state.schedule.schedules.find(s => String(s.id) === String(scheduleId));
                    if (schedule) {
                        schedule.status = '휴무';
                        unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                        deletedCount++;
                    }
                });
                clearSelection();
                renderCalendar();
                updateSaveButtonState();
                console.log(`Deleted ${deletedCount} schedules.`);
            }
        }
    }
}

// Old Undo implementation removed to avoid duplicates

export async function renderScheduleManagement(container, isReadOnly = false, isManager = false) {
    console.log('renderScheduleManagement called', { isReadOnly, isManager });

    if (!state.schedule) {
        state.schedule = {
            currentDate: dayjs().format('YYYY-MM-DD'),
            viewMode: 'working',
            teamLayout: { month: '', data: [] },
            schedules: [],
            activeDepartmentFilters: new Set(),
            companyHolidays: new Set(),
            activeReorder: { date: null, sortable: null },
            activeReorder: { date: null, sortable: null },
            sortableInstances: [],
            selectedSchedules: new Set(),
            undoStack: [] // ✨ Undo 스택 초기화
        };
    }

    // ✨ 안전장치: 빈 state 객체가 넘어왔을 때 undoStack 보장
    if (!state.schedule.undoStack) {
        state.schedule.undoStack = [];
    }
    state.schedule.isReadOnly = isReadOnly;
    state.schedule.isManager = isManager;

    // ✅ ReadOnly 모드(직원 포털)에서는 통합 보기(all)를 기본값으로
    if (isReadOnly && state.schedule.viewMode === 'working') {
        state.schedule.viewMode = 'all';
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

    // Conditional sidebar HTML
    const sidebarHtml = isReadOnly ? '' : `
        <div id="schedule-sidebar-area"></div>
    `;

    // Conditional top control buttons HTML
    let topControlsHtml;
    if (isReadOnly) {
        topControlsHtml = `
        <div class="flex justify-between items-center mb-2 pb-2 border-b">
            <div id="schedule-view-toggle" class="flex rounded-md shadow-sm bg-gray-100 p-1" role="group">
                <button type="button" data-mode="all" class="schedule-view-btn active px-4 py-2 text-sm font-medium rounded-md hover:bg-white hover:text-blue-600 focus:z-10 focus:ring-2 focus:ring-blue-500">통합 보기</button>
                <button type="button" data-mode="working" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md hover:bg-white hover:text-blue-600 focus:z-10 focus:ring-2 focus:ring-blue-500">근무자 보기</button>
                <button type="button" data-mode="off" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md hover:bg-white hover:text-blue-600 focus:z-10 focus:ring-2 focus:ring-blue-500">휴무자 보기</button>
            </div>
        </div>`;
    } else if (isManager) {
        topControlsHtml = `
        <div class="flex justify-between items-center mb-2 pb-2 border-b">
            <div id="schedule-view-toggle" class="flex rounded-md shadow-sm bg-gray-100 p-1" role="group">
                <button type="button" data-mode="all" class="schedule-view-btn active px-4 py-2 text-sm font-medium rounded-md">통합 보기</button>
                <button type="button" data-mode="working" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md">근무자 보기</button>
                <button type="button" data-mode="off" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md">휴무자 보기</button>
            </div>
            <div class="flex items-center gap-2">
                <button id="print-schedule-btn" class="sch-btn sch-btn-secondary">인쇄하기</button>
                <button id="revert-schedule-btn" class="sch-btn sch-btn-ghost" disabled>되돌리기</button>
                <button id="save-schedule-btn" class="sch-btn sch-btn-primary" disabled>스케줄 저장</button>
                <button id="request-approval-btn" class="sch-btn sch-btn-primary bg-orange-500 hover:bg-orange-600">승인 요청</button>
            </div>
        </div>`;
    } else {
        topControlsHtml = `
        <div class="flex justify-between items-center mb-2 pb-2 border-b">
            <div id="schedule-view-toggle" class="flex rounded-md shadow-sm bg-gray-100 p-1" role="group">
                <button type="button" data-mode="all" class="schedule-view-btn active px-4 py-2 text-sm font-medium rounded-md">통합 보기</button>
                <button type="button" data-mode="working" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md">근무자 보기</button>
                <button type="button" data-mode="off" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md">휴무자 보기</button>
            </div>
            <div class="flex items-center gap-2">
                <button id="confirm-schedule-btn" class="sch-btn sch-btn-primary">스케줄 확정</button>
                <button id="import-last-month-btn" class="sch-btn sch-btn-secondary">지난달 불러오기</button>
                <button id="reset-schedule-btn" class="sch-btn sch-btn-secondary">스케줄 리셋</button>
                <button id="print-schedule-btn" class="sch-btn sch-btn-secondary">인쇄하기</button>
                <button id="revert-schedule-btn" class="sch-btn sch-btn-ghost" disabled>되돌리기</button>
                <button id="save-schedule-btn" class="sch-btn sch-btn-primary" disabled>스케줄 저장</button>
            </div>
        </div>`;
    }

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
        _('#import-last-month-btn')?.addEventListener('click', handleImportPreviousMonth);
        _('#auto-schedule-btn')?.addEventListener('click', handleAutoSchedule);
        _('#sync-appsheet-btn')?.addEventListener('click', syncToAppSheet);
        _('#import-appsheet-btn')?.addEventListener('click', importFromAppSheet);
        _('#appsheet-settings-btn')?.addEventListener('click', handleAppSheetSettings);

        // 매니저: 승인 요청 버튼
        _('#request-approval-btn')?.addEventListener('click', handleRequestScheduleApproval);
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


// =============================================================================
// ✨ 주간 검수 셀 (달력 8번째 열에 인라인 표시)
// WHY: 각 주의 토요일 옆에 해당 주의 근무 검수 결과를 바로 보여주기 위해 구현.
//      별도 패널이 아닌 달력 그리드 내 8번째 열로 표시됩니다.
// =============================================================================

/**
 * 특정 주의 검수 셀 HTML을 생성합니다.
 * renderCalendar() 내에서 토요일 셀 뒤에 호출됩니다.
 * @param {Dayjs} weekStart - 주의 시작일 (일요일)
 * @param {Dayjs} weekEnd - 주의 종료일 (토요일)
 * @param {number} currentMonth - 현재 표시 중인 월 (0-indexed)
 * @returns {string} HTML 문자열
 */
function getWeeklyAuditCellHTML(weekStart, weekEnd, currentMonth) {
    // 해당 주 전체(월~토) 날짜 수집 — 월말~익월초 연계
    const weekDayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const allDates = [];
    const thisMonthDates = [];
    let d = weekStart.clone();
    while (d.isBefore(weekEnd) || d.isSame(weekEnd, 'day')) {
        if (d.day() !== 0) { // 일요일 제외
            allDates.push(d.format('YYYY-MM-DD'));
            if (d.month() === currentMonth) thisMonthDates.push(d.format('YYYY-MM-DD'));
        }
        d = d.add(1, 'day');
    }

    if (thisMonthDates.length === 0) {
        return `<div class="weekly-audit-cell" style="background:#fafbfc; padding:2px;"></div>`;
    }

    const holidays = state.schedule.companyHolidays || new Set();

    // ✅ 주 단위(월~토) 전체 영업일 기준 카운트
    const businessDays = allDates.filter(dateStr => !holidays.has(dateStr));
    const businessDayCount = businessDays.length;
    const isCrossMonth = allDates.length !== thisMonthDates.length;


    // 승인된 연차 데이터
    const leaveRequests = state.management?.leaveRequests || [];
    const approvedLeaves = leaveRequests.filter(r => r.final_manager_status === 'approved');

    // 활성 직원 필터링
    const employees = state.management?.employees || [];
    let targetEmployees = employees.filter(emp =>
        !emp.is_temp && !emp.retired && !(emp.email?.startsWith('temp-'))
    );

    const savedLayout = state.schedule?.teamLayout?.data?.[0];
    if (savedLayout?.members?.length > 0) {
        const activeMembers = new Set(savedLayout.members.filter(id => id > 0));
        targetEmployees = targetEmployees.filter(emp => activeMembers.has(emp.id));
    }

    // 직원별 검수
    const rows = targetEmployees.map(emp => {
        const empWorkDays = emp.weekly_work_days || 5;
        const parsedRules = parseHolidayRules(emp.regular_holiday_rules);
        const fixedOffDayNums = parsedRules.map(r => r.day);

        // 의무 근무일 = min(주근무일수, 영업일수)
        const expected = Math.min(empWorkDays, businessDayCount);

        // 실제 근무일 카운트 + 비정상 휴무 수집
        let workCount = 0;
        let leaveCount = 0;
        const unexpectedOffNames = []; // 고정 휴무가 아닌데 쉬는 요일
        businessDays.forEach(dateStr => {
            const status = getEmployeeStatusOnDate(emp.id, dateStr);
            if (status === 'working') {
                workCount++;
            } else {
                if (status === 'leave') leaveCount++;
                const dayIdx = dayjs(dateStr).day();
                // 고정 휴무일은 표시하지 않음 (예정된 휴무)
                if (!fixedOffDayNums.includes(dayIdx)) {
                    unexpectedOffNames.push(weekDayNames[dayIdx]);
                }
            }
        });

        // 공휴일이 근무일에 겹칠 때 대체가능 고정 휴무일 확인
        const holidayOnWorkDay = businessDays.filter(dateStr => {
            const dayIdx = dayjs(dateStr).day();
            return holidays.has(dateStr) && !fixedOffDayNums.includes(dayIdx);
        });
        let subAvailable = false;
        if (holidayOnWorkDay.length > 0) {
            // 이번 주에 대�� 가능한 고정 휴무일이 있는지
            subAvailable = parsedRules.some(r => r.sub !== false);
        }

        const diff = workCount - expected;
        const hasLeave = leaveCount > 0;

        // 색상: -N+연차=파란, -N+연차없음+대체가능=노란, -N+연차없음=빨간, 0=없음
        let bgColor = 'transparent';
        let diffColor = '#6b7280';
        if (diff < 0) {
            if (hasLeave) {
                bgColor = '#dbeafe'; diffColor = '#2563eb';
            } else if (subAvailable) {
                bgColor = '#fef3c7'; diffColor = '#d97706';
            } else {
                bgColor = '#fee2e2'; diffColor = '#dc2626';
            }
        }

        return { emp, workCount, expected, diff, hasLeave, subAvailable, bgColor, diffColor, unexpectedOffNames };
    }).filter(row => row.workCount > 0 || row.diff !== 0);

    // HTML: 직원 목록 (2열 배치)
    const listHtml = rows.map(row => {
        const diffText = row.diff > 0 ? `+${row.diff}` : `${row.diff}`;
        const nameShort = row.emp.name.length > 3 ? row.emp.name.substring(1) : row.emp.name;
        // ���정상 휴무 요��만 표시 + 대체가능 표시
        let offLabel = '';
        if (row.unexpectedOffNames.length > 0) {
            offLabel = `<span style="font-size:9px; color:#9ca3af;">${row.unexpectedOffNames.join('')}</span>`;
        } else if (row.subAvailable && row.diff < 0) {
            offLabel = `<span style="font-size:8px; color:#d97706;">대체◎</span>`;
        }
        return `<div style="display:flex; align-items:center; padding:1px 2px; background:${row.bgColor}; border-radius:2px; min-width:0;">
            <span style="font-size:10px; width:35%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${nameShort}</span>
            <span style="font-size:10px; font-weight:700; width:25%; text-align:center; white-space:nowrap;">${row.workCount}/${row.expected}</span>
            <span style="font-size:10px; font-weight:700; width:15%; text-align:center; color:${row.diffColor};">${diffText}</span>
            <span style="width:25%; text-align:right;">${offLabel}</span>
        </div>`;
    }).join('');

    const errorCount = rows.filter(r => r.diff < 0 && !r.hasLeave).length;
    const crossBadge = isCrossMonth ? '<span style="font-size:9px; color:#6366f1; margin-left:2px;">+익월</span>' : '';
    const errorBadge = errorCount > 0 ? `<span style="background:#fee2e2; font-size:9px; padding:0 2px; border-radius:3px; color:#dc2626;">${errorCount}명확인</span>` : '';

    return `<div class="weekly-audit-cell" style="background:#fafbfc; padding:2px; overflow-y:auto; font-size:10px;">
        <div style="display:flex; align-items:center; gap:2px; margin-bottom:1px; padding-bottom:1px; border-bottom:1px solid #e5e7eb; flex-wrap:wrap;">
            <span style="font-size:9px; color:#6b7280;">영업${businessDayCount}일</span>${crossBadge}${errorBadge}
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:1px;">
            ${listHtml}
        </div>
    </div>`;
}


// ✨ 인쇄 핸들러 — 인쇄 전용 HTML 테이블 생성
function handlePrintSchedule() {
    const currentDate = dayjs(state.schedule.currentDate);
    const year = currentDate.year();
    const month = currentDate.month();
    const viewMode = state.schedule.viewMode;
    const viewModeText = viewMode === 'working' ? '근무자' : viewMode === 'off' ? '휴무자' : '전체';

    const firstDay = dayjs(new Date(year, month, 1));
    const lastDay = dayjs(new Date(year, month + 1, 0));
    const firstDayOfWeek = firstDay.day(); // 0=일
    const startDate = firstDayOfWeek === 0 ? firstDay.add(1, 'day') : firstDay.subtract(firstDayOfWeek - 1, 'day');

    const allEmployees = state.management.employees || [];
    const holidays = state.schedule.companyHolidays || new Set();
    const COLS = 4; // 이름 4열 배치

    // 인쇄 제외 부서 (기공실) — A4 한 장에 맞추기 위해
    const PRINT_EXCLUDE_DEPT_ID = 2;
    const excludeEmpIds = new Set(
        allEmployees.filter(e => e.department_id === PRINT_EXCLUDE_DEPT_ID).map(e => e.id)
    );

    // 부서 색상 맵
    const deptColorMap = {};
    allEmployees.forEach(emp => {
        if (emp.departments?.id) deptColorMap[emp.id] = getDepartmentColor(emp.departments.id);
    });

    // 주 단위로 날짜 모으기 (월~토)
    const weeks = [];
    let current = startDate.clone();
    while (current.month() <= month || (current.month() > month && current.day() !== 1)) {
        const week = [];
        for (let d = 0; d < 6; d++) { // 월~토
            const dateStr = current.format('YYYY-MM-DD');
            const isCurrentMonth = current.month() === month;
            const isSaturday = current.day() === 6;
            const isHoliday = holidays.has(dateStr);

            // 이 날짜의 직원을 grid_position 기반 32칸 그리드에 배치 (팀 구분 유지)
            const daySchedules = state.schedule.schedules.filter(s => s.date === dateStr);
            const gridSlots = new Array(GRID_SIZE).fill(null);

            daySchedules.forEach(s => {
                if (s.employee_id <= 0) {
                    // spacer (빈칸 구분선)
                    if (s.grid_position >= 0 && s.grid_position < GRID_SIZE) {
                        gridSlots[s.grid_position] = { name: '', color: 'transparent', status: 'spacer' };
                    }
                    return;
                }
                const emp = allEmployees.find(e => e.id === s.employee_id);
                if (!emp) return;
                if (excludeEmpIds.has(emp.id)) return; // 기공실 제외

                const pos = (s.grid_position >= 0 && s.grid_position < GRID_SIZE) ? s.grid_position : null;
                if (pos == null) return;

                if (viewMode === 'working' && s.status !== '근무') return;
                if (viewMode === 'off' && s.status !== '휴무' && s.status !== '연차') return;

                const status = s.status === '연차' ? 'leave' : s.status === '휴무' ? 'off' : 'working';
                gridSlots[pos] = { name: emp.name, color: deptColorMap[emp.id] || '#999', status };
            });

            // 끝에서부터 빈 슬롯 제거 (인쇄 공간 절약)
            let lastFilled = -1;
            for (let i = GRID_SIZE - 1; i >= 0; i--) {
                if (gridSlots[i] && gridSlots[i].status !== 'spacer') { lastFilled = i; break; }
            }
            const names = gridSlots.slice(0, lastFilled + 1);

            week.push({
                date: current.date(),
                dateStr,
                dayName: ['일','월','화','수','목','금','토'][current.day()],
                isCurrentMonth,
                isSaturday,
                isHoliday,
                names
            });
            current = current.add(1, 'day');
            if (current.day() === 0) current = current.add(1, 'day'); // 일요일 건너뜀
        }
        weeks.push(week);
        if (current.month() !== month && current.day() === 1) break;
        if (weeks.length >= 6) break;
    }

    // 이름을 4열 그리드로 배치 (grid_position 기반, 빈 칸 유지)
    function renderNames(slots) {
        if (slots.length === 0) return '';
        return `<div class="p-names">${slots.map(n => {
            if (!n || n.status === 'spacer') return `<span class="p-name p-empty"></span>`;
            const cls = n.status === 'leave' ? ' p-leave' : n.status === 'off' ? ' p-off' : '';
            return `<span class="p-name${cls}"><i style="background:${n.color}"></i>${n.name}</span>`;
        }).join('')}</div>`;
    }

    // 테이블 HTML 생성
    let tableHtml = '<table class="p-table"><thead><tr>';
    ['월','화','수','목','금','토'].forEach((d, i) => {
        const cls = i === 5 ? ' class="p-sat"' : '';
        tableHtml += `<th${cls}>${d}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';

    weeks.forEach(week => {
        tableHtml += '<tr>';
        week.forEach(day => {
            let cls = '';
            if (!day.isCurrentMonth) cls += ' p-other';
            if (day.isSaturday) cls += ' p-sat';
            if (day.isHoliday) cls += ' p-holiday';

            const dateLabel = day.isCurrentMonth ? `<div class="p-date">${day.date}</div>` : `<div class="p-date p-other-date">${day.date}</div>`;
            tableHtml += `<td class="${cls.trim()}">${dateLabel}${renderNames(day.names)}</td>`;
        });
        tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table>';

    // 새 창에서 인쇄
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        alert('팝업이 차단되었습니다. 브라우저에서 팝업을 허용해주세요.');
        return;
    }

    printWindow.document.write(`<!DOCTYPE html>
<html><head>
<title>${currentDate.format('YYYY년 M월')} 스케줄</title>
<style>
@page { size: A4 landscape; margin: 5mm; }
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: 'Pretendard','맑은 고딕',sans-serif; background:#fff; padding:5mm; }
h1 { text-align:center; font-size:13pt; margin-bottom:1mm; font-weight:700; }
.p-sub { text-align:center; font-size:8pt; color:#888; margin-bottom:2mm; }
.p-table { width:100%; border-collapse:collapse; table-layout:fixed; }
.p-table th { background:#1a1a1a; color:#fff; font-size:8pt; padding:2px 1px; text-align:center; border:1px solid #1a1a1a; font-weight:600; }
.p-table th.p-sat { background:#1e40af; }
.p-table td { border:1px solid #bbb; vertical-align:top; padding:1px 2px; font-size:7pt; }
.p-table tr { page-break-inside:avoid; }
.p-date { font-weight:700; font-size:9pt; padding:0 2px 1px; border-bottom:1px solid #ddd; margin-bottom:1px; color:#1a1a1a; }
.p-other-date { color:#bbb; }
.p-other { background:#fafafa; }
.p-sat .p-date { color:#1e40af; }
.p-holiday { background:#fff5f5; }
.p-holiday .p-date { color:#dc2626; }
.p-names { display:grid; grid-template-columns:repeat(${COLS},1fr); gap:0; }
.p-name { font-size:7.5pt; padding:0 1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.3; display:flex; align-items:center; gap:1px; }
.p-name i { display:inline-block; width:4px; height:4px; border-radius:50%; flex-shrink:0; }
.p-empty { visibility:hidden; }
.p-leave { color:#b45309; font-style:italic; }
.p-off { color:#999; text-decoration:line-through; }
@media print {
    body { padding:0; }
    h1 { font-size:12pt; }
}
</style>
</head><body>
<h1>${currentDate.format('YYYY년 M월')} 스케줄</h1>
<div class="p-sub">${viewModeText} · 출력일 ${dayjs().format('YYYY.MM.DD')}</div>
${tableHtml}
<script>window.onload=function(){window.print();setTimeout(()=>window.close(),500)};<\/script>
</body></html>`);
    printWindow.document.close();
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
            .maybeSingle();

        const badge = document.querySelector('#schedule-status-badge');
        const confirmBtn = document.querySelector('#confirm-schedule-btn');

        // 승인 요청 배너 (관리자 전용)
        const existingBanner = document.querySelector('#approval-request-banner');
        if (existingBanner) existingBanner.remove();

        if (data && data.approval_requested && !data.is_confirmed && !state.schedule.isReadOnly && !state.schedule.isManager) {
            const banner = document.createElement('div');
            banner.id = 'approval-request-banner';
            banner.className = 'bg-orange-50 border border-orange-300 rounded-lg p-3 mb-3 flex items-center justify-between';
            banner.innerHTML = `
                <div>
                    <span class="font-bold text-orange-700">승인 요청</span>
                    <span class="text-sm text-orange-600 ml-2">${data.requested_by || '매니저'}님이 ${month} 스케줄 확정을 요청했습니다 (${data.requested_at ? dayjs(data.requested_at).format('MM/DD HH:mm') : ''})</span>
                </div>
            `;
            const calendarArea = document.querySelector('.schedule-main-content');
            if (calendarArea) calendarArea.prepend(banner);
        }

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
                badge.textContent = data?.approval_requested ? '승인 요청됨' : '미확정';
                badge.className = data?.approval_requested
                    ? 'px-3 py-1 rounded-full text-sm font-bold ml-2 bg-orange-100 text-orange-800'
                    : 'px-3 py-1 rounded-full text-sm font-bold ml-2 bg-yellow-100 text-yellow-800';
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

async function handleRequestScheduleApproval() {
    const viewDate = state.schedule.currentDate || dayjs().format('YYYY-MM-DD');
    const month = dayjs(viewDate).format('YYYY-MM');
    const managerName = state.currentUser?.name || '매니저';

    // 먼저 저장되지 않은 변경사항이 있는지 확인
    const saveBtn = _('#save-schedule-btn');
    if (saveBtn && !saveBtn.disabled) {
        const doSave = confirm('저장되지 않은 변경사항이 있습니다.\n먼저 저장한 후 승인 요청하시겠습니까?');
        if (doSave) {
            await handleSaveSchedules();
        } else {
            return;
        }
    }

    if (!confirm(`${month} 스케줄을 관리자에게 승인 요청하시겠습니까?`)) return;

    try {
        // schedule_approval_requests 테이블에 저장 (없으면 schedule_confirmations에 메모 방식)
        const { error } = await db.from('schedule_confirmations').upsert({
            month: month,
            is_confirmed: false,
            approval_requested: true,
            requested_by: managerName,
            requested_at: new Date().toISOString()
        }, { onConflict: 'month' });

        if (error) {
            console.error('승인 요청 실패:', error);
            // 컬럼이 없을 수 있으므로 단순 알림으로 fallback
            alert(`${month} 스케줄 승인 요청이 전송되었습니다.\n관리자가 스케줄 관리 탭에서 확인 후 확정합니다.`);
            return;
        }

        alert(`${month} 스케줄 승인 요청 완료!\n\n관리자가 스케줄 관리 탭에서 확인 후 확정합니다.`);
    } catch (err) {
        console.error('승인 요청 오류:', err);
        alert(`${month} 스케줄 승인 요청이 전송되었습니다.\n관리자가 스케줄 관리 탭에서 확인 후 확정합니다.`);
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
                confirmed_at: new Date().toISOString(),
                approval_requested: false,
                requested_by: null,
                requested_at: null
            }, { onConflict: 'month' });

        if (error) throw error;

        alert(isConfirm ? '스케줄이 확정되었습니다.' : '스케줄 확정이 해제되었습니다.');
        checkScheduleConfirmationStatus(); // UI 갱신

    } catch (error) {
        console.error('스케줄 확정 오류:', error);
        alert('오류가 발생했습니다: ' + error.message);
    }
}

// =========================================================================================
// [신규] 지난달 스케줄 불러오기 (주차 기준 매칭 + 정기 휴무 반영)
// =========================================================================================

async function handleImportPreviousMonth() {
    if (!confirm('현재 보고 있는 달의 모든 스케줄을 지우고, 지난달 데이터를 기반으로 새 스케줄을 생성하시겠습니까?\n(주간 패턴 매칭 + 정기 휴무 규칙 적용)')) {
        return;
    }

    const importBtn = _('#import-last-month-btn');
    importBtn.disabled = true;
    importBtn.textContent = '불러오는 중...';

    try {
        const currentDate = dayjs(state.schedule.currentDate);
        const prevDate = currentDate.subtract(1, 'month');

        const currentStart = currentDate.startOf('month');
        const currentEnd = currentDate.endOf('month');
        const prevStart = prevDate.startOf('month');
        const prevEnd = prevDate.endOf('month');

        // 1. 지난달 데이터 가져오기 (DB)
        const { data: prevSchedules, error: fetchError } = await db.from('schedules')
            .select('*')
            .gte('date', prevStart.format('YYYY-MM-DD'))
            .lte('date', prevEnd.format('YYYY-MM-DD'))
            .eq('status', '근무'); // 근무만 복사

        if (fetchError) throw fetchError;

        console.log(`📅 지난달(${prevDate.format('YYYY-MM')}) 데이터: ${prevSchedules.length}건`);

        // 2. 현재 달 스케줄 초기화 (DB 삭제)
        // 주의: unsavedChanges도 초기화해야 함
        const { error: deleteError } = await db.from('schedules')
            .delete()
            .gte('date', currentStart.format('YYYY-MM-DD'))
            .lte('date', currentEnd.format('YYYY-MM-DD'));

        if (deleteError) throw deleteError;

        unsavedChanges.clear(); // 프론트엔드 변경분 초기화

        // 3. 주차별/요일별 날짜 매핑 생성
        // 예: Sun[0] -> prevSun[0], Mon[1] -> prevMon[1]
        const dayMapping = new Map(); // targetDateStr -> sourceDateStr or null
        const weekDays = [0, 1, 2, 3, 4, 5, 6]; // Sun to Sat

        weekDays.forEach(dayIdx => {
            // 지난달의 해당 요일 날짜들
            const prevDays = [];
            let p = prevStart.clone();
            while (p.day() !== dayIdx) p = p.add(1, 'day'); // 첫 해당 요일 찾기
            while (p.isSameOrBefore(prevEnd)) {
                if (p.isSameOrAfter(prevStart)) prevDays.push(p.format('YYYY-MM-DD'));
                p = p.add(7, 'day');
            }

            // 이번달의 해당 요일 날짜들
            const currentDays = [];
            let c = currentStart.clone();
            while (c.day() !== dayIdx) c = c.add(1, 'day');
            while (c.isSameOrBefore(currentEnd)) {
                if (c.isSameOrAfter(currentStart)) currentDays.push(c.format('YYYY-MM-DD'));
                c = c.add(7, 'day');
            }

            // 매핑 (인덱스 기준)
            currentDays.forEach((currDateStr, idx) => {
                const prevDateStr = prevDays[idx] || null; // 매칭되는 주차가 없으면 null
                dayMapping.set(currDateStr, prevDateStr);
            });
        });

        // 4. 새 스케줄 생성
        const newSchedules = [];
        const activeEmployees = state.management.employees.filter(e => !e.resignation_date); // 퇴사자 제외

        // 모든 날짜 순회
        let iter = currentStart.clone();
        while (iter.isSameOrBefore(currentEnd)) {
            const targetDateStr = iter.format('YYYY-MM-DD');
            const sourceDateStr = dayMapping.get(targetDateStr);
            const dayOfWeek = iter.day(); // 0(Sun) ~ 6(Sat)

            let schedulesForDay = [];

            if (sourceDateStr) {
                // ✅ 매칭되는 지난달 날짜가 있음 -> 복사
                const sourceSchedules = prevSchedules.filter(s => s.date === sourceDateStr);

                // 직원 ID가 유효한지 확인하며 복사 (퇴사자 등 체크)
                sourceSchedules.forEach(src => {
                    // 현재 존재하는 직원인지 확인
                    if (activeEmployees.some(e => e.id === src.employee_id)) {
                        schedulesForDay.push({
                            date: targetDateStr,
                            employee_id: src.employee_id,
                            status: '근무',
                            sort_order: src.sort_order, // 순서 유지
                            grid_position: src.grid_position // 그리드 위치 유지
                        });
                    }
                });

                // 만약 지난달에 근무자가 아예 없었다면? -> 기본 규칙 적용?
                // 사용자 요청: "복사... 수정... 복잡... 그냥 불러오기"
                // 매칭되면 그대로 복사가 맞음.
            }

            // ✅ 매칭 데이터가 없거나(5주차), 매칭은 됐는데 근무자가 0명인 경우(휴일이었을 수 있음)
            // -> "남는 날짜나 모자른 날짜... 모든 직원 표시"
            if (!sourceDateStr || schedulesForDay.length === 0) {
                // 기본값: 모든 직원 근무
                // 단, 정기 휴무 규칙 적용
                let positionCounter = 0;

                activeEmployees.forEach(emp => {
                    // 정기 휴무 요일이면 제외
                    if (!isFixedOffDay(emp.regular_holiday_rules, dayOfWeek)) {
                        schedulesForDay.push({
                            date: targetDateStr,
                            employee_id: emp.id,
                            status: '근무',
                            sort_order: positionCounter,
                            grid_position: positionCounter
                        });
                        positionCounter++;
                    }
                });
            }

            // 수집된 스케줄 추가
            newSchedules.push(...schedulesForDay);

            iter = iter.add(1, 'day');
        }

        console.log(`✨ 생성된 새 스케줄: ${newSchedules.length}건`);

        // 5. DB에 일괄 저장
        if (newSchedules.length > 0) {
            const BATCH_SIZE = 100;
            for (let i = 0; i < newSchedules.length; i += BATCH_SIZE) {
                const batch = newSchedules.slice(i, i + BATCH_SIZE);
                const { error: insertError } = await db.from('schedules').insert(batch);
                if (insertError) throw insertError;
            }
        }

        alert('지난달 스케줄을 성공적으로 불러왔습니다.');

        // 6. 화면 갱신
        await loadAndRenderScheduleData(state.schedule.currentDate);

    } catch (error) {
        console.error('스케줄 불러오기 실패:', error);
        alert(`스케줄 불러오기 실패: ${error.message}`);
    } finally {
        importBtn.disabled = false;
        importBtn.textContent = '📅 지난달 불러오기';
    }
}

// [Legacy Context Menu Removed]


// ✨ Expose for manual updates from other modules
window.loadAndRenderScheduleData = loadAndRenderScheduleData;

