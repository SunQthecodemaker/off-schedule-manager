import { state, db, isVisibleIn, getEmployeeStatus, isAlbaEmployee, isTestEmployee, sortByDeptOrder } from './state.js?v=20260601a';
import { _, _all, show, hide } from './utils.js';
// AppSheet 연동 기능 복구
// 버전 고정: @latest 는 향후 빌드 변경(swap 자동 마운트 제거 등) 위험 → 1.15.7 고정.
// 1.15.7 complete 빌드는 모듈 로드 시 Swap·MultiDrag 플러그인을 자동 마운트함 (swap:true 동작).
import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.7/modular/sortable.complete.esm.js';
import { registerManualLeave } from './management.js?v=20260601c';
import { syncToAppSheet, importFromAppSheet, getScriptUrl, setScriptUrl } from './appsheet-client.js';

let unsavedChanges = new Map();
let unsavedHolidayChanges = { toAdd: new Set(), toRemove: new Set() };

// ✅ 기본 팀 배치 (엑셀 팀표 순서 — 스케줄 리셋 시 기본값)
// 1행: 원장 / 2~5행: 진료실 / 6행: 경영지원실 / 7행: 기공실
// 원칙 11단계: 스페이서(-1) 완전 제거 — (row,col) 그리드에서 빈 슬롯이 자연 경계 역할
const DEFAULT_TEAM_MEMBERS = [
    1, 29, 30, 31,       // 원장: 박선규, 류효경, 박보현, 김민재
    32, 35, 34, 38,      // 진료실1: 이고은, 최수연, 정유진, 정해인
    36, 37, 224, 40,     // 진료실2: 김민주, 최지은, 신현채, 김가현
    41, 39, 234,         // 진료실3: 최윤미, 최지혜, 김규빈
    43, 44, 45, 46,      // 경영지원실: 유시온, 최나은, 김채이, 이진현
    47, 48, 226          // 기공실: 이우현, 용윤지, 이지민
];

// ✅ 그리드 크기 상수 (모든 곳에서 이 값만 사용)
const GRID_SIZE = 32;
const GRID_COLS = 4;

// ═══════════════════════════════════════════════════════
// ✅ DB ↔ 메모리 변환 헬퍼 (원칙 2/19단계 — (row, col) 네이티브)
// DB/메모리 모두 row/col 사용. flat index 금지. off-grid 개념 완전 제거(원칙 2단계):
// 활성 직원은 항상 그리드 어딘가에 위치. 밀려난 카드는 즉시 가장 가까운 빈자리로 재배치.
// ═══════════════════════════════════════════════════════
function hydrateScheduleRow(dbRow) {
    if (!dbRow) return dbRow;
    const onGrid = (dbRow.row_pos != null && dbRow.col_pos != null);
    const { row_pos, col_pos, ...rest } = dbRow;
    return {
        ...rest,
        row: onGrid ? row_pos : null,
        col: onGrid ? col_pos : null,
        is_annual_leave: dbRow.is_annual_leave ?? false,
        // 읽기 편의용 파생 필드 — 직접 수정 금지. setSchedulePos 사용.
        grid_position: onGrid ? (row_pos * GRID_COLS + col_pos) : null
    };
}

function serializeScheduleForDb(s) {
    // 내부/UI 전용 필드 제거
    const { row, col, _origRow, _origCol, _origPos, _targetRow, _targetCol, _targetPos, _empStatus, grid_position, ...rest } = s;
    // 1차: row/col 메모리 값 우선. 2차: 레거시 grid_position 로부터 파생 (보호 장치)
    let finalRow = null, finalCol = null;
    if (isValidGridCell(row, col)) {
        finalRow = row; finalCol = col;
    } else if (grid_position != null && grid_position >= 0 && grid_position < GRID_SIZE) {
        finalRow = Math.floor(grid_position / GRID_COLS);
        finalCol = grid_position % GRID_COLS;
    }
    return {
        ...rest,
        row_pos: finalRow,
        col_pos: finalCol,
        is_annual_leave: rest.is_annual_leave ?? false
    };
}

/** 특정 (row, col) 이 그리드 유효 범위 내인지 */
function isValidGridCell(row, col) {
    return row != null && col != null &&
        row >= 0 && row < GRID_SIZE / GRID_COLS &&
        col >= 0 && col < GRID_COLS;
}

/** (row, col) 쌍을 Set 키 문자열로 */
function rcKey(row, col) {
    return `${row},${col}`;
}

/** 스케줄 객체에 그리드 위치 설정 (row/col/grid_position 동기화) */
function setSchedulePos(s, row, col) {
    if (!isValidGridCell(row, col)) {
        // 원칙 2단계: off-grid 상태 금지. 호출자가 유효한 자리를 보장해야 함.
        console.warn('setSchedulePos called with invalid cell:', row, col, '— skipped');
        return;
    }
    s.row = row;
    s.col = col;
    s.grid_position = row * GRID_COLS + col;
}

/** flat pos → row/col 동기화 */
function setSchedulePosFlat(s, pos) {
    if (pos == null || pos < 0 || pos >= GRID_SIZE) {
        console.warn('setSchedulePosFlat called with invalid pos:', pos, '— skipped');
        return;
    }
    setSchedulePos(s, Math.floor(pos / GRID_COLS), pos % GRID_COLS);
}

/**
 * 원칙 3단계: 타겟 위치에서 가장 가까운 빈 자리 탐색 (displaced 카드 재배치용).
 * 거리 = |Δrow| + |Δcol| (Manhattan). 동거리면 pos(flat) 오름차순.
 * @returns {number|null} 빈 자리 flat pos 또는 null(모든 자리 점유됨)
 */
function findNearestEmptyPos(targetPos, occupied) {
    if (occupied.size >= GRID_SIZE) return null;
    const tRow = Math.floor(targetPos / GRID_COLS);
    const tCol = targetPos % GRID_COLS;
    let bestPos = null, bestDist = Infinity;
    for (let p = 0; p < GRID_SIZE; p++) {
        if (occupied.has(p)) continue;
        const r = Math.floor(p / GRID_COLS);
        const c = p % GRID_COLS;
        const d = Math.abs(r - tRow) + Math.abs(c - tCol);
        if (d < bestDist || (d === bestDist && p < bestPos)) {
            bestDist = d;
            bestPos = p;
        }
    }
    return bestPos;
}

/** 스케줄이 그리드 위에 있는지 */
function isOnGrid(s) {
    return s && isValidGridCell(s.row, s.col);
}

/** 스케줄이 특정 (row, col) 에 있는지 */
function isAt(s, row, col) {
    return s && isValidGridCell(s.row, s.col) && s.row === row && s.col === col;
}

/** DOM data-position (flat) → (row, col). DOM은 선형 순서이므로 data-position 유지 */
function posToRC(pos) {
    return { row: Math.floor(pos / GRID_COLS), col: pos % GRID_COLS };
}

/** (row, col) → DOM data-position (flat). DOM attribute 생성용 */
function rcToPos(row, col) {
    return row * GRID_COLS + col;
}

/** 직원이 그리드 표시 대상인지 (시간 무관 — schedule_visible 토글까지 반영)
 *  state.js 의 isVisibleIn('schedule_grid', ...) 단일 헬퍼 위임. */
function isGridEmployee(e) {
    return isVisibleIn('schedule_grid', e);
}

/** 직원이 특정 날짜에 그리드에 표시되어야 하는지 판별 (날짜별 휴직·퇴사 고려)
 *  state.js 의 getEmployeeStatus 단일 헬퍼 위임. */
function isActiveOnDate(emp, dateStr) {
    if (!emp) return false;
    const s = getEmployeeStatus(emp, dateStr);
    return s === 'active' || s === 'test'; // 알바·퇴사·휴직·hidden 격리
}

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

/** 고정 휴무 요일 번호 배열 반환 (기존 코드 호환 — weeks 무시, 모든 휴무 요일) */
function getFixedOffDays(rules) {
    return parseHolidayRules(rules).map(r => r.day);
}

/**
 * 달력 주 행 번호 계산 (그 달의 달력에서 몇 번째 주 행인지)
 * 1일이 속한 주 = 1주, 다음 주 = 2주, ...
 */
function getCalendarWeekRow(dateStr) {
    const d = dayjs(dateStr);
    const firstOfMonth = d.startOf('month');
    // 1일이 속한 주의 월요일 (달력 시작점)
    const firstDow = firstOfMonth.day(); // 0=일, 1=월, ...
    const firstMonday = firstDow <= 1
        ? firstOfMonth.subtract(firstDow === 0 ? 6 : 0, 'day')
        : firstOfMonth.subtract(firstDow - 1, 'day');
    // 해당 날짜가 속한 주의 월요일
    const dow = d.day();
    const thisMonday = dow === 0 ? d.subtract(6, 'day') : d.subtract(dow - 1, 'day');
    // 주 차이 + 1
    return Math.floor(thisMonday.diff(firstMonday, 'day') / 7) + 1;
}

/**
 * 특정 날짜가 고정 휴무인지 (주차별 규칙 포함)
 * @param {Array} rules - regular_holiday_rules
 * @param {number} dayOfWeek - 요일 번호 (0=일, 1=월, ..., 6=토)
 * @param {string} [dateStr] - 날짜 문자열 (YYYY-MM-DD), 주차 판정용. 없으면 weeks 무시.
 */
function isFixedOffDay(rules, dayOfWeek, dateStr) {
    const parsed = parseHolidayRules(rules);
    return parsed.some(r => {
        if (r.day !== dayOfWeek) return false;
        if (!r.weeks || !dateStr) return true; // weeks 없으면 매주 적용
        const weekRow = getCalendarWeekRow(dateStr);
        return r.weeks.includes(weekRow);
    });
}

/** 특정 요일의 대체근무 가능 여부 */
function isSubstitutable(rules, dayOfWeek, dateStr) {
    const parsed = parseHolidayRules(rules);
    const rule = parsed.find(r => {
        if (r.day !== dayOfWeek) return false;
        if (!r.weeks || !dateStr) return true;
        const weekNum = Math.ceil(dayjs(dateStr).date() / 7);
        return r.weeks.includes(weekNum);
    });
    return rule ? rule.sub !== false : false;
}

// ═══════════════════════════════════════════════════════
// ✅ 통합 네임카드 조작 헬퍼 (모든 이동/붙여넣기가 이 함수를 사용)
// 공통 규칙:
//   R1: 밀어내기 — 타겟 위치에 기존 카드 있으면 (근무/휴무 무관) 빈 자리로 이동
//   R2: 이름 중복 방지 — 같은 날짜에 같은 직원이 이동한 거니까 기존것 제거
//   R4: 복수 조작 = 배열 단위 — 1개든 10개든 동일 경로
// ═══════════════════════════════════════════════════════

/** 해당 날짜에서 특정 직원 이외의 모든 점유 위치 Set 반환 (레코드 유무 무관) */
function getOccupiedPositions(dateStr, excludeEmpId) {
    const occupied = new Set();
    const basePositions = getEmployeeBasePositions();
    const activeEmps = (state.management.employees || []).filter(
        e => isGridEmployee(e)
    );

    // 레코드가 있으면 레코드의 grid_position, 없으면 배치 패널 기본 위치
    const dateScheds = new Map();
    state.schedule.schedules.forEach(s => {
        if (s.date === dateStr && s.employee_id > 0) dateScheds.set(s.employee_id, s);
    });

    activeEmps.forEach(emp => {
        if (emp.id === excludeEmpId) return;
        const sched = dateScheds.get(emp.id);
        const pos = (sched && sched.grid_position != null && sched.grid_position >= 0)
            ? sched.grid_position
            : basePositions.get(emp.id);
        if (pos != null && pos >= 0) occupied.add(pos);
    });

    return occupied;
}

/** 해당 날짜에서 가장 가까운 빈 자리 찾기 (근무/휴무 무관) */
function findNearestEmpty(dateStr, fromPos, excludeEmpId) {
    const occupied = getOccupiedPositions(dateStr, excludeEmpId);
    // fromPos 근처에서 양방향 탐색
    for (let dist = 1; dist < GRID_SIZE; dist++) {
        if (fromPos + dist < GRID_SIZE && !occupied.has(fromPos + dist)) return fromPos + dist;
        if (fromPos - dist >= 0 && !occupied.has(fromPos - dist)) return fromPos - dist;
    }
    return -1;
}

/**
 * 카드를 특정 날짜의 특정 위치에 배치
 * @param {Array} items - [{employee_id, status?}] 배치할 직원 목록
 * @param {string} dateStr - 대상 날짜 (YYYY-MM-DD)
 * @param {number|null} startPos - 시작 위치 (null이면 자동 탐색)
 * @returns {number} 배치된 개수
 */
function placeCards(items, dateStr, startPos = null) {
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트)
    if (state.schedule?.isReadOnly) return 0;
    // 원칙 15단계: 공휴일 날짜에는 카드 배치/이동 비활성
    if (state.schedule.companyHolidays?.has(dateStr)) {
        alert('공휴일/전원 휴무일입니다. 날짜를 더블클릭하여 해제한 뒤 배치해주세요.');
        return 0;
    }
    let placed = 0;

    // 상대 위치 보존: _origPos 있으면 (row,col) 델타 기반 계산 (flat index 금지, CLAUDE.md 원칙)
    const hasOrigPos = items.some(i => i._origPos != null);
    let rowDelta = 0, colDelta = 0;
    if (hasOrigPos && startPos != null && items[0]._origPos != null) {
        const fromRow = Math.floor(items[0]._origPos / GRID_COLS);
        const fromCol = items[0]._origPos % GRID_COLS;
        const toRow = Math.floor(startPos / GRID_COLS);
        const toCol = startPos % GRID_COLS;
        rowDelta = toRow - fromRow;
        colDelta = toCol - fromCol;
    }

    // 복수 배치 시 선택된 카드끼리는 서로 빈자리 처리하지 않음 (CLAUDE.md 네임카드 규칙)
    const selectedEmpIds = new Set(items.map(i => i.employee_id));

    // (row, col) 델타 적용 시 경계 검사: 하나라도 OOB 이면 이동 전체 취소
    if (hasOrigPos && (rowDelta !== 0 || colDelta !== 0)) {
        for (const it of items) {
            if (it._origPos == null) continue;
            const origRow = Math.floor(it._origPos / GRID_COLS);
            const origCol = it._origPos % GRID_COLS;
            const newRow = origRow + rowDelta;
            const newCol = origCol + colDelta;
            if (newRow < 0 || newCol < 0 || newCol >= GRID_COLS || newRow * GRID_COLS + newCol >= GRID_SIZE) {
                return 0; // OOB 전체 취소
            }
        }
    }

    items.forEach((item, idx) => {
        const empId = item.employee_id;

        // 배치할 position 결정
        let assignPos = -1;
        if (item._targetPos != null && item._targetPos >= 0 && item._targetPos < GRID_SIZE) {
            // 호출자가 각 카드의 타겟 위치를 직접 지정 (row/col 델타 기반 배치 등)
            assignPos = item._targetPos;
        } else if (hasOrigPos && item._origPos != null) {
            const origRow = Math.floor(item._origPos / GRID_COLS);
            const origCol = item._origPos % GRID_COLS;
            assignPos = (origRow + rowDelta) * GRID_COLS + (origCol + colDelta);
        } else if (startPos != null && startPos >= 0 && startPos < GRID_SIZE) {
            assignPos = startPos + idx;
        } else {
            // 자동 빈자리 탐색 (근무/휴무 무관하게 점유 판단)
            const occupied = getOccupiedPositions(dateStr, empId);
            for (let i = 0; i < GRID_SIZE; i++) {
                if (!occupied.has(i)) { assignPos = i; break; }
            }
        }

        if (assignPos < 0 || assignPos >= GRID_SIZE) {
            return;
        }

        // 현재 뷰에 따른 밀려난 카드 상태 (근무자뷰→휴무, 휴무자뷰→근무, 통합→휴무)
        const currentView = state.schedule.viewMode || 'all';
        const displacedStatus = (currentView === 'off') ? '근무' : '휴무';

        // 🎯 점유 판단은 '통합 보기 기준'(레코드 + 기본배치 전원).
        //    규칙: 타겟이 빈자리면 그냥 그 자리에 배치. 누가 있으면 그 점유자 1명만
        //    가장 가까운 '진짜' 빈자리로 옮긴다. 그 사이 카드들은 절대 안 건드린다.
        const effOcc = getEffectiveOccupancy(dateStr);            // pos -> {employee_id, record|null}
        const occupant = effOcc.get(assignPos);
        if (occupant
            && occupant.employee_id !== empId
            && occupant.employee_id > 0
            && !selectedEmpIds.has(occupant.employee_id)) {
            // 진짜 빈자리 탐색: 전체 점유(통합 기준) + 이번 배치의 타겟들을 제외
            const occupiedSet = new Set(effOcc.keys());
            items.forEach(it => { occupiedSet.add(it._targetPos != null ? it._targetPos : assignPos); });
            const nearest = findNearestEmptyPos(assignPos, occupiedSet);
            if (nearest != null) {
                const rec = occupant.record;
                if (rec) {
                    // 기존 레코드 보유 → 위치만 이동 (연차자는 상태 유지)
                    if (!rec.is_annual_leave) rec.status = displacedStatus;
                    setSchedulePosFlat(rec, nearest);
                    rec.sort_order = nearest;
                    unsavedChanges.set(rec.id, { type: 'update', data: rec });
                } else {
                    // 기본배치만 있던 직원 → 새 레코드로 빈자리에 고정 (연차자는 휴무 표기 유지)
                    const isLeaveOcc = getEmployeeStatusOnDate(occupant.employee_id, dateStr) === 'leave';
                    const nRow = Math.floor(nearest / GRID_COLS);
                    const nCol = nearest % GRID_COLS;
                    const newSched = {
                        id: `displace-${Date.now()}-${occupant.employee_id}-${Math.random()}`,
                        date: dateStr,
                        employee_id: occupant.employee_id,
                        status: isLeaveOcc ? '휴무' : displacedStatus,
                        sort_order: nearest,
                        row: nRow, col: nCol, grid_position: nearest,
                        is_annual_leave: false
                    };
                    state.schedule.schedules.push(newSched);
                    unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
                }
            }
            // nearest == null (전 슬롯 점유) 이면 밀어낼 곳 없음 → 그대로 둠
        }

        // R2: 같은 날짜에 같은 직원의 기존 레코드 (다른 위치) → 업데이트 대상. 삭제하지 않고 아래 target 처리로 이어감.
        // 배치: 기존 스케줄 업데이트 또는 신규 생성
        let target = null;
        state.schedule.schedules.forEach(s => {
            if (s.date === dateStr && s.employee_id === empId) target = s;
        });
        if (target) {
            target.status = item.status || '근무';
            setSchedulePosFlat(target, assignPos);
            target.sort_order = assignPos;
            unsavedChanges.set(target.id, { type: 'update', data: target });
        } else {
            const assignRow = Math.floor(assignPos / GRID_COLS);
            const assignCol = assignPos % GRID_COLS;
            const newSched = {
                id: `place-${Date.now()}-${empId}-${Math.random()}`,
                date: dateStr,
                employee_id: empId,
                status: item.status || '근무',
                row: assignRow, col: assignCol,
                grid_position: assignPos,
                sort_order: assignPos,
                is_annual_leave: false,
                created_at: new Date().toISOString()
            };
            state.schedule.schedules.push(newSched);
            unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
        }

        placed++;
    });

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
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트)
    if (state.schedule?.isReadOnly) return 0;
    // 원칙 15단계: 공휴일 원본/타겟 날짜는 조작 비활성
    if (state.schedule.companyHolidays?.has(fromDate) || state.schedule.companyHolidays?.has(toDate)) {
        alert('공휴일/전원 휴무일은 이동 원본/대상이 될 수 없습니다.');
        return 0;
    }
    // 원본 날짜 상태 전환 (원칙 7단계: 뷰별 + 연차자 특수 처리)
    //   - 근무자: 근무 → 휴무
    //   - 일반 휴무자: 휴무 → 근무
    //   - 연차자(is_annual_leave=true): 원본 상태 & 연차 모두 유지 (건드리지 않음)
    //   - 타겟 날짜의 연차여부는 false 로 시작 (단 기존 타겟이 연차면 유지 — placeCards 에서 처리)
    empIds.forEach(empId => {
        let src = state.schedule.schedules.find(
            s => s.date === fromDate && s.employee_id === empId
        );
        if (src) {
            if (src.is_annual_leave) {
                // 연차자: 원본 그대로 둠. 타겟에만 새로 배치됨.
            } else if (src.status === '근무') {
                src.status = '휴무';
                unsavedChanges.set(src.id, { type: 'update', data: src });
            } else if (src.status === '휴무') {
                // 휴무자 → 근무 전환 (원본)
                src.status = '근무';
                unsavedChanges.set(src.id, { type: 'update', data: src });
            }
        } else {
            // 레코드 없는 직원 → 휴무 레코드 신규 생성 (근무자에서 이동 기본 가정)
            const cardEl = document.querySelector(`.calendar-day[data-date="${fromDate}"] .event-card[data-employee-id="${empId}"]`);
            const pos = cardEl ? parseInt(cardEl.dataset.position, 10) : 0;
            const newSched = {
                id: `move-${Date.now()}-${empId}`, date: fromDate, employee_id: empId,
                status: '휴무', sort_order: pos,
                row: Math.floor(pos / GRID_COLS), col: pos % GRID_COLS,
                grid_position: pos, is_annual_leave: false
            };
            state.schedule.schedules.push(newSched);
            unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
        }
    });

    // 대상 날짜에 배치 (타겟 상태는 근무, is_annual_leave=false 로 시작)
    const items = empIds.map(id => ({ employee_id: id, status: '근무' }));
    return placeCards(items, toDate, targetPos);
}

