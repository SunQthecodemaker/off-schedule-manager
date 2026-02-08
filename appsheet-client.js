import { db, state } from './state.js';
import { _ } from './utils.js';

// LocalStorage Key
const KEY_SCRIPT_URL = 'appsheet_script_url';

export function getScriptUrl() {
    return localStorage.getItem(KEY_SCRIPT_URL) || '';
}

export function setScriptUrl(url) {
    localStorage.setItem(KEY_SCRIPT_URL, url.trim());
}

/**
 * 1. Supabase 데이터를 구글 시트로 전송 (Data, Leaves 시트 갱신)
 */
export async function syncToAppSheet() {
    const scriptUrl = getScriptUrl();
    if (!scriptUrl) {
        alert('AppSheet 스크립트 URL이 설정되지 않았습니다.\n설정 버튼을 눌러 URL을 입력해주세요.');
        return;
    }

    try {
        // 1. 직원 목록 준비
        const { data: employees, error: empError } = await db.from('employees')
            .select('id, name, department_id, is_temp, resignation_date')
            .is('resignation_date', null)
            .eq('is_temp', false); // 정규직만 (임시직 제외)

        if (empError) throw empError;

        // 2. 승인된 연차 준비 (이번달 + 다음달 데이터 정도만?) -> 전체 다 보내거나 기간 설정 필요
        // 일단 현재 보고 있는 월의 앞뒤 2달 정도를 보내자.
        // 하지만 시트 생성 로직이 "Data" 시트의 설정(년월)을 따른다면, 그 달의 연차가 필요함.
        // 넉넉하게 이번달 기준 -1달 ~ +2달
        const currentDate = dayjs(state.schedule.currentDate);
        const startStr = currentDate.subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
        const endStr = currentDate.add(2, 'month').endOf('month').format('YYYY-MM-DD');

        const { data: leaves, error: leaveError } = await db.from('leave_requests')
            .select('*')
            .or('status.eq.approved,final_manager_status.eq.approved'); // 승인된 건만

        if (leaveError) throw leaveError;

        // 연차 날짜 펼치기
        const flatLeaves = [];
        leaves.forEach(req => {
            if (req.dates && Array.isArray(req.dates)) {
                req.dates.forEach(d => {
                    // 해당 기간 내의 연차만
                    if (d >= startStr && d <= endStr) {
                        const emp = employees.find(e => e.id === req.employee_id);
                        if (emp) {
                            flatLeaves.push({
                                name: emp.name,
                                date: d,
                                reason: req.reason
                            });
                        }
                    }
                });
            }
        });

        const payload = {
            action: 'syncData',
            employees: employees.map(e => ({ name: e.name, department_id: e.department_id })),
            leaves: flatLeaves
        };

        const response = await fetch(scriptUrl, {
            method: 'POST',
            mode: 'no-cors', // 불투명 응답 (성공 여부 알 수 없음)
            headers: {
                'Content-Type': 'text/plain;charset=utf-8',
            },
            body: JSON.stringify(payload)
        });

        alert('데이터 전송을 요청했습니다.\n(잠시 후 시트에서 데이터가 갱신되었는지 확인하세요)');

    } catch (error) {
        console.error('Sync Error:', error);
        alert('데이터 전송 실패: ' + error.message);
    }
}

/**
 * 2. [변경] 앱시트(엑셀) 복사 데이터를 붙여넣어 스케줄 가져오기
 *    - 원장, 진료실 부서만 업데이트
 *    - 개선: 월 선택, 미리보기 그리드 제공 + ✨ 그리드 포지션 반영 (4칸 기준)
 */
