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
 * 1. Supabase 데이터를 구글 시트로 전송
 */
export async function syncToAppSheet() {
    const scriptUrl = getScriptUrl();
    if (!scriptUrl) {
        alert('AppSheet 스크립트 URL이 설정되지 않았습니다.\n설정 버튼을 눌러 URL을 입력해주세요.');
        return;
    }

    try {
        const { data: employees, error: empError } = await db.from('employees')
            .select('id, name, department_id, is_temp, resignation_date')
            .is('resignation_date', null)
            .eq('is_temp', false);

        if (empError) throw empError;

        const currentDate = dayjs(state.schedule.currentDate);
        const startStr = currentDate.subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
        const endStr = currentDate.add(2, 'month').endOf('month').format('YYYY-MM-DD');

        const { data: leaves, error: leaveError } = await db.from('leave_requests')
            .select('*')
            .or('status.eq.approved,final_manager_status.eq.approved');

        if (leaveError) throw leaveError;

        const flatLeaves = [];
        leaves.forEach(req => {
            if (req.dates && Array.isArray(req.dates)) {
                req.dates.forEach(d => {
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
            mode: 'no-cors',
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
 */
export async function importFromAppSheet() {
    const currentMonthStr = dayjs(state.schedule.currentDate).format('YYYY-MM');

    // ✨ UI 개선 3차: Flexbox 완벽 적용 
    // - 모달 전체 높이 제한 (max-h-90vh)
    // - 내부 영역은 flex-1 min-h-0 으로 설정하여 넘치는 내용만 스크롤되도록 함
    // - 버튼과 헤더는 flex-shrink-0 으로 고정
    const modalHtml = `
        <div id="paste-import-modal" class="fixed inset-0 bg-gray-600 bg-opacity-70 flex items-center justify-center z-[9999] p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-7xl max-h-[90vh] flex flex-col overflow-hidden">
                <!-- 헤더 (고정) -->
                <div class="flex justify-between items-center p-4 border-b bg-gray-50 flex-shrink-0">
                    <div>
                        <h3 class="text-xl font-bold text-gray-800">📆 앱시트 스케줄 가져오기 (v2.2)</h3>
                        <p class="text-xs text-gray-500 mt-1">앱시트의 "배치(행/열)"를 그대로 반영하여 가져옵니다. (요일 무시, 선택한 월 기준)</p>
                    </div>
                    <button id="close-modal-x" class="text-gray-400 hover:text-gray-600 text-3xl leading-none">&times;</button>
                </div>

                <!-- 바디 (2단 컬럼) - 높이 유동적 -->
                <div class="flex-1 flex overflow-hidden min-h-0">
                    
                    <!-- 왼쪽: 입력 (40%) -->
                    <div class="w-2/5 flex flex-col border-r p-4 bg-white h-full">
                        <!-- 설정 영역 (고정) -->
                        <div class="flex-shrink-0 mb-2 space-y-3">
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
                                💡 팁: 앱시트에서 <strong>미리 날짜를 포함한 전체 영역을 드래그하여 복사</strong>하세요.<br>
                                숫자(2, 3...) 뒤에 '일' 또는 요일(월, 화...)이 있어야 날짜로 인식됩니다.
                            </p>
                        </div>

                        <!-- 텍스트 영역 (남은 공간 모두 차지 + 스크롤) -->
                        <div class="flex-1 min-h-[200px] mb-4 border border-gray-300 rounded overflow-hidden shadow-inner bg-white">
                            <div id="paste-area" 
                                contenteditable="true"
                                class="w-full h-full p-3 text-xs outline-none overflow-auto focus:bg-white transition-colors block"
                                style="white-space: normal;"
                                placeholder="여기에 엑셀/앱시트 데이터를 붙여넣으세요..."></div>
                        </div>

                        <!-- 분석 버튼 (고정) - 텍스트 변경 -->
                        <button id="analyze-paste-btn" class="w-full py-3 bg-purple-600 text-white rounded-lg font-bold text-lg hover:bg-purple-700 shadow-md transition-transform transform active:scale-95 flex-shrink-0">
                            🔍 HTML 테이블 분석하기 (추천)
                        </button>
                    </div>

                    <!-- 오른쪽: 미리보기 (60%) -->
                    <div class="w-3/5 flex flex-col p-4 bg-gray-50 h-full">
                        <!-- 헤더 (고정) -->
                        <div class="flex justify-between items-center mb-2 flex-shrink-0">
                            <h4 class="font-bold text-gray-700">3. 미리보기 및 적용</h4>
                            <span id="preview-count" class="text-sm font-bold text-purple-600 bg-purple-100 px-2 py-0.5 rounded-full"></span>
                        </div>

                        <!-- 미리보기 컨테이너 (남은 공간 모두 차지 + 스크롤) -->
                        <div id="preview-container" class="flex-1 border rounded-lg bg-white overflow-y-auto shadow-sm p-2" style="max-height: 65vh; min-height: 200px;">
                            <div class="h-full flex flex-col items-center justify-center text-gray-400 space-y-4">
                                <svg class="w-16 h-16 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                                <p>왼쪽에 데이터를 붙여넣고 [분석하기]를 눌러주세요.</p>
                            </div>
                        </div>

                        <!-- 적용 버튼 영역 (고정) -->
                        <div id="preview-actions" class="mt-4 hidden flex-shrink-0 z-10 w-full">
                            <div class="flex items-center justify-between p-3 bg-white rounded-lg border border-green-100 shadow-sm w-full">
                                <p class="text-xs text-red-500 font-bold flex items-center">
                                    <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                                    주의: 해당 월 기존 스케줄 덮어쓰기
                                </p>
                                <button id="apply-import-btn" class="px-6 py-2 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700 shadow flex items-center transition-colors">
                                    <span>✅ 스케줄 적용</span>
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

    // 포커스
    if (textarea) textarea.focus();

    // 상태 저장 변수
    let parsedDataResult = null;
    let pastedRawHtml = ''; // ✨ Ghost Paste: HTML 데이터를 메모리에만 저장

    const closeModal = () => modal.remove();
    closeBtn.onclick = closeModal;

    // ✨ Ghost Paste Listener
    // 대량의 HTML 테이블을 contenteditable에 직접 렌더링하면 브라우저가 멈춤.
    // 따라서 붙여넣기 이벤트를 가로채서 데이터만 저장하고, 화면에는 텍스트만 표시함.
    textarea.addEventListener('paste', (e) => {
        e.preventDefault();

        const clipboardHtml = e.clipboardData.getData('text/html');
        const clipboardText = e.clipboardData.getData('text/plain');

        if (clipboardHtml) {
            pastedRawHtml = clipboardHtml;
            textarea.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-green-600 space-y-2">
                    <span class="text-4xl">✅</span>
                    <span class="font-bold text-lg">데이터 붙여넣기 완료!</span>
                    <span class="text-sm text-gray-500">(브라우저 멈춤 방지를 위해 표는 표시하지 않습니다)</span>
                    <span class="text-xs text-gray-400 mt-2">바로 아래 [분석하기] 버튼을 눌러주세요.</span>
                </div>
            `;
        } else {
            // HTML이 없는 경우 (일반 텍스트)
            textarea.innerText = clipboardText; // fallback
            pastedRawHtml = ''; // 초기화
        }
    });

    wrapToggle.onchange = (e) => {
        // ... (토글 로직 유지, Ghost Paste 시에는 의미 없지만 텍스트 모드 대비)
        if (e.target.checked) textarea.style.whiteSpace = 'pre-wrap';
        else textarea.style.whiteSpace = 'normal';
    };

    analyzeBtn.onclick = () => {
        const targetMonth = monthInput.value;
        let sourceElement;

        // 1. Ghost Paste 데이터가 있으면 우선 사용
        if (typeof pastedRawHtml !== 'undefined' && pastedRawHtml) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = pastedRawHtml;
            sourceElement = tempDiv;
        }
        // 2. 없으면 화면에 있는 내용 사용 (DOM)
        else {
            sourceElement = textarea;
        }

        // 내용 확인
        const hasTable = sourceElement.querySelector('table');
        const hasText = sourceElement.innerText.trim().length > 0;

        if (!hasTable && !hasText) {
            alert('데이터를 붙여넣어주세요.');
            return;
        }

        try {
            if (hasTable) {
                // ✨ 1순위: HTML 테이블 파싱 (정확도 높음, 병합 셀 지원)
                console.log('HTML 테이블 감지됨: 테이블 파싱 시도');
                parsedDataResult = analyzePastedTable(sourceElement, targetMonth);
            } else {
                // ✨ 2순위: 텍스트 파싱 (Fallback)
                console.warn('HTML 테이블 없음: 텍스트 파싱 시도 (병합 셀 미지원)');
                if (typeof analyzePastedText === 'function') {
                    const textContent = sourceElement.innerText || sourceElement.textContent;
                    parsedDataResult = analyzePastedText(textContent, targetMonth);
                } else {
                    throw new Error('텍스트 분석 함수를 찾을 수 없습니다.');
                }
            }

            renderPreview(parsedDataResult);
        } catch (err) {
            console.error('파싱 실패:', err);
            // 만약 테이블 파싱에서 실패했다면 텍스트 파싱으로 재시도
            if (hasTable && typeof analyzePastedText === 'function') {
                try {
                    console.log('테이블 파싱 실패 후 텍스트 파싱 재시도...');
                    const textContent = sourceElement.innerText || sourceElement.textContent;
                    parsedDataResult = analyzePastedText(textContent, targetMonth);
                    renderPreview(parsedDataResult);
                    return;
                } catch (textErr) {
                    console.error('텍스트 파싱도 실패:', textErr);
                }
            }
            alert('분석 실패: ' + err.message + '\n(엑셀에서 복사했는지 확인해주세요)');
        }
    };

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
 * ✨ HTML 테이블 분석 로직 (병합된 셀 지원)
 */
function analyzePastedTable(containerEl, targetMonthStr) {
    // 1. 테이블 찾기
    const table = containerEl.querySelector('table');
    if (!table) {
        throw new Error('붙여넣은 데이터에서 표(Table)를 찾을 수 없습니다. 엑셀이나 구글 시트에서 복사해주세요.');
    }

    const rows = Array.from(table.rows);
    const baseDate = dayjs(targetMonthStr + '-01');

    // 직원 매핑 정보 생성
    const targetDeptNames = ['원장', '진료', '진료실', '진료팀', '진료부'];
    const empMap = new Map();
    state.management.employees.forEach(e => {
        const dept = state.management.departments.find(d => d.id === e.department_id);
        if (dept) {
            empMap.set(e.name.replace(/\s+/g, ''), {
                id: e.id,
                name: e.name,
                deptId: e.department_id,
                deptName: dept.name
            });
        }
    });

    // Regex 설정
    const fullDateRegex = /^(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})/;
    const simpleDayRegex = /(\d{1,2})\s*(?:일|\([월화수목금토일]\))/;

    let headerRowIndex = -1;
    let dateMap = new Map(); // colIndex -> Date String
    const schedules = [];
    const detectedHeaders = [];

    // =================================================================================
    // 1단계: 헤더(날짜) 행 찾기 & 컬럼 매핑 (colspan 고려)
    // =================================================================================

    // 가상 그리드로 생각: rows[r].cells[c]는 실제 DOM 위치지만, 논리적 컬럼 인덱스는 계산해야 함.
    // 하지만 여기서는 "헤더 행"만 정확히 찾으면, 그 아래 데이터는 순차적으로 매핑됨.
    // 엑셀 복사 시 rowspan은 드물지만 colspan은 흔함 (병합된 날짜/휴일).

    for (let r = 0; r < rows.length; r++) {
        const cells = Array.from(rows[r].cells);
        let potentialDateCount = 0;
        let colIndex = 0;
        let tempDateMap = new Map();

        for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            const text = cell.innerText.trim();
            const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);

            if (text) {
                // 날짜 패턴 확인
                let matchedDate = null;
                const fullMatch = text.match(fullDateRegex);
                const simpleMatch = text.match(simpleDayRegex);

                if (fullMatch) {
                    let y = fullMatch[1] ? parseInt(fullMatch[1], 10) : baseDate.year();
                    let m = parseInt(fullMatch[2], 10);
                    let d = parseInt(fullMatch[3], 10);
                    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                        // 연도 보정: 입력 연도가 없으면, baseDate의 해당 월과 비교해서 타당성 체크 가능하나 생략
                        matchedDate = dayjs(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`).format('YYYY-MM-DD');
                    }
                } else if (simpleMatch) {
                    const d = parseInt(simpleMatch[1], 10);
                    if (d >= 1 && d <= 31) {
                        matchedDate = baseDate.clone().date(d).format('YYYY-MM-DD');
                    }
                }

                if (matchedDate) {
                    potentialDateCount++;
                    // 이 셀이 차지하는 모든 컬럼 인덱스에 날짜 매핑
                    for (let i = 0; i < colspan; i++) {
                        tempDateMap.set(colIndex + i, {
                            date: matchedDate,
                            isMerged: colspan > 1,
                            raw: text
                        });
                    }
                    detectedHeaders.push({ date: matchedDate, col: colIndex, text });
                }
            }
            colIndex += colspan;
        }

        // 유효한 날짜가 2개 이상 발견되면 헤더로 확정
        if (potentialDateCount >= 2) {
            headerRowIndex = r;
            dateMap = tempDateMap;
            console.log(`✅ 헤더 발견 (Row ${r}):`, dateMap);
            break;
        }
    }

    if (headerRowIndex === -1) {
        return { headerFound: false, schedules: [] };
    }


    // =================================================================================
    // 2단계: 데이터 행 파싱 (colspan 고려하여 정확한 위치 매핑)
    // =================================================================================

    // 주의: Rowspan이 있는 경우 복잡해지나, 일반적인 스케줄 표는 날짜 헤더 아래에 직원 이름이 있음.
    // 엑셀 -> HTML 붙여넣기 시 rowspan 정보도 오지만, 여기서는 "현재 행의 논리적 컬럼 위치"만 잘 추적하면 됨.

    for (let r = headerRowIndex + 1; r < rows.length; r++) {
        const row = rows[r];
        // 통계 행 등 제외
        if (row.innerText.includes('TO:') || row.innerText.includes('검수')) continue;

        let colIndex = 0;
        const cells = Array.from(row.cells);

        for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            const text = cell.innerText.trim();
            const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);

            // 해당 컬럼 인덱스가 날짜 헤더에 매핑되어 있는지 확인
            // colspan이 1보다 크면(병합된 셀), 그 범위 내의 날짜들에 대해 처리
            // 보통 이름 칸은 병합되지 않으나, 만약 병합되었다면? -> 첫 번째 날짜에만 할당하거나 무시?
            // "대체 공휴일" 등으로 병합된 칸은 이름이 아닐 확률이 높음.

            if (text) {
                // 제외 키워드 체크
                if (!['부족', '여유', '적정', '목표', '검수', '휴일', '합계', '인원', '근무', 'TO:'].some(k => text.includes(k))) {

                    // [수정] 사용자 요청에 따라 인위적인 키워드((휴), (연차) 등) 배제 로직 제거
                    // "있는 그대로" 인식하되, DB에 없는 이름이면 매핑되지 않음.
                    // 화면상 배치(Row 위치)를 그대로 보존하는 것이 핵심.

                    // 이름 추출 (숫자 제거, 괄호 제거)
                    let cleanName = text.replace(/\(.*\)/, '').replace(/[0-9.]/g, '').trim();
                    const lookupName = cleanName.replace(/\s+/g, '');

                    if (lookupName.length >= 2) {
                        const emp = empMap.get(lookupName);
                        // 부서 체크
                        if (emp && targetDeptNames.some(k => emp.deptName.includes(k))) {

                            // 현재 colIndex에 해당하는 날짜 찾기
                            const dateInfo = dateMap.get(colIndex);

                            if (dateInfo) {
                                // 스케줄 추가
                                // Grid Position 계산: 날짜별 순서가 아니라, 원본 "행(Row)" 인덱스를 그대로 사용
                                // 헤더 바로 다음 행이 0번 포지션.
                                // 빈 행이 있으면 1, 2... 건너뛰고 3번 포지션에 들어감 -> 시각적 배치 보존
                                const rowPos = r - headerRowIndex - 1;

                                // 기존 데이터 중복 체크 (혹시 모를 병합 셀 이슈 방지)
                                const exists = schedules.some(s => s.date === dateInfo.date && s.grid_position === rowPos);
                                if (!exists) {
                                    schedules.push({
                                        date: dateInfo.date,
                                        name: emp.name,
                                        dept: emp.deptName,
                                        employee_id: emp.id,
                                        raw: text,
                                        grid_position: rowPos // ✨ 핵심: 행 인덱스 기반 포지셔닝
                                    });
                                }
                            }
                        }
                    }
                }


            }

            // 다음 셀을 위해 인덱스 증가
            colIndex += colspan;
        }
    }

    // =================================================================================
    // 3단계: Grid Position 할당 (날짜별 로직)
    // =================================================================================
    // 날짜별로 모아서, 원본 등장 순서(Row -> Col)대로 grid_position 0, 1, 2... 할당

    // 먼저 날짜순, 그 다음 원래 등작 순서(행 우선 탐색했으므로 배열 순서가 곧 순서임)
    // 하지만 같은 날짜 내에서 grid_position을 0~3행, 4~7행 식으로 매핑하고 싶다면?
    // 이전 텍스트 파싱 로직: (RowOffset * 4) + ColOffset 방식이었음.
    // HTML 방식에서도 유사하게 위치를 잡고 싶다면, Row Index를 활용해야 함.

    // 단순화: 그냥 날짜별로 리스트업하고 순서대로 채움 (빈칸 없이)
    // 사용자가 "빈칸"을 의도했다면 HTML 파싱으로는 알기 어려움 (빈 셀인지 구조적 공백인지)
    // -> "채워넣기" 식으로 구현 (빈칸 없이 앞에서부터)

    // =================================================================================
    // 3단계: 결과 반환
    // =================================================================================
    // "좌석 배치 보존"을 위해 위에서 계산한 rowPos를 그대로 유지함.
    // 빈칸(Empty Row)을 유지하기 위함.

    return {
        schedules: schedules,
        headerFound: true,
        headers: detectedHeaders
    };
}

/**
 * 미리보기 렌더링
 */
/**
 * 미리보기 렌더링 (참고: 성능 최적화를 위한 페이지네이션)
 */
function renderPreview(result) {
    const container = document.getElementById('preview-container');
    const actions = document.getElementById('preview-actions');
    const countSpan = document.getElementById('preview-count');

    if (!result.headerFound) {
        container.innerHTML = `<div class="p-4 text-center text-red-500 font-bold">❌ 날짜 행을 찾을 수 없습니다.<br>2개 이상의 날짜("1일", "01(월)" 등)가 포함된 행이 필요합니다.</div>`;
        actions.classList.add('hidden');
        return;
    }

    if (result.schedules.length === 0) {
        container.innerHTML = `<div class="p-4 text-center text-orange-500 font-bold">⚠️ 날짜는 찾았으나, 매칭되는 직원이 없습니다.<br>이름이 DB와 일치하는지 확인해주세요.</div>`;
        actions.classList.add('hidden');
        return;
    }

    countSpan.textContent = `총 ${result.schedules.length}건`;
    actions.classList.remove('hidden');

    const grouped = {};
    result.schedules.forEach(s => {
        if (!grouped[s.date]) grouped[s.date] = [];
        grouped[s.date].push(s);
    });

    const sortedDates = Object.keys(grouped).sort();

    // ✨ 성능 최적화: 7일씩 끊어서 렌더링 (Pagination)
    const BATCH_SIZE = 7;
    let currentBatchIndex = 0;

    // 헤더 분석 정보 (항상 표시)
    let debugHtml = `
        <details class="mb-4 text-xs bg-gray-50 border rounded p-2 flex-shrink-0">
            <summary class="font-bold text-gray-500 cursor-pointer select-none">🔍 시스템이 인식한 날짜 헤더 보기 (여기를 눌러 확인)</summary>
            <div class="mt-2 grid grid-cols-2 gap-2">
                ${result.headers.map(h => `
                    <div class="flex justify-between border-b border-gray-100 pb-1">
                        <span>${h.raw} → <strong>${h.date}</strong></span>
                        <span class="text-gray-400">(시작열: ${h.col}, 폭: ${h.span})</span>
                    </div>
                `).join('')}
            </div>
        </details>
    `;

    // 메인 컨테이너 초기화
    container.innerHTML = debugHtml + `<div id="preview-list" class="grid grid-cols-1 gap-4 p-2"></div>`;
    const listContainer = container.querySelector('#preview-list');

    // "더 보기" 버튼 생성
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = "w-full py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold rounded mt-4 text-sm hidden";
    loadMoreBtn.innerHTML = "⬇️ 다음 날짜 더 보기";
    container.appendChild(loadMoreBtn);

    // 렌더링 함수
    const renderBatch = () => {
        const start = currentBatchIndex * BATCH_SIZE;
        const end = start + BATCH_SIZE;
        const batchDates = sortedDates.slice(start, end);

        if (batchDates.length === 0) {
            loadMoreBtn.classList.add('hidden');
            return;
        }

        let html = '';
        batchDates.forEach(date => {
            const daySchedules = grouped[date];
            const dayStr = dayjs(date).format('MM-DD (ddd)');
            const maxPos = Math.max(...daySchedules.map(s => s.grid_position));
            const rowCount = Math.floor(maxPos / 4) + 1;

            html += `
                <div class="border rounded bg-white shadow-sm overflow-hidden mb-4" style="content-visibility: auto; contain-intrinsic-size: 100px;">
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
            html += `</div></div>`;
        });

        listContainer.insertAdjacentHTML('beforeend', html);

        currentBatchIndex++;
        if (currentBatchIndex * BATCH_SIZE >= sortedDates.length) {
            loadMoreBtn.classList.add('hidden');
        } else {
            loadMoreBtn.classList.remove('hidden');
            loadMoreBtn.textContent = `⬇️ 다음 날짜 더 보기 (${Math.min((currentBatchIndex + 1) * BATCH_SIZE, sortedDates.length)} / ${sortedDates.length})`;
        }
    };

    // 초기 실행
    renderBatch();

    // 버튼 이벤트
    loadMoreBtn.onclick = renderBatch;
}

/**
 * 텍스트 분석 로직 (Fallback)
 * - 병합된 셀(대체공휴일 등)은 정확히 처리 못할 수 있음
 * - 탭(\t) 구분자에 의존
 */
function analyzePastedText(text, targetMonthStr) {
    const lines = text.split('\n').map(l => l.trimEnd());
    const baseDate = dayjs(targetMonthStr + '-01');

    const targetDeptNames = ['원장', '진료', '진료실', '진료팀', '진료부'];
    const empMap = new Map();
    state.management.employees.forEach(e => {
        const dept = state.management.departments.find(d => d.id === e.department_id);
        if (dept) {
            empMap.set(e.name.replace(/\s+/g, ''), {
                id: e.id,
                name: e.name,
                deptName: dept.name
            });
        }
    });

    let currentDates = {};
    const schedules = [];
    let headerRowIndex = -1;

    const fullDateRegex = /^(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})/;
    const simpleDayRegex = /(\d{1,2})\s*(?:일|\([월화수목금토일]\))/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (line.includes('TO:') || line.includes('근무:') || line.includes('목표:')) continue;

        const cells = line.split('\t');

        // A. 날짜 행 판단
        const potentialDates = [];
        cells.forEach((cell, idx) => {
            const trimmed = cell.trim();
            if (!trimmed) return;

            const fullMatch = trimmed.match(fullDateRegex);
            if (fullMatch) {
                let y = fullMatch[1] ? parseInt(fullMatch[1], 10) : baseDate.year();
                let m = parseInt(fullMatch[2], 10);
                let d = parseInt(fullMatch[3], 10);
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    potentialDates.push({ idx, year: y, month: m, day: d, text: trimmed, type: 'full' });
                    return;
                }
            }
            const simpleMatch = trimmed.match(simpleDayRegex);
            if (simpleMatch) {
                const d = parseInt(simpleMatch[1], 10);
                if (d >= 1 && d <= 31) {
                    potentialDates.push({ idx, day: d, text: trimmed, type: 'simple' });
                }
            }
        });

        if (potentialDates.length >= 2) {
            currentDates = {};
            headerRowIndex = i;

            for (let k = 0; k < potentialDates.length; k++) {
                const item = potentialDates[k];
                const nextItem = potentialDates[k + 1];

                let resolvedDate;
                if (item.type === 'full') {
                    const mStr = String(item.month).padStart(2, '0');
                    const dStr = String(item.day).padStart(2, '0');
                    resolvedDate = dayjs(`${item.year}-${mStr}-${dStr}`);
                } else {
                    resolvedDate = baseDate.clone().date(item.day);
                }
                const dateStr = resolvedDate.format('YYYY-MM-DD');

                let span = 4;
                if (nextItem) {
                    span = nextItem.idx - item.idx;
                    if (span < 1 || span > 10) span = 4;
                }

                const info = { date: dateStr, startColIdx: item.idx, span: span };
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
            if (!dateInfo) return;
            if (['부족', '여유', '적정', '목표', '검수', '휴일', '합계', '인원', '근무', 'TO:'].some(k => rawName.includes(k))) return;

            // ✨ (휴), (연차) 등 제외 로직 추가
            const offKeywords = ['휴', '휴무', '연', '연차', '반', '반차', '오프', 'OFF', 'off'];
            const isOffStatus = offKeywords.some(k => rawName.includes(`(${k}`) || rawName.includes(`[${k}`));
            if (isOffStatus) return;

            let cleanName = rawName.replace(/\(.*\)/, '').replace(/[0-9.]/g, '').trim();
            const lookupName = cleanName.replace(/\s+/g, '');
            if (lookupName.length < 2) return;

            const emp = empMap.get(lookupName);
            if (emp) {
                const isTarget = targetDeptNames.some(k => emp.deptName.includes(k));
                if (isTarget) {
                    let colOffset = idx - dateInfo.startColIdx;
                    if (colOffset >= 4) colOffset = 3;
                    const gridPos = (rowOffset * 4) + colOffset;

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

    schedules.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.grid_position - b.grid_position;
    });

    return {
        schedules,
        headerFound: headerRowIndex !== -1,
        headers: []
    };
}