state.schedule.activeDepartmentFilters = new Set();
state.schedule.companyHolidays = new Set();
state.schedule.holidaySnapshots = new Map(); // dateStr -> Array<{employee_id,status,grid_position,is_annual_leave}> (원칙 15단계)
state.schedule.activeReorder = {
    date: null,
    sortable: null,
};

// ✨ 클릭과 드래그 구분을 위한 변수
let isDragging = false;
let dragStartTime = 0;

// ✨ 다중 선택 및 클립보드 상태
state.schedule.selectedSchedules = new Set(); // Set<"date_employeeId"> — 예: "2026-04-02_36"
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
    // Undo/Redo 버튼 활성화 상태 갱신
    if (typeof updateSaveButtonState === 'function') updateSaveButtonState();
}

function undoLastChange() {
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트)
    if (state.schedule?.isReadOnly) return;
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

    renderCalendar();
    updateSaveButtonState();
}

function redoLastChange() {
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트)
    if (state.schedule?.isReadOnly) return;
    if (redoStack.length === 0) {
        alert('다시 실행할 작업이 없습니다.');
        return;
    }
    const { name, snapshot } = redoStack.pop();

    // 현재 상태는 undo 쪽으로 옮겨두어 연속 Redo/Undo 가능하게
    const currentSnapshot = {
        schedules: JSON.parse(JSON.stringify(state.schedule.schedules)),
        unsavedChanges: new Map(unsavedChanges)
    };
    undoStack.push({ name, snapshot: currentSnapshot });
    if (undoStack.length > 50) undoStack.shift();

    // 복원
    state.schedule.schedules = snapshot.schedules;
    unsavedChanges = snapshot.unsavedChanges;

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


    // ✅ 2. State 업데이트 (근무/휴무 무관 — 모든 직원 위치 동기화)
    let changeCount = 0;

    state.schedule.schedules.forEach(schedule => {
        if (schedule.date === dateStr && schedule.employee_id > 0) {
            const newPos = newPositions.get(schedule.employee_id);
            if (newPos !== undefined) {
                if (schedule.grid_position !== newPos) {
                    setSchedulePosFlat(schedule, newPos);
                    schedule.sort_order = newPos;
                    unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                    changeCount++;
                }
            }
        }
    });

    if (changeCount > 0) {
        updateSaveButtonState();
    }
}

function getDepartmentColor(departmentId) {
    if (!departmentId) return '#cccccc';
    const colors = ['#4f46e5', '#db2777', '#16a34a', '#f97316', '#0891b2', '#6d28d9', '#ca8a04'];
    return colors[departmentId % colors.length];
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
        if (memberId < 0) return ''; // 원칙 11단계: 스페이서 완전 제거 — 레거시 데이터 무시
        const emp = allEmployees.find(e => e.id === memberId);
        return emp ? getEmployeeHtml(emp) : '';
    }).join('');
    return `<div class="team-group" data-team-id="${team.id}"><div class="team-header"><span class="handle">☰</span><input type="text" class="team-header-input" value="${team.name}">${deleteButton}</div><div class="team-member-list">${membersHtml}</div></div>`;
}

function updateSaveButtonState() {
    const saveBtn = _('#save-schedule-btn');
    const revertBtn = _('#revert-schedule-btn');
    const totalChanges = unsavedChanges.size + unsavedHolidayChanges.toAdd.size + unsavedHolidayChanges.toRemove.size;
    if (saveBtn && revertBtn) {
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
    // 이전/이후 버튼 활성화 동기화 (Undo/Redo 스택 기반)
    const undoBtn = _('#undo-schedule-btn');
    const redoBtn = _('#redo-schedule-btn');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
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

        // active 클래스 일원화 (style.css의 .schedule-view-btn.active 하이라이트 적용)
        updateViewModeButtons();

        renderCalendar();
    }
}

// ✨ 모든 날짜의 grid_position 업데이트 (빈칸 포함)
function updateAllGridPositions() {

    document.querySelectorAll('.calendar-day').forEach(dayEl => {
        const dateStr = dayEl.dataset.date;
        updateScheduleSortOrders(dateStr); // 재사용
    });

}

async function handleRevertChanges() {
    if (confirm("정말로 모든 변경사항을 되돌리시겠습니까?")) {
        await loadAndRenderScheduleData(state.schedule.currentDate);
    }
}

/**
 * 위치 초기화 — 해당 월 모든 날짜의 직원 (row, col) 위치를 배치 패널 디폴트로 리셋.
 * 상태(근무/휴무)와 연차여부는 건드리지 않음. (원칙 8단계)
 */
async function handlePositionReset() {
    if (!confirm('이번 달 전체 날짜의 직원 위치를 배치 패널 기본값으로 초기화하시겠습니까?\n\n(근무/휴무 상태와 연차 여부는 그대로 유지됩니다.)')) return;

    pushUndoState('위치 초기화');

    // getLayoutPositionMap() 존재 여부 확인 + 폴백
    const positionMap = (typeof getLayoutPositionMap === 'function')
        ? getLayoutPositionMap()
        : new Map();

    if (positionMap.size === 0) {
        alert('배치 그리드에 직원이 없습니다. 먼저 배치 패널에서 직원을 배치해주세요.');
        return;
    }

    const updateCount = applyLayoutToSchedules(positionMap, null); // null = 이번 달 전체
    renderCalendar();
    updateSaveButtonState();
    alert(`위치 초기화 완료 (${updateCount}건 반영). "스케줄 저장" 버튼을 눌러 DB에 반영하세요.`);
}

/**
 * 근무 초기화 — 해당 월 모든 스케줄 상태를 '근무'로. 위치·연차여부 유지. (원칙 8단계)
 */
async function handleWorkReset() {
    if (!confirm('이번 달 전체 스케줄의 상태를 모두 "근무"로 초기화하시겠습니까?\n\n(위치와 연차 여부는 그대로 유지됩니다.)')) return;

    pushUndoState('근무 초기화');

    const startOfMonth = dayjs(state.schedule.currentDate).startOf('month').format('YYYY-MM-DD');
    const endOfMonth = dayjs(state.schedule.currentDate).endOf('month').format('YYYY-MM-DD');

    let changed = 0;
    state.schedule.schedules.forEach(s => {
        if (s.date < startOfMonth || s.date > endOfMonth) return;
        if (s.employee_id <= 0) return;
        // 연차자는 상태 그대로 유지 (원칙: 연차여부 우선)
        if (s.is_annual_leave) return;
        if (s.status !== '근무') {
            s.status = '근무';
            unsavedChanges.set(s.id, { type: 'update', data: s });
            changed++;
        }
    });

    renderCalendar();
    updateSaveButtonState();
    alert(`근무 초기화 완료 (${changed}건 상태 변경). "스케줄 저장" 버튼을 눌러 DB에 반영하세요.`);
}