export async function importFromAppSheet() {
    // 1. 모달 생성 (붙여넣기 입력창 + 미리보기 존)
    const currentMonthStr = dayjs(state.schedule.currentDate).format('YYYY-MM');

    // ✨ UI 개선: 
    // - h-[85vh]로 높이 고정
    // - Flex 구조로 헤더/바디/푸터 분리: 불필요시 바디 내에서 스크롤 처리
    // - Textarea: overflow-auto, flex-1 적용하여 남는 공간만 차지하고 스크롤 생김
    const modalHtml = `
        <div id="paste-import-modal" class="fixed inset-0 bg-gray-600 bg-opacity-70 flex items-center justify-center z-[9999]">
            <div class="bg-white rounded-xl shadow-2xl w-[95%] max-w-7xl h-[85vh] flex flex-col overflow-hidden">
                <!-- 헤더 -->
                <div class="flex justify-between items-center p-4 border-b bg-gray-50 flex-shrink-0">
                    <div>
                        <h3 class="text-xl font-bold text-gray-800">📆 앱시트 스케줄 가져오기</h3>
                        <p class="text-xs text-gray-500 mt-1">앱시트의 "배치(행/열)"를 그대로 반영하여 가져옵니다.</p>
                    </div>
                    <button id="close-modal-x" class="text-gray-400 hover:text-gray-600 text-3xl leading-none">&times;</button>
                </div>

                <!-- 바디 (2단 컬럼) -->
                <div class="flex-1 flex overflow-hidden">
                    
                    <!-- 왼쪽: 입력 (40%) -->
                    <div class="w-2/5 flex flex-col border-r p-4 bg-white h-full relative">
                        <div class="flex-shrink-0 mb-4 space-y-3">
                            <div>
                                <label class="block font-bold text-gray-700 mb-1">1. 적용할 월 선택 (기준 월)</label>
                                <input type="month" id="import-month" value="${currentMonthStr}" class="border border-gray-300 rounded px-3 py-2 w-full focus:ring-2 focus:ring-purple-500 outline-none">
                            </div>
                            
                            <div class="flex items-center justify-between">
                                <label class="font-bold text-gray-700">2. 데이터 붙여넣기</label>
                                <label class="flex items-center space-x-2 text-xs text-gray-600 cursor-pointer select-none bg-gray-100 px-2 py-1 rounded hover:bg-gray-200">
                                    <input type="checkbox" id="wrap-toggle" class="form-checkbox h-3 w-3 text-purple-600 rounded">
                                    <span>줄바꿈 보기</span>
                                </label>
                            </div>
                            <p class="text-xs text-gray-500 bg-blue-50 p-2 rounded text-blue-700 leading-tight">
                                💡 팁: 앱시트에서 <strong>날짜 행을 포함하여</strong> 드래그 복사하세요.<br>
                                요일(예: 월, 화) 정보가 포함되어야 날짜가 정확히 매핑됩니다.
                            </p>
                        </div>

                        <!-- 텍스트 영역: 남는 높이 모두 차지 + 스크롤 -->
                        <div class="flex-1 relative border border-gray-300 rounded overflow-hidden shadow-inner">
                            <textarea id="paste-area" class="absolute inset-0 w-full h-full p-3 font-mono text-xs outline-none resize-none whitespace-pre overflow-auto focus:bg-gray-50 transition-colors" placeholder="여기에 엑셀/앱시트 데이터를 붙여넣으세요..."></textarea>
                        </div>

                        <!-- 분석 버튼 -->
                        <button id="analyze-paste-btn" class="mt-4 w-full py-4 bg-purple-600 text-white rounded-lg font-bold text-lg hover:bg-purple-700 shadow-md transition-transform transform active:scale-95 flex-shrink-0">
                            🔍 데이터 분석하기
                        </button>
                    </div>

                    <!-- 오른쪽: 미리보기 (60%) -->
                    <div class="w-3/5 flex flex-col p-4 bg-gray-50 h-full overflow-hidden">
                        <div class="flex justify-between items-center mb-2 flex-shrink-0">
                            <h4 class="font-bold text-gray-700">3. 미리보기 및 적용</h4>
                            <span id="preview-count" class="text-sm font-bold text-purple-600 bg-purple-100 px-2 py-0.5 rounded-full"></span>
                        </div>

                        <!-- 미리보기 컨테이너: 스크롤 영역 -->
                        <div id="preview-container" class="flex-1 border rounded-lg bg-white overflow-auto shadow-sm p-2">
                            <div class="h-full flex flex-col items-center justify-center text-gray-400 space-y-4">
                                <svg class="w-16 h-16 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                                <p>왼쪽에 데이터를 붙여넣고 [분석하기]를 눌러주세요.</p>
                            </div>
                        </div>

                        <!-- 적용 버튼 영역 (분석 후 표시) - 고정됨 -->
                        <div id="preview-actions" class="mt-4 hidden flex-shrink-0 z-10">
                            <div class="flex items-center justify-between p-3 bg-white rounded-lg border border-green-100 shadow-sm">
                                <p class="text-xs text-red-500 font-bold flex items-center">
                                    <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                                    주의: 해당 월의 기존 스케줄은 모두 덮어쓰기 됩니다.
                                </p>
                                <button id="apply-import-btn" class="px-8 py-3 bg-green-600 text-white rounded-lg font-bold text-base hover:bg-green-700 shadow flex items-center transition-colors">
                                    <span>✅ 스케줄 최종 적용</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // 요소 참조
    const modal = document.getElementById('paste-import-modal');
    const closeBtn = document.getElementById('close-modal-x');
    const textarea = document.getElementById('paste-area');
    const wrapToggle = document.getElementById('wrap-toggle');
    const analyzeBtn = document.getElementById('analyze-paste-btn');
    const previewContainer = document.getElementById('preview-container');
    const previewActions = document.getElementById('preview-actions');
    const applyBtn = document.getElementById('apply-import-btn');
    const monthInput = document.getElementById('import-month');
    const previewCount = document.getElementById('preview-count');

    textarea.focus();

    // 상태 저장 변수
    let parsedDataResult = null;

    const closeModal = () => modal.remove();
    closeBtn.onclick = closeModal;

    // ✨ 줄바꿈 토글 핸들러
    wrapToggle.onchange = (e) => {
        if (e.target.checked) {
            textarea.classList.remove('whitespace-pre', 'overflow-auto');
            textarea.classList.add('whitespace-pre-wrap', 'overflow-y-auto');
        } else {
            textarea.classList.remove('whitespace-pre-wrap', 'overflow-y-auto');
            textarea.classList.add('whitespace-pre', 'overflow-auto');
        }
    };

    // 분석 버튼 핸들러
    analyzeBtn.onclick = () => {
        const text = textarea.value;
        const targetMonth = monthInput.value; // YYYY-MM
        if (!text.trim()) {
            alert('데이터를 붙여넣어주세요.');
            return;
        }

        try {
            parsedDataResult = analyzePastedText(text, targetMonth);
            renderPreview(parsedDataResult);
        } catch (err) {
            console.error(err);
            alert('분석 실패: ' + err.message);
        }
    };

    // 적용 버튼 핸들러
    applyBtn.onclick = async () => {
        if (!parsedDataResult || parsedDataResult.schedules.length === 0) {
            alert('적용할 데이터가 없습니다.');
            return;
        }
        try {
            if (confirm(`총 ${parsedDataResult.schedules.length}건의 스케줄을 실제 시스템에 적용하시겠습니까?\n\n(❗️ 해당 기간의 기존 스케줄은 삭제됩니다)`)) {
                await applyImportedSchedules(parsedDataResult.schedules);
                closeModal();
            }
        } catch (err) {
            alert('저장 실패: ' + err.message);
        }
    };
}

/**
 * 텍스트 분석 로직
 * ✨ 1. 요일(수, 목)을 확인하여 월(Month) 자동 보정 (3/1이 일요일인데 1(수)라면 4월로 인식)
 * ✨ 2. 날짜 간격을 계산하여 Column Span 자동 감지
 */
function analyzePastedText(text, targetMonthStr) {
    const lines = text.split('\n').map(l => l.trimEnd());

    // 기준 월 설정
    const baseDate = dayjs(targetMonthStr + '-01'); // 2026-03-01

    // 1. 직원 정보 및 타겟 부서 매핑
    const targetDeptNames = ['원장', '진료', '진료실', '진료팀', '진료부'];
    const empMap = new Map();
    state.management.employees.forEach(e => {
        const dept = state.management.departments.find(d => d.id === e.department_id);
        if (dept) {
            // 이름 정규화 (공백제거)
            empMap.set(e.name.replace(/\s+/g, ''), {
                id: e.id,
                name: e.name,
                deptId: e.department_id,
                deptName: dept.name
            });
        }
    });

    let currentDates = {}; // { colIndex: { date: "YYYY-MM-DD", startColIdx: number, span: number } }
    const schedules = [];
    let headerRowIndex = -1;

    // 날짜 헤더 감지를 위한 정규식
    // ✨ 필수조건: 숫자 뒤에 '일'이 있거나, 괄호로 감싸진 요일이 있어야 함.
    // 예: "2일", "2(월)", "02일 (월)"
    // (단순 숫자만 있는 경우 제외하여 통계 데이터 오탐지 방지)
    const dateRegex = /(\d{1,2})\s*(?:일|\([월화수목금토일]\))/;

    // 요일 매핑 for 검증
    const weekDayMap = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        // ✨ 통계 라인 등 명확히 아닌 행은 아예 date parsing 시도조차 하지 않음
        if (line.includes('TO:') || line.includes('근무:') || line.includes('목표:')) continue;

        const cells = line.split('\t');

        // A. 날짜 행 판단
        const potentialDates = [];
        cells.forEach((cell, idx) => {
            const trimmed = cell.trim();
            const match = trimmed.match(dateRegex);
            if (match) {
                // match[1]은 날짜 숫자
                const day = parseInt(match[1], 10);

                // 요일 추출 (괄호 안의 문자)
                const weekMatch = trimmed.match(/\(([월화수목금토일])\)/);
                const weekChar = weekMatch ? weekMatch[1] : undefined;

                // 날짜가 1~31 사이인지 확인
                if (day >= 1 && day <= 31) {
                    potentialDates.push({ idx, day, weekChar });
                }
            }
        });

        // 날짜가 2개 이상 발견되면 헤더 행으로 간주
        if (potentialDates.length >= 2) {
            currentDates = {};
            headerRowIndex = i;

            // ✨ 날짜 매핑 로직 (월 보정)
            for (let k = 0; k < potentialDates.length; k++) {
                const item = potentialDates[k];
                const nextItem = potentialDates[k + 1];

                // 1. 요일로 월 추정
                let resolvedDate = null;

                // 후보: 이번달(1순위), 지난달, 다음달
                // ✨ 중요: 이번달을 가장 먼저 체크해야 함 (요일 같을 경우 이번달 우선)
                const candidates = [
                    baseDate.date(item.day),                 // 이번달
                    baseDate.subtract(1, 'month').date(item.day), // 지난달
                    baseDate.add(1, 'month').date(item.day)       // 다음달
                ];

                if (item.weekChar) {
                    // 요일이 맞아야만 함
                    const targetDay = weekDayMap[item.weekChar];
                    resolvedDate = candidates.find(d => d.day() === targetDay);
                }

                // 요일이 없거나 매칭 실패 시 -> 이번달 우선
                if (!resolvedDate) {
                    resolvedDate = candidates[0];
                }

                if (!resolvedDate || !resolvedDate.isValid()) continue;

                const dateStr = resolvedDate.format('YYYY-MM-DD');

                // 2. Col Span 계산 (다음 날짜와의 간격)
                let span = 4; // 기본값
                if (nextItem) {
                    span = nextItem.idx - item.idx;
                    // 너무 좁거나(1 미만) 너무 넓으면(10 초과) 기본값 4
                    if (span < 1 || span > 10) span = 4;
                } else {
                    // 마지막 날짜는 이전 간격을 따라감 (단, 첫 날짜면 기본값 4)
                    const prevItem = potentialDates[k - 1];
                    if (prevItem) {
                        const prevSpan = item.idx - prevItem.idx;
                        if (prevSpan >= 1 && prevSpan <= 10) span = prevSpan;
                    }
                }

                const info = { date: dateStr, startColIdx: item.idx, span: span };

                // 해당 범위만큼 매핑
                for (let offset = 0; offset < span; offset++) {
                    currentDates[item.idx + offset] = info;
                }
            }
            continue;
        }

        // B. 데이터 행 처리
        if (headerRowIndex === -1) continue;
        const rowOffset = i - headerRowIndex - 1;
        if (rowOffset < 0) continue;

        cells.forEach((cell, idx) => {
            const rawName = cell.trim();
            if (!rawName) return;

            const dateInfo = currentDates[idx];
            if (!dateInfo) return; // 날짜 컬럼 영역 밖

            // 필터 키워드
            if (['부족', '여유', '적정', '목표', '검수', '휴일', '합계', '인원', '근무', 'TO:'].some(k => rawName.includes(k))) return;

            // 이름 정제
            let cleanName = rawName.replace(/\(.*\)/, '').replace(/[0-9.]/g, '').trim();
            // 공백 제거 후 비교 (이름에 공백 실수 방지)
            const lookupName = cleanName.replace(/\s+/g, '');
            if (lookupName.length < 2) return;

            const emp = empMap.get(lookupName);
            if (emp) {
                const isTarget = targetDeptNames.some(k => emp.deptName.includes(k));
                if (isTarget) {
                    // ✨ 그리드 포지션 계산 (행 * 4 + 열)
                    // 가로 오프셋: (현재 인덱스 - 시작 인덱스)
                    let colOffset = idx - dateInfo.startColIdx;

                    // Span에 맞춰 4칸 그리드로 정규화
                    // 만약 Span이 1칸(단일 컬럼)이라면 -> 세로로 쌓아야 하나?
                    // 현재 시스템은 가로 4칸이 한 행.
                    // 소스 데이터가 4칸이라면 1:1 매핑.
                    // 소스 데이터가 1칸이라면? -> 항상 첫 칸에 들어감. (원하는 대로 배치 안될 수 있음)
                    // -> 사용자 스크린샷은 4칸 구조임.

                    if (colOffset >= 4) colOffset = 3; // 4칸 넘어가면 마지막에

                    // grid_position = (행 * 4) + 열
                    const gridPos = (rowOffset * 4) + colOffset;

                    // 중복 방지
                    const exists = schedules.some(s => s.date === dateInfo.date && s.employee_id === emp.id);
                    if (!exists) {
                        schedules.push({
                            date: dateInfo.date,
                            name: emp.name,
                            dept: emp.deptName,
                            employee_id: emp.id,
                            raw: rawName,
                            grid_position: gridPos
                        });
                    }
                }
            }
        });
    }

    // 정렬
    schedules.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.grid_position - b.grid_position;
    });

    return { schedules, dateCount: Object.keys(currentDates).length, headerFound: headerRowIndex !== -1 };
}

/**
 * 미리보기 렌더링
 */
function renderPreview(result) {
    const container = document.getElementById('preview-container');
    const actions = document.getElementById('preview-actions');
    const countSpan = document.getElementById('preview-count');

    if (!result.headerFound) {
        container.innerHTML = `<div class="p-4 text-center text-red-500 font-bold">❌ 날짜 행을 찾을 수 없습니다.<br>복사한 데이터에 "2일 (월)", "3일" 같은 날짜가 2개 이상 포함되어 있어야 합니다.</div>`;
        actions.classList.add('hidden');
        return;
    }

    if (result.schedules.length === 0) {
        container.innerHTML = `<div class="p-4 text-center text-orange-500 font-bold">⚠️ 날짜는 찾았으나, 매칭되는 직원이 없습니다.<br>이름이 DB와 일치하는지 확인해주세요.</div>`;
        actions.classList.add('hidden');
        return;
    }

    // 최소/최대 날짜 범위 표시
    const dates = [...new Set(result.schedules.map(s => s.date))].sort();
    const minD = dates[0];
    const maxD = dates[dates.length - 1];

    countSpan.textContent = `총 ${result.schedules.length}건 (${minD} ~ ${maxD})`;
    actions.classList.remove('hidden');

    // 날짜별 그룹화
    const grouped = {};
    result.schedules.forEach(s => {
        if (!grouped[s.date]) grouped[s.date] = [];
        grouped[s.date].push(s);
    });

    const sortedDates = Object.keys(grouped).sort();

    let html = `<div class="grid grid-cols-1 gap-4 p-2">`;

    sortedDates.forEach(date => {
        const daySchedules = grouped[date];
        const dayStr = dayjs(date).format('MM-DD (ddd)');

        const maxPos = Math.max(...daySchedules.map(s => s.grid_position));
        const rowCount = Math.floor(maxPos / 4) + 1; // 4칸 기준 행 수

        html += `
            <div class="border rounded bg-white shadow-sm overflow-hidden">
                <div class="bg-gray-100 px-3 py-2 font-bold text-sm border-b flex justify-between">
                    <span>${dayStr}</span>
                    <span class="text-xs text-gray-500 font-normal">${daySchedules.length}명</span>
                </div>
                <div class="grid grid-cols-4 gap-px bg-gray-200 border-b">
        `;

        const totalCells = rowCount * 4;
        for (let i = 0; i < totalCells; i++) {
            const match = daySchedules.find(s => s.grid_position === i);
            if (match) {
                html += `
                    <div class="bg-white p-2 min-h-[60px] flex flex-col justify-center items-center text-center relative hover:bg-purple-50 transition-colors">
                        <span class="font-bold text-sm text-gray-800">${match.name}</span>
                        <span class="text-[10px] text-gray-500 block leading-tight mt-0.5">${match.dept}</span>
                    </div>
                `;
            } else {
                html += `<div class="bg-white min-h-[60px]"></div>`;
            }
        }

        html += `
                </div>
            </div>
        `;
    });

    html += `</div>`;
    container.innerHTML = html;
}

async function applyImportedSchedules(newSchedules) {
    if (!newSchedules || newSchedules.length === 0) return;

    // 적용 로직
    const targetEmpIds = [...new Set(newSchedules.map(s => s.employee_id))];
    const dates = newSchedules.map(s => s.date);
    const minDate = dates.sort()[0];
    const maxDate = dates.sort()[dates.length - 1];

    if (!minDate || !maxDate) return;

    // 1. 기존 데이터 삭제
    const { error: delError } = await db.from('schedules')
        .delete()
        .gte('date', minDate)
        .lte('date', maxDate)
        .in('employee_id', targetEmpIds);

    if (delError) throw new Error('기존 데이터 삭제 실패: ' + delError.message);

    // 2. 새 데이터 삽입
    const insertData = newSchedules.map((s, idx) => ({
        date: s.date,
        employee_id: s.employee_id,
        status: '근무',
        sort_order: s.grid_position, // sort_order와 grid_position을 동일하게 맞춤
        grid_position: s.grid_position
    }));

    const BATCH_SIZE = 100;
    for (let i = 0; i < insertData.length; i += BATCH_SIZE) {
        const batch = insertData.slice(i, i + BATCH_SIZE);
        const { error } = await db.from('schedules').insert(batch);
        if (error) throw new Error('데이터 저장 실패: ' + error.message);
    }

    alert('✅ 스케줄 업데이트 완료!');

    if (window.loadAndRenderScheduleData) {
        window.loadAndRenderScheduleData(state.schedule.currentDate);
    } else {
        location.reload();
    }
}