async function handleSaveSchedules() {
    const saveBtn = _('#save-schedule-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';


    try {
        // ✅ 1. 현재 화면의 배치(Grid Position)를 State에 반영
        updateAllGridPositions();

        const startOfMonth = dayjs(state.schedule.currentDate).startOf('month').format('YYYY-MM-DD');
        const endOfMonth = dayjs(state.schedule.currentDate).endOf('month').format('YYYY-MM-DD');


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
        //        단, grid_position < 0 (그리드 밖 휴무 카드)는 dedup 대상 제외 — 데이터 손실 방지
        const positionMap = new Map();
        const deduped = [];
        for (const s of schedulesToSave) {
            if (s.grid_position < 0) {
                deduped.push(s);
                continue;
            }
            const key = `${s.date}_${s.grid_position}`;
            if (positionMap.has(key)) {
                console.warn(`⚠️ 중복 위치 제거: ${key}`, positionMap.get(key).employee_id, '→', s.employee_id);
            }
            positionMap.set(key, s);
        }
        deduped.push(...positionMap.values());

        const schedulesToInsert = deduped;

        // ✅ 3. 기존 스케줄 백업 후 삭제 → 삽입 (실패 시 복원)
        const { data: backupData, error: backupError } = await db.from('schedules')
            .select('*')
            .gte('date', startOfMonth)
            .lte('date', endOfMonth);

        if (backupError) throw backupError;

        const { error: deleteError } = await db.from('schedules')
            .delete()
            .gte('date', startOfMonth)
            .lte('date', endOfMonth);

        if (deleteError) throw deleteError;

        // ✅ 4. 데이터 일괄 삽입 (실패 시 백업 복원)
        if (schedulesToInsert.length > 0) {
            const BATCH_SIZE = 50;
            try {
                for (let i = 0; i < schedulesToInsert.length; i += BATCH_SIZE) {
                    const batch = schedulesToInsert.slice(i, i + BATCH_SIZE).map(serializeScheduleForDb);
                    const { error: insertError } = await db.from('schedules').insert(batch);
                    if (insertError) throw insertError;
                }
            } catch (insertErr) {
                console.error('삽입 실패, 백업 데이터 복원 시도...', insertErr);
                if (backupData && backupData.length > 0) {
                    // backupData는 DB에서 바로 받은 것이므로 row_pos/col_pos 스키마. id/created_at만 제거.
                    const restoreRows = backupData.map(({ id, created_at, ...rest }) => rest);
                    for (let i = 0; i < restoreRows.length; i += BATCH_SIZE) {
                        await db.from('schedules').insert(restoreRows.slice(i, i + BATCH_SIZE));
                    }
                }
                throw insertErr;
            }
        }

        // ✅ 5. 회사 휴무일 저장
        try {
            const holidaysToAdd = Array.from(unsavedHolidayChanges.toAdd);
            const holidaysToRemove = Array.from(unsavedHolidayChanges.toRemove);

            if (holidaysToAdd.length > 0) {
                const { error: holidayAddError } = await db.from('company_holidays')
                    .upsert(holidaysToAdd.map(date => ({ date })), { onConflict: 'date' });
                if (holidayAddError) throw holidayAddError;
            }

            if (holidaysToRemove.length > 0) {
                const { error: holidayRemoveError } = await db.from('company_holidays')
                    .delete()
                    .in('date', holidaysToRemove);
                if (holidayRemoveError) throw holidayRemoveError;
            }
        } catch (holidayError) {
            console.error('❌ 휴무일 저장 실패:', holidayError);
            alert('⚠️ 주의: 직원 스케줄은 저장되었으나, 휴일 설정 저장에 실패했습니다.\n(' + (holidayError.message || holidayError) + ')');
            // 에러를 throw하지 않고 진행하여 화면 리로드(Step 6)가 실행되도록 함
        }


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

        // ✅ 직원 목록(.employee-list)에서만 가져오기 (원칙 11단계: 스페이서 제거, 실제 직원만)
        document.querySelectorAll('.employee-list .draggable-employee').forEach(memberEl => {
            const empId = parseInt(memberEl.dataset.employeeId, 10);
            if (!isNaN(empId) && empId > 0) {
                orderedEmployees.push({
                    type: 'employee',
                    employee_id: empId,
                    position: gridPosition++
                });
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


        // 6. 새 스케줄 삽입 (배치 처리)
        const BATCH_SIZE = 50;
        for (let i = 0; i < schedulesToInsert.length; i += BATCH_SIZE) {
            const batch = schedulesToInsert.slice(i, i + BATCH_SIZE).map(serializeScheduleForDb);
            const { error: insertError } = await db.from('schedules').insert(batch);

            if (insertError) {
                console.error(`❌ 배치 삽입 오류 (인덱스 ${i}):`, insertError);
                throw insertError;
            }
        }


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

function handleDeleteSpacer(e) {
    // 원칙 11단계: 스페이서 개념 제거됨. 구분선(separator)만 삭제 지원.
    if (e.target.matches('.delete-separator-btn')) {
        e.target.closest('[data-type]')?.remove();
    }
}

async function handleSaveEmployeeOrder(options = {}) {
    const saveBtn = _('#save-employee-order-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장중...';

    // ✅ 4×8 그리드에서 순서 수집 (달력과 동일한 event-card/event-slot 구조)
    //    빈자리도 위치 보존 — members.length === GRID_SIZE positional 포맷.
    //    빈자리 마커: 0 (실제 employee.id 는 양수이므로 충돌 없음).
    const employeeOrder = [];
    document.querySelectorAll('#layout-grid .event-card, #layout-grid .event-slot').forEach(slot => {
        const empId = slot.dataset.employeeId;
        if (empId === 'empty') {
            employeeOrder.push(0);
            return;
        }
        const id = parseInt(empId, 10);
        employeeOrder.push((!isNaN(id) && id > 0) ? id : 0);
    });


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

        const { error } = await db.from('monthly_layouts')
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

// 지정된 날짜들의 스케줄에 배치(grid_position) 적용
// options.applyRegularOff (default: false)
//   - true: 정기 휴무 자동 반영
//     · 기존 근무 + 정기 휴무 요일 → '휴무' 전환
//     · 신규 레코드 + 정기 휴무 요일 → '휴무' 로 생성
//     · 연차/기존 휴무 는 항상 보존
//   - false: 위치만 적용, 상태는 건드리지 않음 (기존 동작)
// 레코드 없는 직원 → 신규 레코드 생성 (배치 적용 시)
function applyLayoutToSchedules(positionMap, targetDates, options = {}) {
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트)
    if (state.schedule?.isReadOnly) return 0;
    const { applyRegularOff = false } = options;
    const dateSet = targetDates ? new Set(targetDates) : null;
    let updateCount = 0;

    const empById = new Map((state.management.employees || []).map(e => [e.id, e]));

    // 기존 레코드 업데이트
    state.schedule.schedules.forEach(s => {
        if (s.employee_id <= 0) return;
        if (dateSet && !dateSet.has(s.date)) return;
        if (!positionMap.has(s.employee_id)) return;

        let touched = false;
        const newPos = positionMap.get(s.employee_id);
        if (s.grid_position !== newPos) {
            setSchedulePosFlat(s, newPos);
            touched = true;
        }

        if (applyRegularOff) {
            // 정기 휴무 자동 반영 (연차·기존 휴무는 보존)
            const isLeave = s.is_annual_leave === true || s.status === '연차';
            if (!isLeave && s.status === '근무') {
                const emp = empById.get(s.employee_id);
                if (emp) {
                    const dow = dayjs(s.date).day();
                    if (isFixedOffDay(emp.regular_holiday_rules, dow, s.date)) {
                        s.status = '휴무';
                        touched = true;
                    }
                }
            }
        }

        if (touched) {
            unsavedChanges.set(s.id, { type: 'update', data: s });
            updateCount++;
        }
    });

    // 레코드 없는 직원 → 신규 레코드 생성
    if (dateSet) {
        const activeEmps = (state.management.employees || []).filter(
            e => isGridEmployee(e)
        );
        dateSet.forEach(dateStr => {
            const existingEmpIds = new Set(
                state.schedule.schedules.filter(s => s.date === dateStr && s.employee_id > 0).map(s => s.employee_id)
            );
            const dow = dayjs(dateStr).day();
            activeEmps.forEach(emp => {
                if (existingEmpIds.has(emp.id) || !positionMap.has(emp.id)) return;
                const newPos = positionMap.get(emp.id);
                const isOff = applyRegularOff && isFixedOffDay(emp.regular_holiday_rules, dow, dateStr);
                const newSched = {
                    id: `layout-${Date.now()}-${emp.id}-${dateStr}`,
                    date: dateStr,
                    employee_id: emp.id,
                    status: isOff ? '휴무' : '근무',
                    grid_position: newPos,
                    sort_order: newPos,
                    created_at: new Date().toISOString()
                };
                state.schedule.schedules.push(newSched);
                unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
                updateCount++;
            });
        });
    }

    return updateCount;
}

async function handleApplyLayoutToAll() {
    const btn = _('#apply-layout-btn');
    if (!confirm('현재 배치를 이번 달 모든 날짜에 적용하시겠습니까?\n\n• 위치(grid_position) 일괄 적용\n• 정기 휴무 요일은 자동으로 휴무 전환\n• 기존 연차·휴무는 그대로 유지')) return;

    btn.disabled = true;
    btn.textContent = '적용중...';

    try {
        pushUndoState('배치 전체 적용');
        await handleSaveEmployeeOrder({ skipReload: true });

        const positionMap = getLayoutPositionMap();
        const updateCount = applyLayoutToSchedules(positionMap, null, { applyRegularOff: true }); // null = 전체 날짜

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
    const updateCount = applyLayoutToSchedules(positionMap, [dateStr], { applyRegularOff: true });

    if (updateCount === 0) {
        alert(`${dateStr}: 변경할 배치가 없습니다.`);
        return;
    }

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

    if (oldIndex === newIndex) return;

    // ✨ [Group Move Check]
    // 이동하려는 대상이 "선택된 그룹"에 포함되어 있고, 선택된 항목이 2개 이상인 경우 그룹 이동 처리
    if (state.schedule.selectedSchedules.has(`${dateStr}_${movedEmployeeId}`) && state.schedule.selectedSchedules.size > 1) {
        handleGroupSameDateMove(dateStr, movedEmployeeId, oldIndex, newIndex);
        return;
    }


    // 1. 현재 32칸 상태 구성 (레코드 유무 무관, 전체 직원 포함)
    const currentGrid = new Array(GRID_SIZE).fill(null);
    const basePositions = getEmployeeBasePositions();
    const activeEmps = (state.management.employees || []).filter(
        e => isGridEmployee(e)
    );
    const dateScheds = new Map();
    state.schedule.schedules.forEach(s => {
        if (s.date === dateStr && s.employee_id > 0) {
            const prev = dateScheds.get(s.employee_id);
            if (!prev || s.status === '근무') dateScheds.set(s.employee_id, s);
        }
    });
    activeEmps.forEach(emp => {
        const sched = dateScheds.get(emp.id);
        const pos = (sched && sched.grid_position != null && sched.grid_position >= 0 && sched.grid_position < GRID_SIZE)
            ? sched.grid_position
            : basePositions.get(emp.id);
        if (pos != null && pos >= 0 && pos < GRID_SIZE && !currentGrid[pos]) {
            currentGrid[pos] = emp.id;
        }
    });


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
                setSchedulePosFlat(schedule, position);
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

// ═══ 달력 드래그 — sort:false 방식 공용 상태/헬퍼 ═══
// SortableJS 가 드래그 중 DOM 을 재배치(reshuffle)하지 못하게 sort:false 로 두고,
// 실제 배치는 '놓는 지점 좌표'로 직접 계산한다. (재배치 없음 → 주변 카드 안 움직임)
let calendarDragPointer = { x: 0, y: 0 };   // 드래그 중 마지막 포인터 좌표
let calendarMoveHandled = false;            // onUpdate/onAdd 가 처리했으면 true (onEnd 중복 방지)

function onCalendarDragMove(e) {
    const p = (e.touches && e.touches[0]) ? e.touches[0]
            : (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    if (p && typeof p.clientX === 'number') {
        calendarDragPointer.x = p.clientX;
        calendarDragPointer.y = p.clientY;
    }
}

// 좌표 추적 전역 1회 등록 — 풀(사이드바)에서 시작한 드래그도 포착해야 하므로
// 특정 Sortable 의 onStart 가 아니라 document 에 상시 등록한다. (HTML5 DnD 는 dragover,
// 폴백/터치는 pointermove/touchmove 로 좌표 갱신)
let _calDragTrackerRegistered = false;
function ensureCalendarDragTracker() {
    if (_calDragTrackerRegistered) return;
    _calDragTrackerRegistered = true;
    document.addEventListener('dragover', onCalendarDragMove, true);
    document.addEventListener('pointermove', onCalendarDragMove, true);
    document.addEventListener('touchmove', onCalendarDragMove, true);
}

// 좌표 아래의 슬롯 data-position 반환 (해당 날짜 슬롯만). 못 찾으면 null.
function slotPosAtPointer(dateStr) {
    const elAt = document.elementFromPoint(calendarDragPointer.x, calendarDragPointer.y);
    const slot = (elAt && elAt.closest) ? elAt.closest('.event-card, .event-slot') : null;
    if (!slot) return null;
    const slotDay = slot.closest('.calendar-day')?.dataset.date;
    if (slotDay !== dateStr) return null;
    if (slot.dataset.position == null || slot.dataset.position === '') return null;
    const p = parseInt(slot.dataset.position, 10);
    return Number.isFinite(p) ? p : null;
}

// 같은 날짜 내 그룹 이동 (선택 선행 + row/col 델타 + OOB 전체취소). onUpdate/onEnd 공용.
function applyIntraGridMove(dateStr, draggedEmpId, fromPos, targetPos) {
    if (draggedEmpId == null || isNaN(draggedEmpId) || isNaN(fromPos) || targetPos == null || targetPos < 0) {
        renderCalendar(); return;
    }
    const draggedKey = `${dateStr}_${draggedEmpId}`;
    if (state.schedule.selectedSchedules.size === 0) { renderCalendar(); return; }
    if (!state.schedule.selectedSchedules.has(draggedKey)) { clearSelection(); renderCalendar(); return; }
    if (targetPos === fromPos) { renderCalendar(); return; }

    const rowDelta = Math.floor(targetPos / GRID_COLS) - Math.floor(fromPos / GRID_COLS);
    const colDelta = (targetPos % GRID_COLS) - (fromPos % GRID_COLS);
    const items = [];
    let outOfBounds = false;
    state.schedule.selectedSchedules.forEach(selKey => {
        const [selDate, eidStr] = selKey.split('_');
        const eid = parseInt(eidStr, 10);
        if (selDate !== dateStr || isNaN(eid)) return;
        const selCard = document.querySelector(`.calendar-day[data-date="${dateStr}"] .event-card[data-employee-id="${eid}"]`);
        const origPos = selCard ? parseInt(selCard.dataset.position, 10) : null;
        if (origPos == null || isNaN(origPos)) return;
        const origRow = Math.floor(origPos / GRID_COLS), origCol = origPos % GRID_COLS;
        const newRow = origRow + rowDelta, newCol = origCol + colDelta;
        if (newCol < 0 || newCol >= GRID_COLS || newRow < 0) { outOfBounds = true; return; }
        const newPos = newRow * GRID_COLS + newCol;
        if (newPos < 0 || newPos >= GRID_SIZE) { outOfBounds = true; return; }
        items.push({ employee_id: eid, _targetPos: newPos, _origPos: origPos });
    });
    if (outOfBounds || items.length === 0) { renderCalendar(); return; }

    pushUndoState('Drag Reorder');
    placeCards(items, dateStr, null);
    clearSelection();
    renderCalendar();
    updateSaveButtonState();
}

function initializeDayDragDrop(dayEl, dateStr) {
    ensureCalendarDragTracker(); // 좌표 추적 1회 등록
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
            put: ['calendar-group', 'layout-pool'] // ✅ 달력 간 이동 + 배치 패널에서 드롭
        },
        // 🆕 달력 카드(.event-card)·빈슬롯(.event-slot)은 SortableJS가 잡지 않음 — 커스텀 포인터 DnD(onCalendarCardPointerDown)가 처리.
        //    이 Sortable 은 사이드바/배치패널(.draggable-employee/.layout-pool-card) → 달력 드롭(onAdd) 수신 전용으로만 남김.
        draggable: '.draggable-employee, .list-spacer, .layout-pool-card',
        animation: 0, // 드래그 중 슬라이드(주변 카드 출렁임) 제거 — 위치 기반 그리드
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
        emptyInsertThreshold: 0, // 빈 공간 삽입(주변 카드 밀림) 비활성
        sort: false, // 🔑 드래그 중 DOM 재배치 금지 — 주변 카드가 출렁이지 않음.
        //    배치는 onAdd/onEnd 에서 '놓는 지점 좌표'로 직접 계산 (placeCards 단일 경로).
        // swap 미사용: 달력은 placeCards 로 위치를 직접 계산하므로 불필요(점유자 삭제 버그 유발).

        onStart(evt) {
            isDragging = true;
            dragStartTime = Date.now();
            document.body.style.userSelect = 'none';

            // 좌표 추적은 전역 1회 등록(ensureCalendarDragTracker). 여기선 플래그만 리셋.
            calendarMoveHandled = false;

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


            document.querySelectorAll('.day-events').forEach(el => {
                el.style.minHeight = '100px';
                el.style.backgroundColor = 'rgba(59, 130, 246, 0.05)';
                el.style.border = '2px dashed rgba(59, 130, 246, 0.3)';
            });
        },

        onEnd(evt) {
            setTimeout(() => { isDragging = false; }, 100);
            document.body.style.userSelect = '';
            document.querySelectorAll('.day-events').forEach(el => {
                el.style.minHeight = ''; el.style.backgroundColor = ''; el.style.border = '';
            });

            // 같은 날짜 내 이동: sort:false 라 onUpdate 가 안 불리므로 여기서 좌표로 처리.
            // (pool 드롭/다른날짜 이동은 onAdd 가 calendarMoveHandled=true 로 잡음 → 건너뜀)
            if (!calendarMoveHandled) {
                const draggedEl = evt.item;
                if (draggedEl && draggedEl.classList.contains('event-card')) {
                    const empIdStr = draggedEl.dataset.employeeId;
                    const draggedEmpId = (empIdStr === 'empty' || empIdStr === 'spacer') ? null : parseInt(empIdStr, 10);
                    const fromPos = parseInt(draggedEl.dataset.position, 10);
                    const targetPos = slotPosAtPointer(dateStr); // 놓은 지점의 슬롯 (같은 날짜만)
                    if (targetPos != null) {
                        applyIntraGridMove(dateStr, draggedEmpId, fromPos, targetPos);
                    }
                    // targetPos null → 그리드 밖/다른 날짜에 놓음. sort:false 라 DOM 그대로 → 변화 없음.
                }
            }

            dragSourceInfo = null;
            calendarMoveHandled = false;
        },

        onUpdate(evt) {
            // sort:false 면 보통 안 불리지만, 혹시 불리면 여기서 처리 (onEnd 중복 방지 플래그).
            calendarMoveHandled = true;
            const draggedEl = evt.item;
            const empIdStr = draggedEl.dataset.employeeId;
            const draggedEmpId = (empIdStr === 'empty' || empIdStr === 'spacer') ? null : parseInt(empIdStr, 10);
            const fromPos = parseInt(draggedEl.dataset.position, 10);
            // 좌표 우선(정확), 실패 시 DOM 인덱스
            let targetPos = slotPosAtPointer(dateStr);
            if (targetPos == null) {
                const allSlots = Array.from(evt.to.querySelectorAll('.event-card, .event-slot'));
                const idx = allSlots.indexOf(draggedEl);
                targetPos = idx >= 0 ? idx : null;
            }
            applyIntraGridMove(dateStr, draggedEmpId, fromPos, targetPos);
        },

        onAdd(evt) {
            calendarMoveHandled = true; // onEnd 중복 처리 방지
            const employeeEl = evt.item;

            // ✅ event-card인 경우는 다른 날짜에서 온 것 → moveCards() 사용
            if (employeeEl.classList.contains('event-card')) {
                const draggedEmpId = parseInt(employeeEl.dataset.employeeId, 10);
                const fromDate = dragSourceInfo?.fromDate;
                // 타겟 = 놓은 지점 좌표의 슬롯 (sort:false 라 정확). 실패 시 newIndex.
                let targetPos = slotPosAtPointer(dateStr);
                if (targetPos == null) targetPos = evt.newIndex;

                if (fromDate && fromDate !== dateStr && !isNaN(draggedEmpId)) {
                    // 🔒 규칙: 선택 선행 필수 (cross-date 드래그도 동일)
                    const draggedKey = `${fromDate}_${draggedEmpId}`;
                    if (state.schedule.selectedSchedules.size === 0) {
                        employeeEl.remove();
                        renderCalendar();
                        return;
                    }
                    if (!state.schedule.selectedSchedules.has(draggedKey)) {
                        clearSelection();
                        employeeEl.remove();
                        renderCalendar();
                        return;
                    }

                    pushUndoState('Drag Move');

                    // 선택된 모든 카드를 함께 이동 (같은 fromDate만)
                    const empIdsToMove = [];
                    state.schedule.selectedSchedules.forEach(selKey => {
                        const [selDate, eidStr] = selKey.split('_');
                        const eid = parseInt(eidStr, 10);
                        if (selDate === fromDate && !isNaN(eid)) {
                            empIdsToMove.push(eid);
                        }
                    });

                    moveCards(empIdsToMove, fromDate, dateStr, targetPos);
                    clearSelection();
                }

                // DOM 원복 후 재렌더링 (Sortable이 DOM을 직접 이동시키므로)
                employeeEl.remove();
                renderCalendar();
                updateSaveButtonState();
                return;
            }

            // ✅ 사이드바/배치패널에서 드롭 — placeCards 통합 함수 사용
            const empId = parseInt(employeeEl.dataset.employeeId, 10);
            if (isNaN(empId)) { employeeEl.remove(); return; }

            employeeEl.remove(); // 클론 제거 후 좌표 아래 실제 슬롯 탐색
            // 🎯 타겟 = 놓은 지점 좌표의 슬롯 data-position (전역 추적된 마지막 포인터).
            //    sort:false 라 슬롯이 재배치되지 않아 좌표가 정확. 판정 실패 시 null→첫 빈자리.
            const targetPos = slotPosAtPointer(dateStr);

            pushUndoState('Drop from sidebar');
            placeCards([{ employee_id: empId }], dateStr, (targetPos != null) ? targetPos : null);

            renderCalendar();
            updateSaveButtonState();
        },
    });
}

// =========================================================================================
// 🆕 달력 카드 커스텀 포인터 DnD (방식 B) — SortableJS 라이브 재배치 제거
//   요구사항: ① 드래그 중 주변 카드 이동 없음(라이브 재배치 안 함)
//            ② 같은 슬롯에 0.6초 이상 체류해야 그 슬롯이 '확정 타겟'으로 잠김 (지나가는 동안 무반응)
//            ③ 드롭은 placeCards/moveCards 좌표 경로 (타겟 점유자 1명만 가장 가까운 빈자리로, 주변 불변)
//            ④ 날짜간 이동 지원 (잠긴 슬롯의 날짜가 다르면 moveCards)
//   🆕 카드 위 제스처 분기 (시간 기반, 사용자 요구):
//      - 누르고 0.6초↑ 홀드(거의 안 움직임) 후 끌기 = 카드 이동 (롱프레스 픽업)
//      - 누르고 0.6초 전에 바로 끌기 = 영역선택 (카드 DnD 취소 → 마퀴가 가져감)
//      → 마퀴 선택은 카드/빈칸 모두에서 가능. 이동이냐 영역선택이냐는 '홀드 시간'으로 구분.
// =========================================================================================
const CAL_PICKUP_HOLD_MS = 600; // 이 시간 이상 홀드해야 카드 이동 픽업 (미만 이동은 영역선택)
const CAL_HOLD_MOVE_TOL = 8;    // 홀드 중 이만큼 넘게 움직이면 = 빠른 드래그 → 영역선택으로 양보
const CAL_DWELL_MS = 600;       // 타겟 슬롯 확정(자리 확인 테두리)까지 체류 시간
let calDrag = null;

function onCalendarCardPointerDown(e) {
    if (e.button != null && e.button !== 0) return;        // 좌클릭만
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;      // 선택 보조키 → 클릭 처리에 양보
    if (state.schedule?.isReadOnly) return;                // 원칙 16단계 게이트(안전망)
    const card = e.target.closest('.event-card');
    if (!card) return;                                     // 빈칸/슬롯 → 마퀴·클릭이 처리
    const dateStr = card.closest('.calendar-day')?.dataset.date;
    const empIdStr = card.dataset.employeeId;
    if (!dateStr || !empIdStr || empIdStr === 'empty' || empIdStr === 'spacer') return;
    const empId = parseInt(empIdStr, 10);
    if (isNaN(empId)) return;
    if (state.schedule.companyHolidays?.has(dateStr)) return; // 원칙 15단계 공휴일
    // 🆕 'holding' 으로 시작 → 0.6초 홀드 유지 시 카드 이동 픽업. 그 전에 움직이면 영역선택으로 양보.

    calDrag = {
        phase: 'holding', card, dateStr, empId,
        startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
        hoverDate: null, hoverPos: null, lockedDate: null, lockedPos: null,
        ghost: null, dwellTimer: null, holdTimer: null
    };
    calDrag.holdTimer = setTimeout(() => {
        if (calDrag && calDrag.phase === 'holding') calBeginPickup();
    }, CAL_PICKUP_HOLD_MS);
    document.addEventListener('pointermove', onCalendarCardPointerMove, true);
    document.addEventListener('pointerup', onCalendarCardPointerUp, true);
    document.addEventListener('pointercancel', onCalendarCardPointerUp, true);
}

function calBeginPickup() {
    if (!calDrag) return;
    // 드래그하는 카드가 현재 선택에 없으면 → 그 카드만 단일 선택 (클릭 없이 바로 잡아끌기).
    // 이미 선택(단수/복수)에 포함돼 있으면 그 선택 전체를 함께 끈다.
    const key = `${calDrag.dateStr}_${calDrag.empId}`;
    if (!state.schedule.selectedSchedules.has(key)) {
        clearSelection();
        state.schedule.selectedSchedules.add(key);
        calDrag.card.classList.add('selected');
    }
    calDrag.phase = 'dragging';
    isDragging = true;
    document.body.style.userSelect = 'none';
    const count = [...state.schedule.selectedSchedules].filter(k => k.startsWith(calDrag.dateStr + '_')).length;
    const g = calDrag.card.cloneNode(true);
    g.classList.add('cal-drag-ghost');
    g.classList.remove('selected');
    g.style.width = calDrag.card.offsetWidth + 'px';
    if (count > 1) {
        const badge = document.createElement('span');
        badge.className = 'cal-drag-ghost-badge';
        badge.textContent = String(count);
        g.appendChild(badge);
    }
    document.body.appendChild(g);
    calDrag.ghost = g;
    calPositionGhost(calDrag.lastX, calDrag.lastY);
}

function calPositionGhost(x, y) {
    if (!calDrag || !calDrag.ghost) return;
    calDrag.ghost.style.left = (x + 12) + 'px';
    calDrag.ghost.style.top = (y + 12) + 'px';
}

function onCalendarCardPointerMove(e) {
    if (!calDrag) return;
    calDrag.lastX = e.clientX; calDrag.lastY = e.clientY;
    if (calDrag.phase === 'holding') {
        // 0.6초 홀드 완료 전에 움직이면 → 빠른 드래그 = 영역선택 제스처. 카드 DnD 취소(마퀴가 가져감).
        const dx = e.clientX - calDrag.startX, dy = e.clientY - calDrag.startY;
        if (Math.abs(dx) > CAL_HOLD_MOVE_TOL || Math.abs(dy) > CAL_HOLD_MOVE_TOL) {
            calCleanup();   // holdTimer 취소 + 리스너 해제 → handleDragSelectStart 가 armed 한 마퀴가 활성화
        }
        return;             // 픽업 전에는 ghost/dwell 없음
    }
    // phase === 'dragging'
    e.preventDefault();
    calPositionGhost(e.clientX, e.clientY);
    calUpdateDwell(e.clientX, e.clientY);
}

function calSlotAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);            // ghost 는 pointer-events:none 이라 아래 슬롯이 잡힘
    const slot = (el && el.closest) ? el.closest('.event-card, .event-slot') : null;
    if (!slot) return null;
    const date = slot.closest('.calendar-day')?.dataset.date;
    const posStr = slot.dataset.position;
    if (!date || posStr == null || posStr === '') return null;
    const pos = parseInt(posStr, 10);
    return Number.isFinite(pos) ? { date, pos } : null;
}

function calClearHighlight() {
    document.querySelectorAll('.cal-drop-locked').forEach(el => el.classList.remove('cal-drop-locked'));
}

function calUpdateDwell(x, y) {
    const hit = calSlotAtPoint(x, y);
    if (hit && calDrag.hoverDate === hit.date && calDrag.hoverPos === hit.pos) return; // 같은 슬롯 계속 체류 → 타이머 유지
    // 슬롯 변경(=지나감) → dwell 리셋 + 락 해제 (요구사항①②: 지나가는 동안 아무 반응 없음)
    clearTimeout(calDrag.dwellTimer);
    calClearHighlight();
    calDrag.lockedDate = null; calDrag.lockedPos = null;
    calDrag.hoverDate = hit ? hit.date : null;
    calDrag.hoverPos = hit ? hit.pos : null;
    if (hit) {
        calDrag.dwellTimer = setTimeout(() => {
            if (!calDrag) return;
            calDrag.lockedDate = hit.date; calDrag.lockedPos = hit.pos;
            const slotEl = document.querySelector(`.calendar-day[data-date="${hit.date}"] [data-position="${hit.pos}"]`);
            if (slotEl) slotEl.classList.add('cal-drop-locked');
        }, CAL_DWELL_MS);
    }
}

function onCalendarCardPointerUp() {
    if (!calDrag) { calCleanupListeners(); return; }
    const wasDragging = calDrag.phase === 'dragging';
    const lockedDate = calDrag.lockedDate, lockedPos = calDrag.lockedPos;
    const fromDate = calDrag.dateStr, empId = calDrag.empId, card = calDrag.card;
    calCleanup();
    if (!wasDragging) return;                       // 단순 클릭 → handleCalendarClick 가 선택 처리
    dragSelectJustFinished = true;                  // 드래그 직후 click 무시
    setTimeout(() => { dragSelectJustFinished = false; }, 80);
    isDragging = true;
    setTimeout(() => { isDragging = false; }, 100);
    if (lockedDate == null || lockedPos == null) return; // 0.6초 미체류(미확정) → 아무 동작 안 함
    calCommitDrop(card, fromDate, empId, lockedDate, lockedPos);
}

function calCommitDrop(card, fromDate, empId, toDate, toPos) {
    if (toDate === fromDate) {
        const fromPos = parseInt(card.dataset.position, 10);
        applyIntraGridMove(fromDate, empId, fromPos, toPos);   // (row,col) 델타·OOB·선택검사 내장
        return;
    }
    // 날짜간 이동 (기존 onAdd 로직 미러 — 선택된 같은-원본날짜 카드 일괄 이동)
    if (state.schedule.selectedSchedules.size === 0) { renderCalendar(); return; }
    if (!state.schedule.selectedSchedules.has(`${fromDate}_${empId}`)) { clearSelection(); renderCalendar(); return; }
    pushUndoState('Drag Move');
    const empIdsToMove = [];
    state.schedule.selectedSchedules.forEach(selKey => {
        const [selDate, eidStr] = selKey.split('_');
        const eid = parseInt(eidStr, 10);
        if (selDate === fromDate && !isNaN(eid)) empIdsToMove.push(eid);
    });
    moveCards(empIdsToMove, fromDate, toDate, toPos);
    clearSelection();
    renderCalendar();
    updateSaveButtonState();
}

function calCleanupListeners() {
    document.removeEventListener('pointermove', onCalendarCardPointerMove, true);
    document.removeEventListener('pointerup', onCalendarCardPointerUp, true);
    document.removeEventListener('pointercancel', onCalendarCardPointerUp, true);
}

function calCleanup() {
    if (calDrag) {
        clearTimeout(calDrag.dwellTimer);
        clearTimeout(calDrag.holdTimer);
        if (calDrag.ghost && calDrag.ghost.parentNode) calDrag.ghost.parentNode.removeChild(calDrag.ghost);
    }
    calClearHighlight();
    document.body.style.userSelect = '';
    calDrag = null;
    calCleanupListeners();
}

// =========================================================================================
// AppSheet 관련 로직 (원칙 13단계: handleAutoSchedule 완전 제거됨)
// =========================================================================================

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
    const basePositions = getEmployeeBasePositions();
    const excludedIds = getExcludedEmployeeIds();

    // ✅ 모든 활성 직원 중 근무 상태인 직원 반환 (레코드 유무 무관)
    const activeEmps = (state.management.employees || []).filter(
        e => isGridEmployee(e) && !excludedIds.has(e.id)
    );
    activeEmps.forEach(emp => {
        const status = getEmployeeStatusOnDate(emp.id, dateStr);
        if (status === 'working') workingEmps.push(emp);
    });

    // ✅ grid_position 기준 정렬 (레코드 있으면 레코드 위치, 없으면 배치 패널 위치)
    const dateScheds = new Map();
    state.schedule.schedules.forEach(s => {
        if (s.date === dateStr && s.employee_id > 0) dateScheds.set(s.employee_id, s);
    });
    workingEmps.sort((a, b) => {
        const scheduleA = dateScheds.get(a.id);
        const scheduleB = dateScheds.get(b.id);

        const posA = scheduleA?.grid_position ?? basePositions.get(a.id);
        const posB = scheduleB?.grid_position ?? basePositions.get(b.id);

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
                // 스케줄 관리에서 격리 대상 (test/휴직/퇴사/alba/hidden) 은 cell 에도 표시 안 함
                if (!isVisibleIn('schedule_grid', emp)) return;
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
                // 스케줄 관리 격리 대상 (alba/test/휴직/퇴사/hidden) 은 cell 에 표시 안 함
                if (!isVisibleIn('schedule_grid', emp)) return;
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

// ✅ 직원 기본 그리드 위치 — 배치 패널(teamLayout) 순서가 곧 기본 위치
// 레코드 유무와 무관. 배치 패널의 members 배열 인덱스 = grid_position.
function getEmployeeBasePositions() {
    const posMap = new Map();
    const layout = state.schedule.teamLayout?.data?.[0]?.members;
    const empList = state.management.employees || [];
    const visibleIds = new Set(empList.filter(e => isGridEmployee(e)).map(e => e.id));

    if (layout) {
        layout.forEach((id, idx) => {
            // 저장된 배치에 있어도 schedule_visible=false / 퇴사 / 임시 인 직원은 건너뜀
            if (id > 0 && visibleIds.has(id)) posMap.set(id, idx);
        });
    }

    // layout에 없는 활성 직원 → 빈 자리에 순차 배정
    const usedPositions = new Set(posMap.values());
    const activeIds = (state.management.employees || [])
        .filter(e => isGridEmployee(e))
        .map(e => e.id);
    activeIds.forEach(id => {
        if (!posMap.has(id)) {
            let pos = 0;
            while (usedPositions.has(pos)) pos++;
            posMap.set(id, pos);
            usedPositions.add(pos);
        }
    });

    return posMap;
}

/**
 * 특정 날짜의 '효과적 점유' 맵 — 통합 보기 기준.
 * "빈자리"는 schedules 레코드 유무가 아니라, 실제로 그 칸에 아무도 없을 때만이다.
 * (레코드 없이 기본배치로만 표시되는 달에서도 점유자를 정확히 인식 → 엉뚱한 밀림 방지)
 * renderCalendar 의 getEmpPosition 과 동일 규칙: 레코드 grid_position 우선, 없으면 basePosition.
 * @returns {Map<number, {employee_id:number, record:Object|null}>} pos -> 점유 정보
 */
function getEffectiveOccupancy(dateStr) {
    const occ = new Map();
    const basePositions = getEmployeeBasePositions();
    const excludedIds = getExcludedEmployeeIds(); // 렌더와 동일 기준 — 레이아웃 미등록 직원
    const recMap = new Map();
    state.schedule.schedules.forEach(s => {
        if (s.date !== dateStr || s.employee_id <= 0) return;
        const prev = recMap.get(s.employee_id);
        if (!prev || s.status === '근무') recMap.set(s.employee_id, s);
    });
    (state.management.employees || []).forEach(emp => {
        if (!isGridEmployee(emp)) return;
        if (emp.resignation_date && dateStr >= emp.resignation_date) return;
        const rec = recMap.get(emp.id);
        // renderCalendar 와 동일: 레이아웃 미등록(excluded) + 레코드 없음 → 화면에 안 나오므로
        // 점유로 치지 않는다. (자동 임시배정 자리를 '유령 점유'로 잡아 엉뚱하게 미는 버그 방지)
        if (excludedIds.has(emp.id) && !rec) return;
        let pos = null;
        if (rec && rec.grid_position != null) {
            if (rec.grid_position >= 0 && rec.grid_position < GRID_SIZE) pos = rec.grid_position;
            // grid_position < 0 (명시적 off-grid) → 점유 안 함
        } else {
            const bp = basePositions.get(emp.id);
            if (bp != null && bp >= 0 && bp < GRID_SIZE) pos = bp;
        }
        if (pos == null) return;
        if (!occ.has(pos)) occ.set(pos, { employee_id: emp.id, record: rec || null });
    });
    return occ;
}

// ✅ 특정 날짜에 직원의 상태 판별
function getEmployeeStatusOnDate(empId, dateStr) {
    // 1. 회사 휴일이면 전원 휴무 (레코드 무관)
    if (state.schedule.companyHolidays && state.schedule.companyHolidays.has(dateStr)) {
        return 'off';
    }

    // 2. 승인된 연차 (확정 휴무, 수정 불가)
    const leaveReqs = state.management.leaveRequests || [];
    const hasLeave = leaveReqs.some(req =>
        req.employee_id === empId &&
        (req.status === 'approved' || req.final_manager_status === 'approved') &&
        req.dates?.includes(dateStr)
    );
    if (hasLeave) return 'leave';

    // 3. DB 스케줄 레코드 (변경 이력이 있는 경우 — 관리자 수동 오버라이드 포함)
    let sched = null;
    state.schedule.schedules.forEach(s => {
        if (s.employee_id === empId && s.date === dateStr) {
            if (!sched || s.status === '근무') sched = s;
        }
    });
    if (sched) return sched.status === '휴무' ? 'off' : 'working';

    // 4. 레코드 없음 → 직원의 정기 휴무 요일이면 'off'
    const emp = (state.management.employees || []).find(e => e.id === empId);
    if (emp) {
        const dow = dayjs(dateStr).day();
        if (isFixedOffDay(emp.regular_holiday_rules, dow, dateStr)) return 'off';
    }

    // 5. 그 외 → 기본 근무
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

    // 원칙 16단계: 직원 포털 읽기 전용 — DOM 레벨 1차 게이트.
    // 마우스/터치/드래그/포커스/탭/키보드 입력이 그리드로 전혀 도달하지 못하게 함.
    // 새 입력 경로(단축키·메뉴·라이브러리)가 추가돼도 자동 차단됨.
    if (state.schedule.isReadOnly) {
        container.setAttribute('inert', '');
    } else {
        container.removeAttribute('inert');
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
        e => isGridEmployee(e)
        // resignation_date는 루프 안에서 날짜별로 체크 (월 중 퇴사 가능)
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

        // ✅ 해당 날짜 스케줄 빠른 조회용 맵 (근무 레코드 우선)
        const dateSchedMap = new Map();
        state.schedule.schedules.forEach(s => {
            if (s.date === dateStr) {
                const prev = dateSchedMap.get(s.employee_id);
                if (!prev || s.status === '근무') dateSchedMap.set(s.employee_id, s);
            }
        });

        // ✅ 위치 결정: schedule.grid_position 우선, 없으면 basePositions fallback
        //    단, grid_position이 명시적으로 음수면 "off-grid"(빈자리로 처리된 카드) → 렌더링 제외
        function getEmpPosition(empId) {
            const sched = dateSchedMap.get(empId);
            if (sched) {
                if (sched.grid_position != null && sched.grid_position >= 0 && sched.grid_position < GRID_SIZE) {
                    return sched.grid_position;
                }
                // 명시적 off-grid (예: 드래그드롭/붙여넣기로 밀려난 카드) → null 반환, basePositions fallback 금지
                if (sched.grid_position != null && sched.grid_position < 0) {
                    return null;
                }
            }
            return basePositions.get(empId);
        }

        // ═══════════════════════════════════════════
        // 배치: 항상 전체 직원 기준으로 gridSlots 구성 (뷰 모드 무관)
        // 뷰 모드는 렌더링 시 표시/숨김만 결정
        // ═══════════════════════════════════════════
        activeEmps.forEach(emp => {
            // 레이아웃(monthly_layouts)에 없어도, 그 날짜에 명시적 스케줄 레코드가 있으면 렌더한다.
            // (복직·수동 배치한 직원을 날짜칸에 드롭하면 레코드는 생기지만 렌더에서 빠져
            //  "이름이 사라지는" 버그 방지. 레이아웃 미등록 + 레코드 없음일 때만 제외.)
            if (excludedIds.has(emp.id) && !dateSchedMap.has(emp.id)) return;
            if (filteredEmployeeIds.size > 0 && !filteredEmployeeIds.has(emp.id)) return;
            // 퇴사일 이후는 미표시
            if (emp.resignation_date && dateStr >= emp.resignation_date) return;

            let pos = getEmpPosition(emp.id);
            if (pos == null || pos < 0 || pos >= GRID_SIZE) return;

            // 충돌 시 가장 가까운 빈 자리로 (좌상단 첫 빈칸으로 점프하면 무관한 카드가 멀리 튀어 보임)
            if (gridSlots[pos] && gridSlots[pos].employee_id !== emp.id) {
                const occupiedNow = new Set();
                gridSlots.forEach((s, i) => { if (s) occupiedNow.add(i); });
                const nearest = findNearestEmptyPos(pos, occupiedNow);
                if (nearest != null) {
                    pos = nearest;
                } else {
                    for (let i = 0; i < GRID_SIZE; i++) { if (!gridSlots[i]) { pos = i; break; } }
                }
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

        // 임시직원(알바)·테스트직원도 isGridEmployee 통과 시 위 activeEmps 루프에서 함께 처리됨
        // (별도 placement path 불필요 — 레코드/basePosition 기반 동일 렌더)

        // ═══════════════════════════════════════════
        // 그리드 슬롯 → HTML 변환 (공통)
        // 원칙 11단계: employee_id<0 스페이서 분기 완전 제거
        // ═══════════════════════════════════════════
        eventsHTML = gridSlots.map((schedule, position) => {
            if (!schedule) {
                return `<div class="event-slot empty-slot" data-position="${position}" data-employee-id="empty" data-type="empty">
                    <span class="slot-number">${position + 1}</span>
                </div>`;
            } else {
                const emp = state.management.employees.find(e => e.id === schedule.employee_id);
                if (!emp) {
                    return `<div class="event-slot empty-slot" data-position="${position}" data-employee-id="empty" data-type="empty">
                        <span class="slot-number">${position + 1}</span>
                    </div>`;
                }

                const empStatus = schedule._empStatus || getEmployeeStatusOnDate(emp.id, dateStr);
                const vm = state.schedule.viewMode;

                // 뷰 모드 필터: 해당 뷰에서 보이지 않는 직원은 빈 칸으로 표시
                if (vm === 'working' && empStatus !== 'working') {
                    return `<div class="event-slot empty-slot" data-position="${position}" data-employee-id="empty" data-type="empty">
                        <span class="slot-number">${position + 1}</span>
                    </div>`;
                }
                if (vm === 'off' && empStatus === 'working') {
                    return `<div class="event-slot empty-slot" data-position="${position}" data-employee-id="empty" data-type="empty">
                        <span class="slot-number">${position + 1}</span>
                    </div>`;
                }

                const deptColor = getDepartmentColor(emp.departments?.id);
                const selKey = `${dateStr}_${emp.id}`;
                const isSelected = state.schedule.selectedSchedules.has(selKey) ? 'selected' : '';

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
                const offStyle = (vm === 'all' && empStatus !== 'working')
                    ? 'opacity: 0.45;' : '';
                // 휴무자 보기: 뚜렷하게 표시
                const offFocusClass = (vm === 'off')
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

    // 직원 포털(isReadOnly)에서는 모든 수정 인터랙션 차단 — 드래그드롭·더블클릭(휴일토글/카드상태)·우클릭 메뉴 모두 등록 X
    if (!state.schedule.isReadOnly) {
        // 모든 날짜에 드래그 앤 드롭 초기화
        document.querySelectorAll('.calendar-day').forEach(dayEl => {
            const dateStr = dayEl.dataset.date;
            initializeDayDragDrop(dayEl, dateStr);
        });

        // 추가 이벤트 리스너 연결 (더블클릭, 컨텍스트 메뉴, 키보드)
        initializeCalendarEvents();
    }

    // 클릭(선택 하이라이트만 발생, 데이터 변경 없음) — readonly 에서도 유지
    container.removeEventListener('click', handleCalendarClick);
    container.addEventListener('click', handleCalendarClick);

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

    const cardDate = card.closest('.calendar-day')?.dataset.date;
    const cardPos = parseInt(card.dataset.position, 10);
    const empId = card.dataset.employeeId;
    const selKey = (cardDate && empId && empId !== 'empty') ? `${cardDate}_${empId}` : null;

    // ✨ [A3] Shift+클릭: (row, col) 직사각 영역 선택 — CLAUDE.md 4단계 원칙
    // 앵커 A (r_A, c_A), 타겟 B (r_B, c_B) → {(r,c) : min_r≤r≤max_r, min_c≤c≤max_c}
    if (e.shiftKey && lastSelectedCardInfo) {
        e.preventDefault();
        const fromDate = lastSelectedCardInfo.date;
        const fromPos = lastSelectedCardInfo.position;

        const fromRow = Math.floor(fromPos / GRID_COLS);
        const fromCol = fromPos % GRID_COLS;
        const toRow = Math.floor(cardPos / GRID_COLS);
        const toCol = cardPos % GRID_COLS;
        const minRow = Math.min(fromRow, toRow);
        const maxRow = Math.max(fromRow, toRow);
        const minCol = Math.min(fromCol, toCol);
        const maxCol = Math.max(fromCol, toCol);

        const selectInDay = (dayEl, dateStr) => {
            dayEl.querySelectorAll('.event-card, .event-slot').forEach(el => {
                const pos = parseInt(el.dataset.position, 10);
                const r = Math.floor(pos / GRID_COLS);
                const c = pos % GRID_COLS;
                if (r >= minRow && r <= maxRow && c >= minCol && c <= maxCol) {
                    const eid = el.dataset.employeeId;
                    if (eid && eid !== 'empty') state.schedule.selectedSchedules.add(`${dateStr}_${eid}`);
                    el.classList.add('selected');
                }
            });
        };

        // 같은 날짜 내에서 직사각 선택
        if (cardDate === fromDate) {
            const dayEl = card.closest('.calendar-day');
            if (dayEl) selectInDay(dayEl, cardDate);
        }
        // 크로스 날짜: 두 날짜 사이의 모든 날짜에서 같은 (row, col) 직사각 영역 선택
        else {
            const allDayEls = document.querySelectorAll('.calendar-day');
            const dates = Array.from(allDayEls).map(d => d.dataset.date).filter(Boolean).sort();
            const startIdx = dates.indexOf(fromDate);
            const endIdx = dates.indexOf(cardDate);
            if (startIdx >= 0 && endIdx >= 0) {
                const minIdx = Math.min(startIdx, endIdx);
                const maxIdx = Math.max(startIdx, endIdx);
                for (let di = minIdx; di <= maxIdx; di++) {
                    const dayEl = document.querySelector(`.calendar-day[data-date="${dates[di]}"]`);
                    if (dayEl) selectInDay(dayEl, dates[di]);
                }
            }
        }

        return;
    }

    // Ctrl(Cmd) 키 누른 상태: 다중 선택 토글
    if (e.ctrlKey || e.metaKey) {
        if (selKey) {
            if (state.schedule.selectedSchedules.has(selKey)) {
                state.schedule.selectedSchedules.delete(selKey);
                card.classList.remove('selected');
            } else {
                state.schedule.selectedSchedules.add(selKey);
                card.classList.add('selected');
            }
        } else {
            card.classList.toggle('selected');
        }
        // Ctrl+클릭도 기준점 업데이트
        lastSelectedCardInfo = { date: cardDate, position: cardPos };
    }
    // 일반 클릭: 기존 선택 해제하고 단일 선택
    else {
        // 🔒 이미 선택된 카드를 클릭만 하면(드래그 X) 전체 선택 해제 — 단수/복수 무관
        if (selKey && state.schedule.selectedSchedules.has(selKey)) {
            clearSelection();
            card.classList.remove('selected');
            window.selectedEmptySlot = null;
            return;
        }

        clearSelection();
        if (window.selectedEmptySlot) {
            window.selectedEmptySlot.classList.remove('selected');
            window.selectedEmptySlot = null;
        }

        if (selKey) state.schedule.selectedSchedules.add(selKey);
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
        } else {
            window.selectedEmptySlot = null;
        }

        // 일반 클릭도 기준점 업데이트 (Shift+클릭 시작점)
        lastSelectedCardInfo = { date: cardDate, position: cardPos };
    }

}

// ✨ 그룹 이동 처리 함수
function handleGroupSameDateMove(dateStr, pivotEmpId, oldIndex, newIndex) {

    const delta = newIndex - oldIndex;
    if (delta === 0) return;

    // 1. 전체 스케줄 가져오기 (해당 날짜, 근무/휴무 무관)
    const allSchedules = state.schedule.schedules.filter(s => s.date === dateStr && s.employee_id > 0 && s.grid_position != null && s.grid_position >= 0 && s.grid_position < GRID_SIZE);

    // 2. 현재 그리드 구성 (배경) - 직원 ID 매핑 (전체 직원 포함)
    const currentGrid = new Array(GRID_SIZE).fill(null);
    const basePositions = getEmployeeBasePositions();
    const activeEmps = (state.management.employees || []).filter(
        e => isGridEmployee(e)
    );
    const dateScheds = new Map();
    allSchedules.forEach(s => { dateScheds.set(s.employee_id, s); });
    activeEmps.forEach(emp => {
        const sched = dateScheds.get(emp.id);
        const pos = (sched && sched.grid_position != null && sched.grid_position >= 0 && sched.grid_position < GRID_SIZE)
            ? sched.grid_position : basePositions.get(emp.id);
        if (pos != null && pos >= 0 && pos < GRID_SIZE && !currentGrid[pos]) {
            currentGrid[pos] = emp.id;
        }
    });

    // 3. 이동 대상(선택된) 직원 및 피벗 식별
    // 선택된 직원 ID 추출 (date_empId 키에서)
    const selectedEmpIds = new Set();
    state.schedule.selectedSchedules.forEach(selKey => {
        const [selDate, eidStr] = selKey.split('_');
        if (selDate === dateStr) selectedEmpIds.add(parseInt(eidStr, 10));
    });
    const movingScheduleIds = new Set();
    const movingItems = [];

    // 이동할 아이템 추출
    allSchedules.forEach(s => {
        if (selectedEmpIds.has(s.employee_id) || s.employee_id === pivotEmpId) {
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
                setSchedulePosFlat(schedule, newPos);
                schedule.sort_order = newPos;
                unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                changeCount++;
            }
        }
    });


    renderCalendar();
    updateSaveButtonState();
}

// ✨ 더블클릭 핸들러: 상태 변경(Toggle) / 삭제 로직 (기존 클릭 로직 이동)
function handleEventCardDblClick(e, card) {
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트 안전망)
    if (state.schedule?.isReadOnly) return;
    const empId = parseInt(card.dataset.employeeId);
    const scheduleId = card.dataset.scheduleId;

    // 빈칸 등 유효하지 않은 카드 제외
    if (!scheduleId || isNaN(empId)) return;

    // 원칙 15단계: 공휴일 지정된 날짜는 카드 조작 비활성 (전원 휴무 강제)
    const dateStr = card.closest('.calendar-day')?.dataset.date;
    if (dateStr && state.schedule.companyHolidays?.has(dateStr)) {
        alert('공휴일/전원 휴무일입니다. 날짜를 더블클릭하여 해제한 뒤 수정해주세요.');
        return;
    }

    // 3. 상태 토글 또는 삭제 (임시 직원)
    let schedule = state.schedule.schedules.find(s => s.id == scheduleId); // 타입 주의

    // ✨ 임시 직원 확인
    const emp = state.management.employees.find(e => e.id === empId);
    const isTemp = emp && emp.is_temp;

    // ✨ 연차 대상자인지 확인
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
        // 연차자는 더블클릭 무반응 (원칙 7단계)
        if (schedule.is_annual_leave) {
            alert('연차자입니다. 연차 해제는 연차 관리 페이지에서 처리해주세요.');
            return;
        }

        pushUndoState('Toggle Status'); // 상태 변경 전 Undo 저장

        if (isTemp) {
            // ✨ 임시 직원은 더블클릭 시 스케줄에서 삭제
            state.schedule.schedules = state.schedule.schedules.filter(s => s.id !== schedule.id);
            unsavedChanges.set(schedule.id, { type: 'delete', data: schedule });
        } else {
            // 기존 정규 직원 스케줄: 상태 전환 (근무 <-> 휴무)
            schedule.status = schedule.status === '근무' ? '휴무' : '근무';
            unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
        }

        // 선택 상태 해제 및 리렌더링
        clearSelection();
        renderCalendar();
        updateSaveButtonState();
    } else {
        // 레코드 없는 카드(기본 근무 표시 — id="auto-...") 더블클릭 → 휴무로 토글 (7단계: 근무→휴무).
        // 신규 휴무 레코드를 카드의 현재 DOM 위치에 생성. (근무 레코드 생성 시 화면 무변화 버그 수정)
        pushUndoState('Toggle Status');
        const tempId = `temp-${Date.now()}-${empId}`;
        const cardPos = parseInt(card.dataset.position, 10);
        const pos = Number.isFinite(cardPos) && cardPos >= 0 && cardPos < GRID_SIZE ? cardPos : -1;
        const newSchedule = {
            id: tempId,
            date: dateStr,
            employee_id: empId,
            status: '휴무',
            sort_order: pos,
            grid_position: pos,
            is_annual_leave: false
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


    try {
        const [layoutRes, scheduleRes, holidayRes] = await Promise.all([
            db.from('monthly_layouts').select('layout_data').lte('month', currentMonth).order('month', { ascending: false }).limit(1),
            db.from('schedules').select('*').gte('date', fetchStart).lte('date', fetchEnd),
            db.from('company_holidays').select('date').gte('date', fetchStart).lte('date', fetchEnd)
        ]);


        if (layoutRes.error) throw layoutRes.error;
        if (scheduleRes.error) throw scheduleRes.error;
        if (holidayRes.error) throw holidayRes.error;

        const latestLayout = layoutRes.data?.[0];
        // ✅ 직원 배치 — positional 포맷(length===GRID_SIZE, 0=빈자리)을 우선 보존.
        //    레거시 컴팩트 포맷(length<GRID_SIZE)도 호환 유지.
        let employeeOrder = [];
        if (latestLayout && latestLayout.layout_data && latestLayout.layout_data.length > 0) {
            employeeOrder = [...(latestLayout.layout_data[0].members || [])];
        }
        if (employeeOrder.length === 0) {
            employeeOrder = [...DEFAULT_TEAM_MEMBERS];
        }

        const activeEmployeeIds = (state.management?.employees || [])
            .filter(e => isGridEmployee(e))
            .map(e => e.id);

        const isPositional = employeeOrder.length === GRID_SIZE;
        if (isPositional) {
            // positional: 0(빈자리)·음수(레거시 스페이서) 그대로 유지 — 위치 보존이 핵심.
            // 신규 활성 직원은 자동 push 하지 않음 (renderScheduleSidebar 가 unplaced 패널로 분기).
            // 단, 레거시 -1 스페이서가 섞여 있을 수 있어 0 으로 정규화.
            employeeOrder = employeeOrder.map(id => (typeof id === 'number' && id > 0) ? id : 0);
        } else if (employeeOrder.length > 0) {
            // 컴팩트: -1 스페이서 제거 + 신규 활성 직원 끝에 추가 (기존 동작 유지).
            employeeOrder = employeeOrder.filter(id => id > 0);
            const memberSet = new Set(employeeOrder);
            activeEmployeeIds.forEach(id => {
                if (!memberSet.has(id)) {
                    employeeOrder.push(id);
                    memberSet.add(id);
                }
            });
        }
        state.schedule.teamLayout = {
            month: dayjs(date).format('YYYY-MM'),
            data: employeeOrder.length > 0 ? [{ id: 'main', name: '직원 목록', members: employeeOrder }] : []
        };
        state.schedule.schedules = (scheduleRes.data || []).map(hydrateScheduleRow);
        state.schedule.companyHolidays = new Set((holidayRes.data || []).map(h => h.date));


        const titleEl = _('#calendar-title');
        if (titleEl) {
            titleEl.textContent = dayjs(date).format('YYYY년 M월');
        }

        // ✨ 순서 변경: 달력을 먼저 렌더링
        renderCalendar();

        // ✨ 이벤트 리스너 초기화 (휴일 토글 등) — 직원 포털(isReadOnly)에서는 등록 X
        if (!state.schedule.isReadOnly) {
            initializeCalendarEvents();
        }

        // ✨ 그 다음 사이드바 렌더링 (이때 달력의 day-events가 존재함)
        await renderScheduleSidebar();

        // 관리자 모드일 경우 확정 상태 체크
        if (state.currentUser?.isManager || state.currentUser?.role === 'admin') {
            await checkScheduleConfirmationStatus();
        }

        // 관리자 대시보드 카드(근무일수·평균 직원수·평균 원장수·이달 연차)는 보는 달 기준 → 달 navigate 마다 갱신
        window.refreshAdminSummary?.();

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
            emptyInsertThreshold: 0, // 빈 공간 삽입(주변 카드 밀림) 비활성 — swap만 사용
            swap: true,
            swapClass: 'sortable-swap-highlight',
            // delay 제거 — 달력 그리드와 동일하게 즉시 드래그 시작

            onStart(evt) {
                isDragging = true;
                dragStartTime = Date.now();
                document.body.style.userSelect = 'none';

                // 그룹 이동 / 선택 선행 검증을 위해 스냅샷 캡쳐
                const grid = document.getElementById('layout-grid');
                if (grid) {
                    layoutDragSnapshot = grid.innerHTML;
                    const draggedPos = parseInt(evt.item.dataset.position, 10);
                    layoutDragMultiInfo = {
                        draggedPos: isNaN(draggedPos) ? null : draggedPos,
                        isInSelection: !isNaN(draggedPos) && layoutSelectedSlots.has(draggedPos),
                        selectedPositions: [...layoutSelectedSlots]
                    };
                }
            },

            onUpdate(evt) {
                const grid = document.getElementById('layout-grid');
                // 스냅샷 없거나 정보 없음 → 기본 동작
                if (!grid || !layoutDragSnapshot || !layoutDragMultiInfo) {
                    syncGridPositions();
                    return;
                }

                const sel = layoutDragMultiInfo.selectedPositions;
                const fromPos = layoutDragMultiInfo.draggedPos;
                // SortableJS 잔여 클래스 정리 (스냅샷이 chosen 등을 포함한 채 캡쳐됨)
                const cleanSortableClasses = (root) => {
                    root.querySelectorAll('.sortable-chosen, .sortable-drag, .sortable-ghost, .sortable-swap-highlight').forEach(el => {
                        el.classList.remove('sortable-chosen', 'sortable-drag', 'sortable-ghost', 'sortable-swap-highlight');
                    });
                };
                const restore = () => {
                    grid.innerHTML = layoutDragSnapshot;
                    cleanSortableClasses(grid);
                    layoutDragSnapshot = null;
                    layoutDragMultiInfo = null;
                    syncGridPositions();
                };

                // 🔒 CLAUDE.md: 선택 없는 상태에서 드래그 → 아무 일도 안 일어남
                if (sel.length === 0) {
                    restore();
                    return;
                }
                // 🔒 CLAUDE.md: 선택에 포함되지 않은 카드를 드래그 → 선택 풀고 아무 일도 안 일어남
                if (!layoutDragMultiInfo.isInSelection) {
                    restore();
                    clearLayoutSelection();
                    return;
                }

                // 단일 선택은 SortableJS 의 swap 그대로 — 그룹 처리 안 함
                if (sel.length === 1) {
                    layoutDragSnapshot = null;
                    layoutDragMultiInfo = null;
                    syncGridPositions();
                    return;
                }

                // 복수 선택 — 행/열 델타 기반 그룹 이동
                const draggedEl = evt.item;
                const newPos = [...grid.querySelectorAll('.event-card, .event-slot')].indexOf(draggedEl);
                if (fromPos == null || newPos < 0) { restore(); return; }
                if (newPos === fromPos) { restore(); return; }

                const rowDelta = Math.floor(newPos / GRID_COLS) - Math.floor(fromPos / GRID_COLS);
                const colDelta = (newPos % GRID_COLS) - (fromPos % GRID_COLS);
                const TOTAL_ROWS = GRID_SIZE / GRID_COLS;

                // 🔒 CLAUDE.md: OOB 전체 취소
                let outOfBounds = false;
                sel.forEach(p => {
                    const r = Math.floor(p / GRID_COLS) + rowDelta;
                    const c = (p % GRID_COLS) + colDelta;
                    if (c < 0 || c >= GRID_COLS || r < 0 || r >= TOTAL_ROWS) outOfBounds = true;
                });
                if (outOfBounds) { restore(); return; }

                // Sortable swap 되돌리고 multi-move 적용
                grid.innerHTML = layoutDragSnapshot;
                cleanSortableClasses(grid);
                const restored = [...grid.querySelectorAll('.event-card, .event-slot')];

                const sourceData = sel.map(p => {
                    const s = restored[p];
                    return {
                        from: p,
                        to: (Math.floor(p / GRID_COLS) + rowDelta) * GRID_COLS + ((p % GRID_COLS) + colDelta),
                        isFilled: s.dataset.employeeId && s.dataset.employeeId !== 'empty',
                        empId: s.dataset.employeeId,
                        type: s.dataset.type,
                        className: s.className,
                        innerHTML: s.innerHTML
                    };
                });

                // source → 빈자리
                sourceData.forEach(s => {
                    const slot = restored[s.from];
                    slot.className = 'event-slot empty-slot';
                    slot.dataset.employeeId = 'empty';
                    slot.dataset.type = 'empty';
                    slot.innerHTML = `<span class="slot-number">${s.from + 1}</span>`;
                });
                // 채워진 source → target 에 배치 (target 의 기존 점유자는 덮어쓰기)
                sourceData.forEach(s => {
                    if (!s.isFilled) return;
                    const t = restored[s.to];
                    t.className = s.className;
                    t.dataset.employeeId = s.empId;
                    t.dataset.type = s.type;
                    t.innerHTML = s.innerHTML;
                });

                syncGridPositions();
                clearLayoutSelection();
                layoutDragSnapshot = null;
                layoutDragMultiInfo = null;
            },

            onAdd(evt) {
                // 직원 목록에서 들어온 clone 처리 — 위치 기반 배치 (삽입-shift 금지).
                // SortableJS 는 클론을 33번째 요소로 삽입해 뒤 슬롯을 한 칸씩 민다.
                // → 클론을 제거하고 32슬롯을 유지한 채 타겟 슬롯에만 직원을 배치한다.
                const el = evt.item;
                const empId = parseInt(el.dataset.employeeId);
                const emp = (state.management.employees || []).find(e => e.id === empId);
                const grid = document.getElementById('layout-grid');

                if (!emp || isNaN(empId) || !grid) {
                    el.remove();
                    return;
                }

                // 클론의 현재 인덱스 = 드롭 타겟. 클론 제거 후 같은 인덱스의 슬롯이 원래 타겟이 됨.
                const withClone = [...grid.querySelectorAll('.event-card, .event-slot')];
                let targetPos = withClone.indexOf(el);
                el.remove();
                const slots = [...grid.querySelectorAll('.event-card, .event-slot')];
                if (targetPos < 0) targetPos = slots.length - 1;
                if (targetPos > slots.length - 1) targetPos = slots.length - 1;
                const targetSlot = slots[targetPos];
                if (!targetSlot) { syncGridPositions(); return; }

                const setEmpty = (slot, pos) => {
                    slot.className = 'event-slot empty-slot';
                    slot.dataset.employeeId = 'empty';
                    slot.dataset.type = 'empty';
                    slot.innerHTML = `<span class="slot-number">${pos + 1}</span>`;
                };

                // 같은 직원이 이미 그리드에 있으면 그 자리 비우기 (한 그리드 1명 원칙)
                slots.forEach((s, i) => {
                    if (s !== targetSlot && s.dataset.employeeId === String(empId)) setEmpty(s, i);
                });

                // 타겟이 다른 직원으로 점유돼 있으면 그 점유자만 가장 가까운 빈자리로 (주변 카드는 안 움직임)
                const occId = targetSlot.dataset.employeeId;
                if (occId && occId !== 'empty' && occId !== String(empId)) {
                    const occupied = new Set([targetPos]); // 타겟은 새 직원이 차지 → 점유 처리
                    slots.forEach((s, i) => {
                        if (s.dataset.employeeId && s.dataset.employeeId !== 'empty') occupied.add(i);
                    });
                    const nearest = findNearestEmptyPos(targetPos, occupied);
                    if (nearest != null && slots[nearest]) {
                        const ns = slots[nearest];
                        ns.className = targetSlot.className;
                        ns.dataset.employeeId = targetSlot.dataset.employeeId;
                        ns.dataset.type = targetSlot.dataset.type;
                        ns.innerHTML = targetSlot.innerHTML;
                    }
                    // 빈자리 없으면 점유자 덮어쓰기 (방어적)
                }

                // 타겟 슬롯에 직원 배치
                const deptColor = getDepartmentColor(emp.departments?.id);
                targetSlot.className = 'event-card event-working';
                targetSlot.dataset.employeeId = emp.id;
                targetSlot.dataset.type = 'working';
                targetSlot.innerHTML = `
                    <span class="event-dot" style="background-color: ${deptColor};"></span>
                    <span class="event-name">${emp.name}</span>
                `;

                syncGridPositions();
            },

            onEnd(evt) {
                setTimeout(() => { isDragging = false; }, 100);
                document.body.style.userSelect = '';
                // onUpdate 가 안 불린 케이스(같은 자리 드롭 등) — 잔존 스냅샷 정리
                layoutDragSnapshot = null;
                layoutDragMultiInfo = null;
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

    // 테스트 직원 — state.js 헬퍼 사용 (이름 OR 부서명에 "테스트")
    const isTest = (e) => isTestEmployee(e);
    // 정규 활성 직원 — isGridEmployee 기준 (test/휴직/퇴사/hidden 모두 격리됨)
    const activeRegular = allEmployees.filter(e => isGridEmployee(e));
    // 임시 직원 (알바). test 제외해서 풀 분리.
    const tempEmployees = allEmployees.filter(e => isTemp(e) && !isTest(e));
    // 테스트 직원 — 모두 별도 풀로
    const testEmployees = allEmployees.filter(e => isTest(e));
    // 휴직 직원 (on_leave) — 별도 풀
    const onLeaveEmployees = allEmployees.filter(e =>
        !isTemp(e) && !isTest(e) && getEmployeeStatus(e) === 'on_leave'
    );
    // 퇴사 직원 (retired) — 별도 풀 (legacy retired 플래그 + resignation_date 다음달 1일 cutoff)
    const retiredEmployees = allEmployees.filter(e =>
        !isTemp(e) && !isTest(e) && getEmployeeStatus(e) === 'retired'
    );

    // ✅ 32칸 그리드 슬롯 생성
    const gridSlots = new Array(GRID_SIZE).fill(null);
    const unplacedEmployees = []; // 그리드에 배치되지 않은 직원

    const savedLayout = state.schedule.teamLayout?.data?.[0];
    if (savedLayout && savedLayout.members && savedLayout.members.length > 0) {
        // 포맷 감지: 길이 == GRID_SIZE → positional (0=빈자리), 아니면 레거시 컴팩트
        const isPositional = savedLayout.members.length === GRID_SIZE;

        if (isPositional) {
            // ✅ 위치 보존 포맷: members[pos] = empId (양수) 또는 0(빈자리)
            savedLayout.members.forEach((memberId, pos) => {
                if (pos >= GRID_SIZE) return;
                if (!memberId || memberId <= 0) return; // 빈자리 / 레거시 스페이서 skip
                const emp = activeRegular.find(e => e.id === memberId);
                if (emp) gridSlots[pos] = emp;
            });
        } else {
            // 레거시 컴팩트 포맷: 채워진 직원만 순차 나열 (빈자리 정보 없음)
            let slotIdx = 0;
            savedLayout.members.forEach(memberId => {
                if (slotIdx >= GRID_SIZE) return;
                if (memberId < 0) return;
                const emp = activeRegular.find(e => e.id === memberId);
                if (emp) {
                    gridSlots[slotIdx] = emp;
                    slotIdx++;
                }
            });
        }

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
            const emp = activeRegular.find(e => e.id === memberId);
            if (emp) {
                gridSlots[slotIdx] = emp;
                slotIdx++;
            }
        });
        // DEFAULT에 없는 활성 직원 → 미배치
        const defaultIds = new Set(DEFAULT_TEAM_MEMBERS);
        activeRegular.forEach(emp => {
            if (!defaultIds.has(emp.id) && !gridSlots.some(s => s && s.id === emp.id)) {
                unplacedEmployees.push(emp);
            }
        });
    }


    // ═══ 그리드 슬롯 HTML 생성 (달력 날짜칸과 동일한 구조)
    //    원칙 11단계: isSpacer 분기 제거
    const gridSlotsHtml = gridSlots.map((slot, pos) => {
        if (!slot) {
            return `<div class="event-slot empty-slot" data-position="${pos}" data-employee-id="empty" data-type="empty">
                <span class="slot-number">${pos + 1}</span>
            </div>`;
        }
        const deptColor = getDepartmentColor(slot.departments?.id);
        return `<div class="event-card event-working" data-position="${pos}" data-employee-id="${slot.id}" data-type="working">
            <span class="event-dot" style="background-color: ${deptColor};"></span>
            <span class="event-name">${slot.name}</span>
        </div>`;
    }).join('');

    const currentMonth = dayjs(state.schedule.currentDate).format('YYYY년 M월');

    // ═══ 부서별 직원 목록 HTML (우측 패널) ═══
    // 단일 헬퍼 sortByDeptOrder 로 정렬 후 부서별 그룹화 — 검수칸과 동일 순서 보장
    const departments = state.management?.departments || [];
    const deptNameMap = {};
    departments.forEach(d => { deptNameMap[d.id] = d.name; });

    // 휴직/퇴사 sidebar 부서 풀에서 제외. 테스트는 admin (토글 무관) 또는 showTestEmployees=true 일 때만 포함
    const sidebarPoolEmps = activeRegular.filter(emp => {
        const status = getEmployeeStatus(emp);
        if (status === 'retired' || status === 'on_leave') return false;
        if (status === 'alba') return false; // 알바는 별도 '임시' 그룹에서 처리 (부서 풀 중복 방지)
        if (status === 'test' && state.userRole !== 'admin' && !state.showTestEmployees) return false;
        return true;
    });
    const sortedPoolEmps = sortByDeptOrder(sidebarPoolEmps, departments);

    const deptGroups = {};
    sortedPoolEmps.forEach(emp => {
        const deptName = deptNameMap[emp.department_id] || '기타';
        if (!deptGroups[deptName]) deptGroups[deptName] = [];
        deptGroups[deptName].push(emp);
    });

    // sortByDeptOrder 의 부서 순서 그대로 사용 (DEPT_ORDER + 미지정 부서 끝)
    const allDeptNames = [];
    sortedPoolEmps.forEach(emp => {
        const name = deptNameMap[emp.department_id] || '기타';
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
    const onLeaveCards = onLeaveEmployees.map(emp => {
        const c = getDepartmentColor(emp.departments?.id);
        return `<div class="layout-slot layout-filled layout-retired layout-pool-card" data-employee-id="${emp.id}">
            <span class="layout-dot" style="background-color:${c};"></span>
            <span class="layout-name">${emp.name}</span>
        </div>`;
    }).join('');

    // 퇴사 직원
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
    //    원칙 11단계: 스페이서 토글 제거 — 빈 슬롯 그대로가 경계 역할
    const layoutGrid = _('#layout-grid');
    if (layoutGrid) {
        layoutGrid.addEventListener('click', handleLayoutGridClick);
    }

    initializeSortableAndDraggable();
}

// ═══ 배치 그리드 선택/클립보드 상태 ═══
let layoutSelectedSlots = new Set(); // Set<position index>
let layoutLastClickedPos = null;
let layoutClipboard = []; // [{employeeId, name, deptId, offset}]
let layoutDragState = null; // 마우스 드래그 선택 상태
let layoutDragSelectJustFinished = false;
// SortableJS 그룹 이동 — onStart 에 캡쳐, onUpdate/onEnd 에 사용
let layoutDragSnapshot = null; // 드래그 시작 시점의 grid.innerHTML
let layoutDragMultiInfo = null; // { draggedPos, isInSelection, selectedPositions: number[] }

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
        const startRow = Math.floor(layoutLastClickedPos / GRID_COLS);
        const startCol = layoutLastClickedPos % GRID_COLS;
        const endRow = Math.floor(pos / GRID_COLS);
        const endCol = pos % GRID_COLS;
        const minRow = Math.min(startRow, endRow), maxRow = Math.max(startRow, endRow);
        const minCol = Math.min(startCol, endCol), maxCol = Math.max(startCol, endCol);

        document.querySelectorAll('#layout-grid .event-card, #layout-grid .event-slot').forEach(el => {
            const p = parseInt(el.dataset.position, 10);
            const r = Math.floor(p / GRID_COLS), c = p % GRID_COLS;
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
    // 방어: 마우스 버튼이 안 눌린 상태에서 mousemove → mouseup 누락 등으로 stale state. 즉시 정리.
    if (e.buttons === 0) {
        layoutDragState = null;
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleLayoutDragSelectMove);
        document.removeEventListener('mouseup', handleLayoutDragSelectEnd);
        return;
    }
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
    const startRow = Math.floor(layoutDragState.startPos / GRID_COLS);
    const startCol = layoutDragState.startPos % GRID_COLS;
    const endRow = Math.floor(endPos / GRID_COLS);
    const endCol = endPos % GRID_COLS;
    const minRow = Math.min(startRow, endRow), maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol), maxCol = Math.max(startCol, endCol);

    clearLayoutSelection();
    document.querySelectorAll('#layout-grid .event-card, #layout-grid .event-slot').forEach(sl => {
        const p = parseInt(sl.dataset.position, 10);
        const r = Math.floor(p / GRID_COLS), c = p % GRID_COLS;
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
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트 안전망)
    if (state.schedule?.isReadOnly) return;
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
            pushUndoState(`Set holiday ${dateStr}`);

            // 원칙 15단계: 지정 직전 상태를 스냅샷으로 보관
            const snapshot = state.schedule.schedules
                .filter(s => s.date === dateStr && s.employee_id > 0)
                .map(s => ({ employee_id: s.employee_id, status: s.status, grid_position: s.grid_position, is_annual_leave: s.is_annual_leave ?? false }));
            if (!state.schedule.holidaySnapshots) state.schedule.holidaySnapshots = new Map();
            state.schedule.holidaySnapshots.set(dateStr, snapshot);

            // 기존 레코드가 있는 근무자 → 휴무 전환
            workingSchedules.forEach(s => {
                s.status = '휴무';
                unsavedChanges.set(s.id, { type: 'update', data: s });
            });
            // 레코드 없는 직원도 휴무 레코드 생성 (화면에 보이는 전원)
            const existingEmpIds = new Set(state.schedule.schedules.filter(s => s.date === dateStr && s.employee_id > 0).map(s => s.employee_id));
            const activeEmps = (state.management.employees || []).filter(e => isGridEmployee(e));
            activeEmps.forEach(emp => {
                if (!existingEmpIds.has(emp.id)) {
                    const cardEl = document.querySelector(`.calendar-day[data-date="${dateStr}"] .event-card[data-employee-id="${emp.id}"]`);
                    const pos = cardEl ? parseInt(cardEl.dataset.position, 10) : 0;
                    const newSched = {
                        id: `holiday-${Date.now()}-${emp.id}`, date: dateStr, employee_id: emp.id,
                        status: '휴무', grid_position: pos, sort_order: pos
                    };
                    state.schedule.schedules.push(newSched);
                    unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
                }
            });
            state.schedule.companyHolidays.add(dateStr);
            unsavedHolidayChanges.toAdd.add(dateStr);
            unsavedHolidayChanges.toRemove.delete(dateStr);
            renderCalendar();
            updateSaveButtonState();
        }
    } else {
        if (confirm(`${dateStr}의 휴일 설정을 해제하고 모든 직원을 근무로 변경하시겠습니까?`)) {
            pushUndoState(`Unset holiday ${dateStr}`);

            state.schedule.companyHolidays.delete(dateStr);
            unsavedHolidayChanges.toRemove.add(dateStr);
            unsavedHolidayChanges.toAdd.delete(dateStr);

            // 원칙 15단계: 스냅샷 있으면 복원, 없으면 전원 근무로 초기화
            const snapshot = state.schedule.holidaySnapshots?.get(dateStr);
            if (snapshot) {
                // 스냅샷 복원
                const snapById = new Map(snapshot.map(s => [s.employee_id, s]));
                state.schedule.schedules.forEach(s => {
                    if (s.date === dateStr && s.employee_id > 0 && snapById.has(s.employee_id)) {
                        const snap = snapById.get(s.employee_id);
                        s.status = snap.status;
                        if (snap.grid_position != null) {
                            setSchedulePosFlat(s, snap.grid_position);
                            s.sort_order = snap.grid_position;
                        }
                        s.is_annual_leave = snap.is_annual_leave ?? false;
                        unsavedChanges.set(s.id, { type: 'update', data: s });
                    }
                });
                state.schedule.holidaySnapshots.delete(dateStr);
                renderCalendar();
                updateSaveButtonState();
                return;
            }

            // 스냅샷 없음 → 전원 근무 초기화 분기 (기존 로직)

            // 1. 이미 근무 중인 사람들의 포지션 점유 확인
            const occupiedPositions = new Set();
            state.schedule.schedules.forEach(s => {
                if (s.date === dateStr && s.status === '근무') {
                    occupiedPositions.add(s.grid_position);
                }
            });

            // 2. 복귀 대상 직원 처리
            const allActiveEmployees = state.management.employees.filter(e => isActiveOnDate(e, dateStr));

            allActiveEmployees.forEach(emp => {
                let schedule = state.schedule.schedules.find(s => s.date === dateStr && s.employee_id === emp.id);

                if (schedule) {
                    if (schedule.status !== '근무') {
                        // 휴무 -> 근무 복귀
                        let targetPos = schedule.grid_position;

                        // 포지션 충돌 또는 유효하지 않은 경우(null, undefined) 재설정
                        if (targetPos === null || targetPos === undefined || occupiedPositions.has(targetPos) || targetPos >= GRID_SIZE) {
                            // 빈 자리 찾기
                            let newPos = 0;
                            while (occupiedPositions.has(newPos) && newPos < GRID_SIZE) newPos++;
                            targetPos = newPos;
                        }

                        if (targetPos < GRID_SIZE) {
                            schedule.status = '근무';
                            setSchedulePosFlat(schedule, targetPos);
                            schedule.sort_order = targetPos; // 정렬 순서도 동기화
                            unsavedChanges.set(schedule.id, { type: 'update', data: schedule });
                            occupiedPositions.add(targetPos);
                        }
                    }
                } else {
                    // 스케줄 없음 -> 배치 패널 위치 기준으로 복귀
                    const basePositions = getEmployeeBasePositions();
                    let newPos = basePositions.get(emp.id) ?? 0;
                    if (occupiedPositions.has(newPos)) {
                        newPos = 0;
                        while (occupiedPositions.has(newPos) && newPos < GRID_SIZE) newPos++;
                    }

                    if (newPos < GRID_SIZE) {
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

    // 원칙 15단계: 공휴일 날짜의 카드/빈슬롯 우클릭은 비활성 (날짜 헤더 우클릭은 허용 — 공휴일 토글 해제용)
    const ctxDayEl = e.target.closest('.calendar-day');
    const ctxDateStr = ctxDayEl?.dataset.date;
    const isHolidayDate = ctxDateStr && state.schedule.companyHolidays?.has(ctxDateStr);
    if (isHolidayDate && (card || emptySlot) && !dateHeader) {
        employeeContextMenu.classList.add('hidden');
        document.getElementById('custom-context-menu-v2')?.classList.add('hidden');
        dateContextMenu.classList.add('hidden');
        return;
    }

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
            // 해당 부서의 직원 목록 (제외직원/비활성 직원 제외)
            const deptEmployees = state.management.employees.filter(emp =>
                emp.department_id === dept.id &&
                !excludedIds.has(emp.id) &&
                isActiveOnDate(emp, date)
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
        // 원칙 10단계: 카드 우클릭 메뉴
        //  - 연차자: "연차입니다" 알림만, 메뉴 안 열림
        //  - 근무자(정규): "연차 등록하기" 포함
        //  - 근무자(임시 직원): "연차 등록하기" 숨김 (Fix 5)
        //  - 휴무자: 근무자로 변경 전용 (연차 취소/해제 메뉴 일절 없음 — 연차 관리 페이지로 이동)
        const contextMenuV2 = document.getElementById('custom-context-menu-v2');
        if (!contextMenuV2) return;

        employeeContextMenu.classList.add('hidden');

        const employeeId = card.dataset.employeeId;
        const dayEl = card.closest('.calendar-day');
        const date = dayEl ? dayEl.dataset.date : null;
        const cardType = card.dataset.type;

        if (!employeeId || !date) return;

        const empIdNum = parseInt(employeeId);
        const isLeave = card.classList.contains('event-leave') || cardType === 'leave'
            || (empIdNum > 0 && getEmployeeStatusOnDate(empIdNum, date) === 'leave');

        // 연차자: 알림만 띄우고 메뉴 열지 않음
        if (isLeave) {
            alert('연차입니다.\n연차 변경은 "연차 관리" 페이지에서 처리해주세요.');
            return;
        }

        // 메뉴 데이터 설정
        contextMenuV2.dataset.employeeId = employeeId;
        contextMenuV2.dataset.date = date;

        const registerBtn = document.getElementById('ctx-register-leave-v2');
        if (registerBtn) {
            // 임시 직원은 연차여부 항상 false → 등록 메뉴 숨김 (원칙 11단계 Fix 5)
            const emp = (state.management.employees || []).find(e => e.id === empIdNum);
            const isTempEmp = !!(emp && (emp.is_temp || emp.email?.startsWith('temp-')));
            if (isTempEmp) {
                registerBtn.classList.add('hidden');
                registerBtn.style.display = 'none';
            } else {
                registerBtn.classList.remove('hidden');
                registerBtn.style.display = 'block';
            }
        }

        contextMenuV2.style.left = `${x}px`;
        contextMenuV2.style.top = `${y}px`;
        contextMenuV2.classList.remove('hidden');
    }
}

// ✨ 빈 슬롯 우클릭을 통한 직원 할당 로직 — placeCards 경유로 R1/R2 규칙 적용
function handleEmployeeAssignment(employeeId, dateStr, position) {
    if (!employeeId || !dateStr || position === undefined) return;

    pushUndoState('Add Schedule via Context Menu');
    placeCards([{ employee_id: employeeId, status: '근무' }], dateStr, position);

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
    // DOM에서 근무 카드를 직접 읽기 (레코드 유무 무관)
    const dayEl = document.querySelector(`.calendar-day[data-date="${dateStr}"]`);
    if (dayEl) {
        dayEl.querySelectorAll('.event-card[data-type="working"]').forEach(card => {
            const eid = parseInt(card.dataset.employeeId, 10);
            const pos = parseInt(card.dataset.position, 10);
            if (eid > 0) {
                scheduleClipboard.push({
                    employee_id: eid, status: '근무',
                    grid_position: pos, _origPos: pos
                });
            }
        });
    }

    if (scheduleClipboard.length === 0) {
        alert('해당 날짜에 복사할 근무자가 없습니다.');
        dateContextMenu.classList.add('hidden');
        return;
    }

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
        const eid = card.dataset.employeeId;
        if (eid && eid !== 'empty') {
            const selKey = `${dateStr}_${eid}`;
            if (isAllSelected) {
                state.schedule.selectedSchedules.delete(selKey);
                card.classList.remove('selected');
            } else {
                state.schedule.selectedSchedules.add(selKey);
                card.classList.add('selected');
            }
        }
    });

    dateContextMenu.classList.add('hidden');
}

// ✨ Register Menu Item Click Handler
function handleMenuRegisterClick() {
    // 원칙 16단계: 읽기 전용 모드에서는 모든 mutation 차단 (단일 게이트 안전망)
    if (state.schedule?.isReadOnly) return;
    const contextMenu = document.getElementById('custom-context-menu-v2');
    const employeeId = contextMenu.dataset.employeeId;
    const date = contextMenu.dataset.date;

    if (employeeId && date) {
        // Call imported management function
        registerManualLeave(employeeId, null, date);
    }
    contextMenu.classList.add('hidden');
}

// 원칙 10단계: 카드 우클릭에서 "연차 취소하기" 메뉴 제거됨 (연차 관리 페이지로 일원화)

// ✨ Named Handler for Calendar Grid Double Click (to avoid stacking)
function handleCalendarGridDblClick(e) {
    // 1. 카드 더블클릭 우선 처리
    if (e.target.closest('.event-card')) {
        handleCalendarDblClick(e);
        return; // ✨ 카드를 클릭했으면 헤더 토글 방지
    }

    // 2. 날짜 칸(헤더 포함) 더블클릭
    if (e.target.closest('.calendar-day')) {
        // 날짜 클릭은 기존 핸들러 (헤더 토글 등)
        handleDateHeaderDblClick(e);
    }
}

// ✨ 더블클릭 및 키보드 이벤트 연결을 위한 초기화
function initializeCalendarEvents() {
    const calendarGrid = document.querySelector('#pure-calendar');
    if (calendarGrid) {
        // ✨ Remove anonymous listeners is impossible, so we use named handler now.
        // ✨ Named handler로 중복 방지: remove 후 add
        calendarGrid.removeEventListener('dblclick', handleCalendarGridDblClick, { capture: true });
        calendarGrid.addEventListener('dblclick', handleCalendarGridDblClick, { capture: true });

        // ✨ Context Menu Logic
        calendarGrid.removeEventListener('contextmenu', handleContextMenu);
        calendarGrid.addEventListener('contextmenu', handleContextMenu);
    } else {
        console.error('❌ #pure-calendar NOT FOUND during initialization');
    }

    // ✨ Global Context Menu Handlers
    document.removeEventListener('click', handleGlobalClickForMenu);
    document.addEventListener('click', handleGlobalClickForMenu);

    const registerBtn = document.getElementById('ctx-register-leave-v2');
    const closeBtn = document.getElementById('ctx-close-menu');
    const contextMenuV2 = document.getElementById('custom-context-menu-v2');

    // 원칙 10단계: "연차 취소하기" 바인딩 제거, "연차 등록하기"만 유지
    if (registerBtn) {
        registerBtn.onclick = handleMenuRegisterClick;
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

        // 🆕 달력 카드 커스텀 포인터 DnD (선택된 카드 위 pointerdown 에서만 발동)
        //    ⚠️ capture 단계 부착 필수: .day-events 의 SortableJS 가 bubble 단계에서 pointerdown 을
        //       소비(stopPropagation)하므로, bubble 로 붙이면 핸들러가 발화하지 않음.
        //       capture 는 SortableJS bubble 리스너보다 먼저 실행되어 안전.
        calendarGrid.removeEventListener('pointerdown', onCalendarCardPointerDown, true);
        calendarGrid.addEventListener('pointerdown', onCalendarCardPointerDown, true);
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

    // 🆕 마퀴는 카드/빈칸 모두에서 armed. 카드 위에서 '빠르게' 끌면 여기(영역선택)가 활성화되고,
    //    '0.6초 홀드 후' 끌면 onCalendarCardPointerDown 의 픽업이 isDragging=true 로 만들어 아래에서 양보됨.
    //    → 이동/영역선택 구분은 '홀드 시간'으로 (사용자 요구).
    if (isDragging) return;   // 카드 이동 픽업이 이미 시작됐으면 마퀴 양보

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
    // 방어: 마우스 버튼이 안 눌린 상태에서 mousemove → mouseup 누락 등으로 stale state. 즉시 정리.
    if (e.buttons === 0) {
        dragSelectState = null;
        document.body.style.userSelect = '';
        document.querySelectorAll('.drag-select-highlight').forEach(el => el.classList.remove('drag-select-highlight'));
        return;
    }
    if (isDragging) { dragSelectState = null; return; }

    // 최소 이동 거리 (12px) 초과 시 드래그 선택 활성화 — 살짝 클릭+흔들림으로 오발동 방지
    const dx = e.clientX - dragSelectState.startX;
    const dy = e.clientY - dragSelectState.startY;
    if (!dragSelectState.active && (Math.abs(dx) < 12 && Math.abs(dy) < 12)) return;

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
        const eid = el.dataset.employeeId;
        const elDate = el.closest('.calendar-day')?.dataset.date;
        if (eid && eid !== 'empty' && elDate) state.schedule.selectedSchedules.delete(`${elDate}_${eid}`);
    });

    // 범위 계산 (날짜 간 + row/col 기반 사각형 선택, 4열 그리드)
    const allDayEls = document.querySelectorAll('.calendar-day');
    const dates = Array.from(allDayEls).map(d => d.dataset.date).filter(Boolean).sort();
    const startIdx = dates.indexOf(dragSelectState.startDate);
    const endIdx = dates.indexOf(info.date);
    if (startIdx < 0 || endIdx < 0) return;

    const minDateIdx = Math.min(startIdx, endIdx);
    const maxDateIdx = Math.max(startIdx, endIdx);

    // position → row/col 변환으로 사각형 선택
    const startRow = Math.floor(dragSelectState.startPos / GRID_COLS);
    const startCol = dragSelectState.startPos % GRID_COLS;
    const endRow = Math.floor(info.position / GRID_COLS);
    const endCol = info.position % GRID_COLS;
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
            const row = Math.floor(pos / GRID_COLS);
            const col = pos % GRID_COLS;
            if (row >= minRow && row <= maxRow && col >= minCol && col <= maxCol) {
                el.classList.add('selected', 'drag-select-highlight');
                const eid = el.dataset.employeeId;
                if (eid && eid !== 'empty') state.schedule.selectedSchedules.add(`${dates[di]}_${eid}`);
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
    }
}

// ✨ 키보드 이벤트 핸들러
function handleGlobalKeydown(e) {
    // 입력 필드 등에서는 무시
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // 직원 포털(isReadOnly)에서는 모든 단축키 차단 (Ctrl+Z/Y/C/X/V, Del, Backspace)
    if (state.schedule?.isReadOnly) return;

    // ✅ 배치 그리드에 선택이 있으면 배치 그리드 키보드 처리 우선
    if (layoutSelectedSlots.size > 0 && handleLayoutKeyAction(e)) return;

    // Undo (Ctrl+Z) — Shift+Ctrl+Z 는 Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redoLastChange();
        else undoLastChange();
        return;
    }

    // Redo (Ctrl+Y)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoLastChange();
        return;
    }

    // Copy (Ctrl+C)
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (state.schedule.selectedSchedules.size > 0) {
            scheduleClipboard = [];
            state.schedule.selectedSchedules.forEach(selKey => {
                const [date, eidStr] = selKey.split('_');
                const eid = parseInt(eidStr, 10);
                // DOM에서 position 읽기
                const cardEl = document.querySelector(`.calendar-day[data-date="${date}"] .event-card[data-employee-id="${eid}"]`);
                const pos = cardEl ? parseInt(cardEl.dataset.position, 10) : 0;
                scheduleClipboard.push({
                    employee_id: eid,
                    status: '근무',
                    _origPos: pos
                });
            });
            scheduleClipboard.sort((a, b) => (a._origPos ?? 0) - (b._origPos ?? 0));

            // 시각적 피드백
            document.querySelectorAll('.event-card.selected').forEach(el => {
                el.style.opacity = '0.5';
                setTimeout(() => el.style.opacity = '1', 200);
            });
        }
        return;
    }

    // Cut (Ctrl+X) — 원칙 7단계 (뷰별 + 연차자 특수)
    //   - 근무자: 근무→휴무, 클립보드 "근무"
    //   - 일반 휴무자(휴무자 뷰): 휴무→근무, 클립보드 "휴무"
    //   - 연차자: 내부 상태 유지 (건드리지 않음), 클립보드 "휴무"
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        if (state.schedule.selectedSchedules.size > 0) {
            pushUndoState('Cut Schedules'); // Undo 저장

            const currentView = state.schedule.viewMode || 'all';
            scheduleClipboard = [];
            state.schedule.selectedSchedules.forEach(selKey => {
                const [date, eidStr] = selKey.split('_');
                const eid = parseInt(eidStr, 10);
                const cardEl = document.querySelector(`.calendar-day[data-date="${date}"] .event-card[data-employee-id="${eid}"]`);
                const pos = cardEl ? parseInt(cardEl.dataset.position, 10) : 0;

                let sched = state.schedule.schedules.find(s => s.date === date && s.employee_id === eid);
                const isLeave = sched?.is_annual_leave === true;
                // 뷰 상황에 따른 Cut 의미 결정
                let clipboardStatus = '근무';
                if (isLeave) {
                    clipboardStatus = '휴무'; // 연차자는 시각상 휴무자 취급
                } else if (currentView === 'off' || (sched && sched.status === '휴무')) {
                    clipboardStatus = '휴무';
                }
                scheduleClipboard.push({
                    employee_id: eid,
                    status: clipboardStatus,
                    _origPos: pos
                });

                // 원본 상태 전환
                if (sched) {
                    if (isLeave) {
                        // 연차자: 상태 변경 없음 (12단계 원칙)
                    } else if (sched.status === '근무') {
                        sched.status = '휴무';
                        unsavedChanges.set(sched.id, { type: 'update', data: sched });
                    } else if (sched.status === '휴무') {
                        sched.status = '근무';
                        unsavedChanges.set(sched.id, { type: 'update', data: sched });
                    }
                } else {
                    const newSched = {
                        id: `cut-${Date.now()}-${eid}`,
                        date, employee_id: eid, status: '휴무',
                        row: Math.floor(pos / GRID_COLS), col: pos % GRID_COLS,
                        grid_position: pos, sort_order: pos, is_annual_leave: false
                    };
                    state.schedule.schedules.push(newSched);
                    unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
                }
            });
            scheduleClipboard.sort((a, b) => (a._origPos ?? 0) - (b._origPos ?? 0));
            clearSelection();
            renderCalendar();
            updateSaveButtonState();
        }
        return;
    }

    // Keyboard shortcuts are handled in the main event handler section below

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
            }
        }
        return;
    }

    // Delete / Backspace: 선택된 카드 상태 반전 (원칙 7단계: 뷰별 + 연차자 제외)
    //   - 근무자: 근무 → 휴무
    //   - 일반 휴무자: 휴무 → 근무 (휴무자 뷰에서 Del)
    //   - 연차자: 무반응
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.schedule.selectedSchedules.size > 0) {
            if (confirm(`선택한 ${state.schedule.selectedSchedules.size}개의 카드 상태를 반전하시겠습니까?`)) {
                pushUndoState('Toggle Delete'); // Undo 저장

                const currentView = state.schedule.viewMode || 'all';
                let changedCount = 0;
                state.schedule.selectedSchedules.forEach(selKey => {
                    const [date, eidStr] = selKey.split('_');
                    const eid = parseInt(eidStr, 10);
                    let sched = state.schedule.schedules.find(s => s.date === date && s.employee_id === eid);
                    if (sched) {
                        // 연차자는 무반응 (12단계 원칙)
                        if (sched.is_annual_leave) return;
                        if (sched.status === '근무') {
                            sched.status = '휴무';
                            changedCount++;
                        } else if (sched.status === '휴무') {
                            sched.status = '근무';
                            changedCount++;
                        }
                        unsavedChanges.set(sched.id, { type: 'update', data: sched });
                    } else {
                        // 레코드 없음 → 통합/근무자뷰에서 Del = 휴무 생성, 휴무자뷰에서 Del = 근무 생성
                        const cardEl = document.querySelector(`.calendar-day[data-date="${date}"] .event-card[data-employee-id="${eid}"]`);
                        const pos = cardEl ? parseInt(cardEl.dataset.position, 10) : 0;
                        const newStatus = (currentView === 'off') ? '근무' : '휴무';
                        const newSched = {
                            id: `del-${Date.now()}-${eid}`, date, employee_id: eid,
                            status: newStatus,
                            row: Math.floor(pos / GRID_COLS), col: pos % GRID_COLS,
                            grid_position: pos, sort_order: pos, is_annual_leave: false
                        };
                        state.schedule.schedules.push(newSched);
                        unsavedChanges.set(newSched.id, { type: 'create', data: newSched });
                        changedCount++;
                    }
                });
                clearSelection();
                renderCalendar();
                updateSaveButtonState();
            }
        }
    }
}

// Old Undo implementation removed to avoid duplicates

export async function renderScheduleManagement(container, isReadOnly = false, isManager = false) {

    if (!state.schedule) {
        state.schedule = {
            currentDate: dayjs().format('YYYY-MM-DD'),
            viewMode: 'working',
            teamLayout: { month: '', data: [] },
            schedules: [],
            activeDepartmentFilters: new Set(),
            companyHolidays: new Set(),
            activeReorder: { date: null, sortable: null },
            sortableInstances: [],
            selectedSchedules: new Set(),
            // 원칙 공통금지 8번: undoStack 중복 변수 금지 — 모듈 레벨 undoStack 만 사용
        };
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
        // 매니저 = 스케줄 실무 담당. 관리자와 동일 버튼 세트 사용 (확정만 월 옆 토글에서 분기)
        topControlsHtml = `
        <div class="flex justify-between items-center mb-2 pb-2 border-b">
            <div id="schedule-view-toggle" class="flex rounded-md shadow-sm bg-gray-100 p-1" role="group">
                <button type="button" data-mode="all" class="schedule-view-btn active px-4 py-2 text-sm font-medium rounded-md">통합 보기</button>
                <button type="button" data-mode="working" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md">근무자 보기</button>
                <button type="button" data-mode="off" class="schedule-view-btn px-4 py-2 text-sm font-medium rounded-md">휴무자 보기</button>
            </div>
            <div class="flex items-center gap-2">
                <button id="undo-schedule-btn" class="sch-btn sch-btn-ghost" title="이전 (Ctrl+Z)" disabled>↶ 이전</button>
                <button id="redo-schedule-btn" class="sch-btn sch-btn-ghost" title="이후 (Ctrl+Y)" disabled>↷ 이후</button>
                <button id="import-last-month-btn" class="sch-btn sch-btn-secondary">지난달 불러오기</button>
                <button id="position-reset-btn" class="sch-btn sch-btn-secondary" title="이번 달 전체 위치를 배치 패널 기본값으로">위치 초기화</button>
                <button id="work-reset-btn" class="sch-btn sch-btn-secondary" title="이번 달 전체 상태를 근무로 (위치·연차 유지)">근무 초기화</button>
                <button id="print-schedule-btn" class="sch-btn sch-btn-secondary">인쇄하기</button>
                <button id="revert-schedule-btn" class="sch-btn sch-btn-ghost" disabled>변경 취소</button>
                <button id="save-schedule-btn" class="sch-btn sch-btn-primary" disabled>스케줄 저장</button>
                <!-- 원칙 8/14: 승인 요청은 월 옆 #confirm-schedule-btn 토글로 통일 -->
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
                <button id="undo-schedule-btn" class="sch-btn sch-btn-ghost" title="이전 (Ctrl+Z)" disabled>↶ 이전</button>
                <button id="redo-schedule-btn" class="sch-btn sch-btn-ghost" title="이후 (Ctrl+Y)" disabled>↷ 이후</button>
                <button id="import-last-month-btn" class="sch-btn sch-btn-secondary">지난달 불러오기</button>
                <button id="position-reset-btn" class="sch-btn sch-btn-secondary" title="이번 달 전체 위치를 배치 패널 기본값으로">위치 초기화</button>
                <button id="work-reset-btn" class="sch-btn sch-btn-secondary" title="이번 달 전체 상태를 근무로 (위치·연차 유지)">근무 초기화</button>
                <button id="print-schedule-btn" class="sch-btn sch-btn-secondary">인쇄하기</button>
                <button id="revert-schedule-btn" class="sch-btn sch-btn-ghost" disabled>변경 취소</button>
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
                    <div class="flex items-center gap-2">
                        <h2 id="calendar-title" class="text-2xl font-bold"></h2>
                        <!-- 원칙 8/14단계: 월 연월 옆 확정 토글 (관리자만 노출). 배지 역할도 겸함. -->
                        <button id="confirm-schedule-btn" class="hidden sch-confirm-toggle" type="button" aria-pressed="false"></button>
                        <span id="schedule-deadline-icon" class="text-xl hidden" title="확정 기준일(전월 15일) 경과 - 미확정">⚠️</span>
                    </div>
                    <button id="calendar-next" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">다음 ▶</button>
                    <button id="calendar-today" class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700">오늘</button>
                </div>
                <div id="pure-calendar"></div>
            </div>
            ${sidebarHtml}
        </div>
    `;


    _('#schedule-view-toggle')?.addEventListener('click', handleViewModeChange);
    _('#department-filters')?.addEventListener('change', handleDepartmentFilterChange);
    _('#print-schedule-btn')?.addEventListener('click', handlePrintSchedule); // Always available

    // Only attach these if not read-only
    if (!isReadOnly) {
        _('#save-schedule-btn')?.addEventListener('click', handleSaveSchedules);
        _('#revert-schedule-btn')?.addEventListener('click', handleRevertChanges);
        _('#undo-schedule-btn')?.addEventListener('click', undoLastChange);
        _('#redo-schedule-btn')?.addEventListener('click', redoLastChange);
        _('#position-reset-btn')?.addEventListener('click', handlePositionReset);
        _('#work-reset-btn')?.addEventListener('click', handleWorkReset);
        _('#reset-schedule-btn')?.addEventListener('click', handleResetSchedule); // legacy (button removed from UI)
        _('#import-last-month-btn')?.addEventListener('click', handleImportPreviousMonth);
        _('#sync-appsheet-btn')?.addEventListener('click', syncToAppSheet);
        _('#import-appsheet-btn')?.addEventListener('click', importFromAppSheet);
        _('#appsheet-settings-btn')?.addEventListener('click', handleAppSheetSettings);

        // 매니저 승인 요청은 #confirm-schedule-btn 토글에서 처리 (역할별 분기는 checkScheduleConfirmationStatus 참고)
    }

    _('#calendar-prev')?.addEventListener('click', () => navigateMonth('prev'));
    _('#calendar-next')?.addEventListener('click', () => navigateMonth('next'));
    _('#calendar-today')?.addEventListener('click', () => navigateMonth('today'));


    try {
        await loadAndRenderScheduleData(state.schedule.currentDate);
        updateViewModeButtons();
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

    // 활성 직원 필터링 + 부서 순서 정렬 (단일 헬퍼 sortByDeptOrder 위임)
    const employees = state.management?.employees || [];
    let targetEmployees = employees.filter(emp => isGridEmployee(emp));

    const savedLayout = state.schedule?.teamLayout?.data?.[0];
    if (savedLayout?.members?.length > 0) {
        const activeMembers = new Set(savedLayout.members.filter(id => id > 0));
        targetEmployees = targetEmployees.filter(emp => activeMembers.has(emp.id));
    }

    // 검수칸 표시 순서 = 사이드바 부서 풀과 동일 (부서 순서 + 부서 내 ID 순)
    targetEmployees = sortByDeptOrder(targetEmployees);

    // 직원별 검수
    const rows = targetEmployees.map(emp => {
        const rules = emp.regular_holiday_rules;
        const parsedRules = parseHolidayRules(rules);

        // 의무 근무일 = 영업일 중 고정 휴무가 아닌 날 수 (주차별 규칙 반영)
        const empWorkDays = emp.weekly_work_days || 5;
        let expected;
        if (parsedRules.length > 0) {
            // 고정 휴무 규칙 있음 → 영업일에서 고정 휴무일 제외
            expected = 0;
            businessDays.forEach(dateStr => {
                const dayIdx = dayjs(dateStr).day();
                if (!isFixedOffDay(rules, dayIdx, dateStr)) {
                    expected++;
                }
            });
        } else {
            // 규칙 없음 → 기존 방식: min(주근무일수, 영업일수)
            expected = Math.min(empWorkDays, businessDayCount);
        }

        // 실제 근무일 카운트 + 비정상 휴무 수집
        let workCount = 0;
        let leaveCount = 0;
        const unexpectedOffNames = []; // 고정 휴무가 아닌데 쉬는 요일
        businessDays.forEach(dateStr => {
            const status = getEmployeeStatusOnDate(emp.id, dateStr);
            if (status === 'working') {
                workCount++;
            } else if (status === 'leave') {
                workCount++; // 연차 = 유급휴무 → 근무일수에 포함
                leaveCount++;
            } else {
                const dayIdx = dayjs(dateStr).day();
                if (!isFixedOffDay(rules, dayIdx, dateStr)) {
                    unexpectedOffNames.push(weekDayNames[dayIdx]);
                }
            }
        });

        // 공휴일이 근무일에 겹칠 때 대체가능 고정 휴무일 확인
        const holidayOnWorkDay = businessDays.filter(dateStr => {
            const dayIdx = dayjs(dateStr).day();
            return holidays.has(dateStr) && !isFixedOffDay(rules, dayIdx, dateStr);
        });
        let subAvailable = false;
        if (holidayOnWorkDay.length > 0) {
            subAvailable = parsedRules.some(r => r.sub !== false);
        }

        const diff = workCount - expected;
        const hasLeave = leaveCount > 0;

        // 색상: 부족+대체가능=노란, 부족=빨간, 초과근무=초록, 연차사용주간=파란, 정상=없음
        let bgColor = 'transparent';
        let diffColor = '#6b7280';
        if (diff < 0) {
            if (subAvailable) {
                bgColor = '#fef3c7'; diffColor = '#d97706';
            } else {
                bgColor = '#fee2e2'; diffColor = '#dc2626';
            }
        } else if (diff > 0) {
            // 초과 근무 (의무 근무일보다 더 일함)
            bgColor = '#f0fdf4'; diffColor = '#16a34a';
        } else if (hasLeave) {
            // 연차가 근무로 카운트되어 diff=0이지만 연차 사용 주간 표시
            bgColor = '#dbeafe'; diffColor = '#2563eb';
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

    const errorCount = rows.filter(r => r.diff < 0).length;
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
    const DIRECTOR_DEPT_ID = 4; // 원장 부서 ID

    // 부서 색상 맵 + 원장 여부 맵
    const deptColorMap = {};
    const isDirectorMap = {};
    allEmployees.forEach(emp => {
        if (emp.departments?.id) deptColorMap[emp.id] = getDepartmentColor(emp.departments.id);
        if (emp.department_id === DIRECTOR_DEPT_ID) isDirectorMap[emp.id] = true;
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
                if (s.employee_id <= 0) return; // 레거시 스페이서 레코드 skip (원칙 11단계)
                const emp = allEmployees.find(e => e.id === s.employee_id);
                if (!emp) return;

                const pos = (s.grid_position >= 0 && s.grid_position < GRID_SIZE) ? s.grid_position : null;
                if (pos == null) return;

                if (viewMode === 'working' && s.status !== '근무') return;
                if (viewMode === 'off' && s.status !== '휴무' && s.status !== '연차') return;

                const status = s.status === '연차' ? 'leave' : s.status === '휴무' ? 'off' : 'working';
                const isDirector = !!isDirectorMap[emp.id];
                gridSlots[pos] = { name: emp.name, color: deptColorMap[emp.id] || '#999', status, isDirector };
            });

            // 끝에서부터 빈 슬롯 제거 (인쇄 공간 절약)
            let lastFilled = -1;
            for (let i = GRID_SIZE - 1; i >= 0; i--) {
                if (gridSlots[i]) { lastFilled = i; break; }
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
            if (!n) return `<span class="p-name p-empty"></span>`;
            let cls = n.status === 'leave' ? ' p-leave' : n.status === 'off' ? ' p-off' : '';
            if (n.isDirector) cls += ' p-director';
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
            if (day.isHoliday && day.isCurrentMonth) cls += ' p-holiday';

            const dateLabel = `<div class="p-date">${day.date}</div>`;
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
@page { size: A4 landscape; margin: 4mm; }
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height:100%; }
body { font-family: 'Pretendard','맑은 고딕',sans-serif; background:#fff; padding:4mm; display:flex; flex-direction:column; }
h1 { text-align:center; font-size:12pt; margin-bottom:0; font-weight:700; line-height:1.2; }
.p-sub { text-align:center; font-size:7pt; color:#999; margin-bottom:1mm; }
.p-table { width:100%; border-collapse:collapse; table-layout:fixed; flex:1; }
.p-table th { background:#1a1a1a; color:#fff; font-size:9pt; padding:1px; text-align:center; border:1px solid #1a1a1a; font-weight:600; }
.p-table th.p-sat { background:#1e40af; }
.p-table td { border:1px solid #bbb; vertical-align:top; padding:1px 2px; font-size:8pt; }
.p-table tr { page-break-inside:avoid; }
.p-date { font-weight:700; font-size:9pt; padding:0 2px; border-bottom:1px solid #ddd; margin-bottom:1px; color:#1a1a1a; }
/* 전월/익월 날짜 — 셀 전체 흐리게 */
.p-other { background:#f8f8f8; opacity:0.4; }
.p-other .p-date { color:#aaa; }
.p-sat .p-date { color:#1e40af; }
.p-holiday { background:#fff5f5; }
.p-holiday .p-date { color:#dc2626; }
.p-names { display:grid; grid-template-columns:repeat(${GRID_COLS},1fr); gap:0; }
.p-name { font-size:8pt; padding:0 1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.3; display:flex; align-items:center; gap:1px; }
.p-name i { display:inline-block; width:5px; height:5px; border-radius:50%; flex-shrink:0; }
.p-empty { visibility:hidden; }
/* 원장 이름 강조 — 파란색 볼드 */
.p-director { color:#1e40af; font-weight:700; }
.p-leave { color:#b45309; font-style:italic; }
.p-off { color:#999; text-decoration:line-through; }
@media print {
    body { padding:0; height:100vh; }
    h1 { font-size:11pt; }
    .p-table { flex:1; }
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

// 원칙 14단계: 확정 기준일 = 전월 15일. 해당 월이 "M월"일 때 오늘이 (M-1)월 15일 이후면 미확정 = 경고.
function isPastConfirmDeadline(viewDate) {
    const viewMonth = dayjs(viewDate).startOf('month');
    const deadline = viewMonth.subtract(1, 'month').date(15); // 전월 15일
    return dayjs().isAfter(deadline, 'day') || dayjs().isSame(deadline, 'day');
}

// 세션당 1회 알림 기록 (월 단위)
const confirmDeadlineWarned = new Set();

async function checkScheduleConfirmationStatus() {
    const viewDate = state.schedule.currentDate || dayjs().format('YYYY-MM-DD');
    const month = dayjs(viewDate).format('YYYY-MM');

    try {
        const { data, error } = await db.from('schedule_confirmations')
            .select('*')
            .eq('month', month)
            .maybeSingle();

        const confirmBtn = document.querySelector('#confirm-schedule-btn');
        const deadlineIcon = document.querySelector('#schedule-deadline-icon');

        // 승인 요청 배너 (관리자 전용 — 승인/반려 버튼 포함)
        const existingBanner = document.querySelector('#approval-request-banner');
        if (existingBanner) existingBanner.remove();

        const isAdmin = !!(state.currentUser?.role === 'admin' || state.currentUser?.isAdmin);
        const isManager = !!(state.currentUser?.isManager);

        if (data && data.approval_requested && !data.is_confirmed && isAdmin) {
            const banner = document.createElement('div');
            banner.id = 'approval-request-banner';
            banner.className = 'bg-orange-50 border border-orange-300 rounded-lg p-3 mb-3 flex items-center justify-between';
            banner.innerHTML = `
                <div>
                    <span class="font-bold text-orange-700">승인 요청</span>
                    <span class="text-sm text-orange-600 ml-2">${data.requested_by || '매니저'}님이 ${month} 스케줄 확정을 요청했습니다 (${data.requested_at ? dayjs(data.requested_at).format('MM/DD HH:mm') : ''})</span>
                </div>
                <div class="flex gap-2">
                    <button id="banner-approve-btn" class="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700">✅ 승인 (확정)</button>
                    <button id="banner-reject-btn" class="px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700">❌ 반려</button>
                </div>
            `;
            const calendarArea = document.querySelector('.schedule-main-content');
            if (calendarArea) calendarArea.prepend(banner);
            _('#banner-approve-btn')?.addEventListener('click', () => handleConfirmSchedule(true));
            _('#banner-reject-btn')?.addEventListener('click', () => handleRejectScheduleApproval(month));
        }

        const isConfirmed = !!(data && data.is_confirmed);
        const approvalRequested = !!(data && data.approval_requested);
        const pastDeadline = isPastConfirmDeadline(viewDate);

        // 원칙 8/14: 월 옆 확정 토글 — 역할별 의미 분기
        //  - 관리자: ⚪ 미확정(확정) / 📩 승인요청됨(확정) / ✅ 확정됨(해제)
        //  - 매니저: 📤 승인요청 / ⏳ 승인 대기(요청취소) / ✅ 확정됨(정보표시 비활성)
        //  - 직원: 숨김
        if (confirmBtn) {
            if (state.schedule.isReadOnly || (!isAdmin && !isManager)) {
                confirmBtn.classList.add('hidden');
            } else if (isAdmin) {
                confirmBtn.classList.remove('hidden');
                confirmBtn.disabled = false;
                confirmBtn.setAttribute('aria-pressed', isConfirmed ? 'true' : 'false');
                if (isConfirmed) {
                    confirmBtn.textContent = '✅ 확정됨';
                    confirmBtn.title = '클릭하여 확정 해제';
                    confirmBtn.className = 'sch-confirm-toggle is-confirmed ml-2 px-3 py-1 rounded-full text-sm font-bold bg-green-600 text-white hover:bg-green-700 transition-colors';
                    confirmBtn.onclick = () => handleConfirmSchedule(false);
                } else if (approvalRequested) {
                    confirmBtn.textContent = '📩 승인 요청됨';
                    confirmBtn.title = '클릭하여 확정 (또는 상단 배너에서 반려)';
                    confirmBtn.className = 'sch-confirm-toggle is-approval-requested ml-2 px-3 py-1 rounded-full text-sm font-bold bg-orange-500 text-white hover:bg-orange-600 transition-colors';
                    confirmBtn.onclick = () => handleConfirmSchedule(true);
                } else {
                    confirmBtn.textContent = '⚪ 미확정';
                    confirmBtn.title = '클릭하여 스케줄 확정';
                    confirmBtn.className = 'sch-confirm-toggle is-unconfirmed ml-2 px-3 py-1 rounded-full text-sm font-bold bg-yellow-400 text-yellow-900 hover:bg-yellow-500 transition-colors';
                    confirmBtn.onclick = () => handleConfirmSchedule(true);
                }
            } else if (isManager) {
                confirmBtn.classList.remove('hidden');
                confirmBtn.disabled = false;
                if (isConfirmed) {
                    confirmBtn.textContent = '✅ 확정됨';
                    confirmBtn.title = '관리자가 확정함 (해제는 관리자 권한)';
                    confirmBtn.className = 'sch-confirm-toggle is-confirmed ml-2 px-3 py-1 rounded-full text-sm font-bold bg-green-100 text-green-700 cursor-default border border-green-300';
                    confirmBtn.disabled = true;
                    confirmBtn.onclick = null;
                } else if (approvalRequested) {
                    confirmBtn.textContent = '⏳ 승인 대기 중';
                    confirmBtn.title = '클릭하여 승인 요청 취소';
                    confirmBtn.className = 'sch-confirm-toggle is-pending ml-2 px-3 py-1 rounded-full text-sm font-bold bg-orange-100 text-orange-700 hover:bg-orange-200 border border-orange-300';
                    confirmBtn.onclick = () => handleCancelScheduleApprovalRequest(month);
                } else {
                    confirmBtn.textContent = '📤 승인 요청';
                    confirmBtn.title = '관리자에게 스케줄 승인 요청';
                    confirmBtn.className = 'sch-confirm-toggle is-request ml-2 px-3 py-1 rounded-full text-sm font-bold bg-blue-500 text-white hover:bg-blue-600 transition-colors';
                    confirmBtn.onclick = () => handleRequestScheduleApproval();
                }
            }
        }

        // 원칙 14단계: 기준일(전월 15일) 경과 + 미확정 → 경고 아이콘 상시 표시
        if (deadlineIcon) {
            if (!isConfirmed && pastDeadline) {
                deadlineIcon.classList.remove('hidden');
                deadlineIcon.title = `${month} 스케줄이 아직 확정되지 않았습니다 (기준일: 전월 15일).`;
            } else {
                deadlineIcon.classList.add('hidden');
            }
        }

        // 원칙 14단계: 관리자 로그인 세션당 1회 팝업 (미확정 + 기준일 경과일 때)
        if (!isConfirmed && pastDeadline && isAdmin && !confirmDeadlineWarned.has(month)) {
            confirmDeadlineWarned.add(month);
            setTimeout(() => {
                alert(`⚠️ ${month} 스케줄이 아직 확정되지 않았습니다.\n\n확정 기준일(전월 15일)이 지났습니다. 월 연월 옆 토글 버튼을 눌러 확정해주세요.`);
            }, 300);
        }
    } catch (err) {
        console.error('확정 상태 확인 실패:', err);
    }
}

// 매니저: 승인 요청 취소
async function handleCancelScheduleApprovalRequest(month) {
    if (!confirm(`${month} 스케줄 승인 요청을 취소하시겠습니까?`)) return;
    try {
        const { error } = await db.from('schedule_confirmations').upsert({
            month,
            approval_requested: false,
            requested_by: null,
            requested_at: null
        }, { onConflict: 'month' });
        if (error) throw error;
        await checkScheduleConfirmationStatus();
    } catch (e) {
        console.error('승인 요청 취소 실패:', e);
        alert('승인 요청 취소 실패: ' + e.message);
    }
}

// 관리자: 매니저 승인 요청 반려 (사유 기록)
async function handleRejectScheduleApproval(month) {
    const reason = prompt(`${month} 스케줄 승인 요청을 반려합니다.\n\n반려 사유 (선택):`, '');
    if (reason === null) return;
    const adminName = state.currentUser?.name || '관리자';
    try {
        const { error } = await db.from('schedule_confirmations').upsert({
            month,
            approval_requested: false,
            requested_by: null,
            requested_at: null,
            rejected_at: new Date().toISOString(),
            rejection_reason: reason || null,
            rejected_by: adminName,
            is_confirmed: false
        }, { onConflict: 'month' });
        if (error) throw error;
        alert(`${month} 스케줄 승인 요청을 반려했습니다.\n매니저가 수정 후 다시 요청할 수 있습니다.`);
        await checkScheduleConfirmationStatus();
    } catch (e) {
        console.error('반려 실패:', e);
        alert('반려 실패: ' + e.message);
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
        // upsert: 이전 반려 정보는 클리어 (새 사이클 시작)
        const { error } = await db.from('schedule_confirmations').upsert({
            month: month,
            is_confirmed: false,
            approval_requested: true,
            requested_by: managerName,
            requested_at: new Date().toISOString(),
            rejected_at: null,
            rejection_reason: null,
            rejected_by: null
        }, { onConflict: 'month' });

        if (error) {
            console.error('승인 요청 실패:', error);
            alert(`${month} 스케줄 승인 요청이 전송되었습니다.\n관리자가 스케줄 관리 탭에서 확인 후 확정합니다.`);
            return;
        }

        alert(`${month} 스케줄 승인 요청 완료!\n\n관리자가 스케줄 관리 탭에서 확인 후 확정합니다.`);
        await checkScheduleConfirmationStatus();
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
        // 확정 시 승인요청·반려 정보 모두 클리어 (사이클 종료)
        const { error } = await db.from('schedule_confirmations')
            .upsert({
                month: month,
                is_confirmed: isConfirm,
                confirmed_at: new Date().toISOString(),
                approval_requested: false,
                requested_by: null,
                requested_at: null,
                rejected_at: null,
                rejection_reason: null,
                rejected_by: null
            }, { onConflict: 'month' });

        if (error) throw error;

        alert(isConfirm ? '스케줄이 확정되었습니다.' : '스케줄 확정이 해제되었습니다.');
        checkScheduleConfirmationStatus();

    } catch (error) {
        console.error('스케줄 확정 오류:', error);
        alert('오류가 발생했습니다: ' + error.message);
    }
}

// =========================================================================================
// [원칙 13단계] 지난달 스케줄 불러오기 — 금요일 앵커 주차 매칭
// 주차 = 그 주의 금요일이 속한 달. 한 주는 그 주의 금요일이 속한 달에 배정됨.
// =========================================================================================

/** 주어진 날짜가 속한 주(일~토)의 금요일 정보 반환 */
function fridayAnchorInfo(dateStr) {
    const d = dayjs(dateStr);
    const dow = d.day(); // 0=Sun ~ 6=Sat
    const friday = d.add(5 - dow, 'day');
    const fridayMonthStr = friday.format('YYYY-MM');
    // 금요일의 "그 달 몇 번째 금요일" 계산
    let firstFri = friday.startOf('month');
    while (firstFri.day() !== 5) firstFri = firstFri.add(1, 'day');
    const weekOfMonth = Math.floor(friday.diff(firstFri, 'day') / 7) + 1;
    return { fridayMonth: fridayMonthStr, weekOfMonth, friday: friday.format('YYYY-MM-DD') };
}

async function handleImportPreviousMonth() {
    if (!confirm('현재 보고 있는 달의 스케줄에 지난달 주간 패턴(금요일 앵커 기준)을 적용하시겠습니까?\n(이번 달 현재 데이터는 덮어씌워집니다)')) {
        return;
    }

    const importBtn = _('#import-last-month-btn');
    importBtn.disabled = true;
    importBtn.textContent = '불러오는 중...';

    try {
        const currentDate = dayjs(state.schedule.currentDate);
        const prevDate = currentDate.subtract(1, 'month');
        const currentMonthStr = currentDate.format('YYYY-MM');
        const prevMonthStr = prevDate.format('YYYY-MM');
        const currentStart = currentDate.startOf('month');
        const currentEnd = currentDate.endOf('month');

        // 1. 지난달 + 이번달 경계 확장 데이터 가져오기 (주가 월경계 걸치는 경우 대비)
        const fetchStart = prevDate.startOf('month').subtract(7, 'day').format('YYYY-MM-DD');
        const fetchEnd = currentDate.endOf('month').add(7, 'day').format('YYYY-MM-DD');
        const { data: prevSchedulesRaw, error: fetchError } = await db.from('schedules')
            .select('*')
            .gte('date', fetchStart)
            .lte('date', fetchEnd)
            .eq('status', '근무');
        if (fetchError) throw fetchError;
        const allPrevSchedules = (prevSchedulesRaw || []).map(hydrateScheduleRow);

        // 2. 지난달 소스: "해당 날짜의 주차 금요일이 prevMonth"인 근무 레코드만 사용
        const prevByWeekDow = new Map(); // key = "weekN_dow" → sourceDateStr
        const prevDates = new Set(allPrevSchedules.map(s => s.date));
        prevDates.forEach(dateStr => {
            const info = fridayAnchorInfo(dateStr);
            if (info.fridayMonth !== prevMonthStr) return;
            const key = `w${info.weekOfMonth}_d${dayjs(dateStr).day()}`;
            if (!prevByWeekDow.has(key)) prevByWeekDow.set(key, dateStr);
        });

        // 3. fallback 주차(2주차) 패턴 수집
        const prevWeek2Dates = new Map(); // dow → sourceDateStr
        prevDates.forEach(dateStr => {
            const info = fridayAnchorInfo(dateStr);
            if (info.fridayMonth !== prevMonthStr || info.weekOfMonth !== 2) return;
            const dow = dayjs(dateStr).day();
            if (!prevWeek2Dates.has(dow)) prevWeek2Dates.set(dow, dateStr);
        });

        // 4. 삭제할 이번달 날짜 = "해당 날짜의 주차 금요일이 currentMonth"
        const targetDates = [];
        let iter = currentStart.clone();
        while (iter.isSameOrBefore(currentEnd)) {
            const ds = iter.format('YYYY-MM-DD');
            if (fridayAnchorInfo(ds).fridayMonth === currentMonthStr) targetDates.push(ds);
            iter = iter.add(1, 'day');
        }
        if (targetDates.length === 0) {
            alert('복사할 대상 날짜가 없습니다.');
            return;
        }

        // 5. 대상 날짜 DB 스케줄 삭제
        const { error: deleteError } = await db.from('schedules')
            .delete()
            .in('date', targetDates);
        if (deleteError) throw deleteError;
        unsavedChanges.clear();

        // 6. 새 스케줄 생성 — 주차 매칭 or fallback
        const newSchedules = [];
        const allEmployees = state.management.employees.filter(e => isGridEmployee(e));

        targetDates.forEach(targetDateStr => {
            const info = fridayAnchorInfo(targetDateStr);
            const dow = dayjs(targetDateStr).day();
            const key = `w${info.weekOfMonth}_d${dow}`;
            let sourceDateStr = prevByWeekDow.get(key);
            if (!sourceDateStr) sourceDateStr = prevWeek2Dates.get(dow); // fallback 2주차

            let schedulesForDay = [];
            if (sourceDateStr) {
                const sourceSchedules = allPrevSchedules.filter(s => s.date === sourceDateStr);
                sourceSchedules.forEach(src => {
                    if (allEmployees.some(e => e.id === src.employee_id
                        && (!e.resignation_date || targetDateStr < e.resignation_date))) {
                        schedulesForDay.push({
                            date: targetDateStr,
                            employee_id: src.employee_id,
                            status: '근무',
                            sort_order: src.sort_order,
                            row: src.row, col: src.col,
                            grid_position: src.grid_position
                        });
                    }
                });
            }

            // 매칭 0명이면 전원 근무 + 정기 휴무 반영
            if (schedulesForDay.length === 0) {
                let positionCounter = 0;
                allEmployees.filter(emp => isActiveOnDate(emp, targetDateStr)).forEach(emp => {
                    if (!isFixedOffDay(emp.regular_holiday_rules, dow, targetDateStr)) {
                        schedulesForDay.push({
                            date: targetDateStr,
                            employee_id: emp.id,
                            status: '근무',
                            sort_order: positionCounter,
                            row: Math.floor(positionCounter / GRID_COLS),
                            col: positionCounter % GRID_COLS,
                            grid_position: positionCounter
                        });
                        positionCounter++;
                    }
                });
            }
            newSchedules.push(...schedulesForDay);
        });


        // 5. DB에 일괄 저장
        if (newSchedules.length > 0) {
            const BATCH_SIZE = 100;
            for (let i = 0; i < newSchedules.length; i += BATCH_SIZE) {
                const batch = newSchedules.slice(i, i + BATCH_SIZE).map(serializeScheduleForDb);
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

