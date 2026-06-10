import { db, state } from './state.js?v=20260610a';
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
/**
 * 1. Supabase 데이터를 구글 시트로 전송 (CORS 지원)
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

    // ✨ Grid Canvas Paste Listener (v3.0)
    // 엑셀 복사 시 TSV(Tab-Separated Values) 형태로 데이터를 받아서
    // 2D 배열로 변환 후 HTML 그리드로 시각화
    let pastedGrid = null; // 2D 배열 저장

    textarea.addEventListener('paste', (e) => {
        e.preventDefault();

        // 1. HTML 데이터 추출 (병합된 셀 정보 보존을 위해 우선순위)
        pastedRawHtml = e.clipboardData.getData('text/html');

        // 2. TSV 데이터 추출 (엑셀 복사 시 기본 형식, HTML 실패 시 폴백)
        const clipboardText = e.clipboardData.getData('text/plain');

        if (!clipboardText || !clipboardText.trim()) {
            alert('붙여넣기 데이터가 비어있습니다.');
            return;
        }

        // TSV → 2D 배열 변환 (미리보기용)
        pastedGrid = parseTSV(clipboardText);

        // 그리드 시각화 (사용자 피드백용)
        // 주의: HTML 파싱을 사용할 것이지만, 시각적으로는 TSV 그리드가 깔끔함
        const gridHtml = renderGridPreview(pastedGrid);
        textarea.innerHTML = gridHtml;

        console.log('✅ Paste detected. Rows:', pastedGrid.length, 'HTML available:', !!pastedRawHtml);
        if (pastedRawHtml) {
            console.log('   -> HTML Table structure preserved for analysis.');
        }
    });

    wrapToggle.onchange = (e) => {
        // ... (토글 로직 유지, Ghost Paste 시에는 의미 없지만 텍스트 모드 대비)
        if (e.target.checked) textarea.style.whiteSpace = 'pre-wrap';
        else textarea.style.whiteSpace = 'normal';
    };

    analyzeBtn.onclick = () => {
        const targetMonth = monthInput.value;

        // 데이터 존재 확인
        if ((!pastedGrid || pastedGrid.length === 0) && !pastedRawHtml) {
            alert('데이터를 붙여넣어주세요.');
            return;
        }

        try {
            // ✨ 분석 로직 분기: HTML이 있으면 HTML 파서 우선 (병합 셀 지원)
            console.log('🔍 분석 시작. HTML 모드:', !!pastedRawHtml);

            if (pastedRawHtml) {
                // 임시 컨테이너에 HTML 주입하여 DOM 파싱
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = pastedRawHtml;

                // HTML 파서 호출 (v3.1)
                parsedDataResult = analyzePastedTable(tempDiv, targetMonth);
            } else {
                // 폴백: 텍스트 그리드 파서 (v3.0)
                // TSV는 병합 정보를 잃으므로, "가로 채우기(Fill-Right)" 로직이 보강된 파서 필요
                console.warn('⚠️ HTML 데이터 없음. TSV 텍스트 기반 분석 시도.');
                parsedDataResult = analyzeGridData(pastedGrid, targetMonth);
            }

            renderPreview(parsedDataResult);

        } catch (err) {
            console.error('파싱 실패:', err);
            alert('분석 실패: ' + err.message + '\n\n데이터 형식을 확인해주세요.');
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

// =============================================================================
// ✨ Grid-Based Import Functions (v3.0)
// =============================================================================

/**
 * TSV → 2D 배열 변환
 */
function parseTSV(text) {
    const lines = text.split('\n');
    return lines.map(line => line.split('\t').map(cell => cell.trim()));
}

/**
 * 2D 배열 → HTML 그리드 시각화
 */
function renderGridPreview(grid) {
    if (!grid || grid.length === 0) {
        return '<div class="p-4 text-center text-gray-500">데이터가 비어있습니다.</div>';
    }

    let html = `
        <div class="p-2 bg-green-50 border border-green-200 rounded mb-2 text-sm text-green-700">
            ✅ <strong>${grid.length}행 × ${grid[0]?.length || 0}열</strong> 데이터 인식 완료! 아래 [분석하기] 버튼을 눌러주세요.
        </div>
        <div class="overflow-auto max-h-96 border rounded">
            <table class="w-full text-xs border-collapse">
    `;

    grid.forEach((row, rowIdx) => {
        html += '<tr>';
        row.forEach((cell, colIdx) => {
            const bgClass = rowIdx === 0 ? 'bg-gray-100 font-bold' : 'bg-white';
            html += `<td class="${bgClass} border border-gray-300 px-2 py-1 whitespace-nowrap">${cell || '&nbsp;'}</td>`;
        });
        html += '</tr>';
    });

    html += '</table></div>';
    return html;
}

/**
 * Grid 데이터 분석 (핵심 로직)
 * ✨ 중요: 엑셀 원본은 "행(Row) = 날짜" 구조!
 *    - 각 행이 하나의 날짜를 나타냄 (세로 방향)
 *    - 각 열이 직원 위치 (가로 방향)
 */
function analyzeGridData(grid, targetMonthStr) {
    const baseDate = dayjs(targetMonthStr + '-01');

    // 직원 매핑
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

    // 🔍 디버그: DB에 등록된 직원 목록 출력
    console.log('📋 DB 직원 목록 (진료실):');
    empMap.forEach((emp, key) => {
        if (targetDeptNames.some(k => emp.deptName.includes(k))) {
            console.log(`  - "${key}" → ${emp.name} (${emp.deptName})`);
        }
    });

    const schedules = [];
    const detectedHeaders = [];


    const fullDateRegex = /^(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})/;
    const simpleDayRegex = /(\d{1,2})\s*(?:일|\([월화수목금토일]\))/;
    const holidayKeywords = ['휴일', '휴무', '대체공휴일', '공휴일'];

    // 각 행을 순회 (각 행 = 하나의 날짜)
    for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        if (!row || row.length === 0) continue;

        // 첫 번째 셀에서 날짜 찾기
        const firstCell = row[0];
        if (!firstCell) continue;

        // 휴일 키워드 체크
        if (holidayKeywords.some(k => firstCell.includes(k))) {
            console.log(`⏭️ 휴일 감지 (행 ${r}):`, firstCell);
            continue;
        }

        let dateStr = null;

        // 날짜 패턴 감지
        const fullMatch = firstCell.match(fullDateRegex);
        if (fullMatch) {
            const y = fullMatch[1] ? parseInt(fullMatch[1], 10) : baseDate.year();
            const m = parseInt(fullMatch[2], 10);
            const d = parseInt(fullMatch[3], 10);
            if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                dateStr = dayjs(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`).format('YYYY-MM-DD');
            }
        }

        if (!dateStr) {
            const simpleMatch = firstCell.match(simpleDayRegex);
            if (simpleMatch) {
                const d = parseInt(simpleMatch[1], 10);
                if (d >= 1 && d <= 31) {
                    dateStr = baseDate.date(d).format('YYYY-MM-DD');
                }
            }
        }

        // 날짜를 찾았으면 이 행의 직원 데이터 파싱
        if (dateStr) {
            detectedHeaders.push({ date: dateStr, raw: firstCell, row: r });
            console.log(`📅 날짜 감지 (행 ${r}):`, dateStr, '←', firstCell);

            // 1열부터 끝까지 직원 이름 찾기 (0열은 날짜)
            for (let c = 1; c < row.length; c++) {
                const cell = row[c];
                if (!cell) continue;

                console.log(`    🔍 셀 검사 (열 ${c}):`, cell);

                // 제외 키워드
                if (['부족', '여유', '적정', '목표', '검수', '휴일', '합계', '인원', '근무', 'TO:', 'TO', '근무:'].some(k => cell.includes(k))) {
                    console.log(`      ⏭️ 제외 키워드 포함, 건너뜀`);
                    continue;
                }

                // 이름 추출
                let cleanName = cell.replace(/\(.*\)/, '').replace(/[0-9.]/g, '').trim();
                const lookupName = cleanName.replace(/\s+/g, '');

                console.log(`      📝 이름 추출: "${cell}" → "${cleanName}" → "${lookupName}"`);

                if (lookupName.length >= 2) {
                    const emp = empMap.get(lookupName);
                    console.log(`      🔎 DB 조회: "${lookupName}" →`, emp ? `✅ ${emp.name} (${emp.deptName})` : '❌ 없음');

                    if (emp) {
                        const deptMatch = targetDeptNames.some(k => emp.deptName.includes(k));
                        console.log(`      🏥 부서 체크: "${emp.deptName}" →`, deptMatch ? '✅ 진료실' : '❌ 다른 부서');

                        if (deptMatch) {
                            // ✨ Grid Position: 열 인덱스 - 1 (0열은 날짜이므로)
                            // 1열 → grid_position 0
                            // 2열 → grid_position 1
                            // 3열 → grid_position 2
                            // 4열 → grid_position 3
                            const gridPos = c - 1;

                            schedules.push({
                                date: dateStr,
                                name: emp.name,
                                dept: emp.deptName,
                                employee_id: emp.id,
                                raw: cell,
                                grid_position: gridPos
                            });

                            console.log(`      ✅ 직원 추가: ${emp.name} (열 ${c} → pos ${gridPos})`);
                        }
                    }
                } else {
                    console.log(`      ⏭️ 이름이 너무 짧음 (${lookupName.length}자), 건너뜀`);
                }
            }
        }
    }

    return {
        schedules: schedules,
        headerFound: detectedHeaders.length > 0,
        headers: detectedHeaders
    };
}

/**

/**
 * ✨ HTML 테이블 분석 로직 (병합된 셀 지원)
 */
/**
 * ✨ HTML 테이블 분석 로직 (다중 주차/블록 지원, 병합된 셀 지원)
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

    const schedules = [];
    const detectedHeaders = [];

    // ✨ 데이터 파싱을 위한 상태 변수
    let currentDateMap = null; // Map<colIndex, DateString>
    let headerRowIndex = -1; // 현재 적용 중인 헤더 행 인덱스 (grid_position 행 오프셋 계산용)
    let currentDateColInfo = new Map(); // Date -> { startCol, span } (열 오프셋 계산용)

    console.log(`📊 테이블 분석 시작: 총 ${rows.length}행`);

    // 모든 행을 순회하며 "헤더(날짜)"와 "데이터(직원)"를 판별
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const cells = Array.from(row.cells);
        const rowText = row.innerText.trim();

        // 빈 행 또는 통계 행 건너뛰기
        if (!rowText || rowText.includes('TO:') || rowText.includes('검수')) continue;

        // -----------------------------------------------------------
        // 1. 헤더 행 판별 (날짜 패턴이 2개 이상 있는가?)
        // -----------------------------------------------------------
        let potentialDateMap = new Map();
        let validDateCount = 0;
        let colIndex = 0;

        for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            const text = cell.innerText.trim();
            const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);

            if (text) {
                let matchedDate = null;
                const fullMatch = text.match(fullDateRegex);
                const simpleMatch = text.match(simpleDayRegex);

                // 휴일 키워드만 있는 경우 등은 날짜로 보지 않음 (숫자 포함 필수)

                if (fullMatch) {
                    let y = fullMatch[1] ? parseInt(fullMatch[1], 10) : baseDate.year();
                    let m = parseInt(fullMatch[2], 10);
                    let d = parseInt(fullMatch[3], 10);
                    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                        matchedDate = dayjs(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`).format('YYYY-MM-DD');
                    }
                } else if (simpleMatch) {
                    const d = parseInt(simpleMatch[1], 10);
                    if (d >= 1 && d <= 31) {
                        // 월 추정: 타겟 월의 해당 일자로 가정
                        matchedDate = baseDate.date(d).format('YYYY-MM-DD');
                    }
                }

                if (matchedDate) {
                    validDateCount++;
                    // Colspan만큼 맵핑 (병합된 날짜 헤더 지원)
                    for (let i = 0; i < colspan; i++) {
                        potentialDateMap.set(colIndex + i, matchedDate);
                    }
                    detectedHeaders.push({ date: matchedDate, row: r, text, col: colIndex, span: colspan });
                }
            }
            colIndex += colspan;
        }

        // 헤더 행으로 판명되면 Map 갱신
        if (validDateCount >= 2) { // 한 행에 날짜가 2개 이상이면 헤더로 간주
            console.log(`✅ 날짜 헤더 감지 (Row ${r}):`, potentialDateMap);
            currentDateMap = potentialDateMap;
            headerRowIndex = r; // ✨ 행 오프셋 계산의 기준점 저장

            // ✨ 각 날짜의 시작 열(startCol)과 열 폭(span) 정보 갱신
            // WHY: grid_position = (rowOffset * colsPerDate) + colOffset 공식에 필요
            currentDateColInfo = new Map();
            const dateStartCols = new Map(); // date -> 첫 등장 colIndex
            potentialDateMap.forEach((dateStr, col) => {
                if (!dateStartCols.has(dateStr)) {
                    dateStartCols.set(dateStr, col);
                }
            });
            dateStartCols.forEach((startCol, dateStr) => {
                // 해당 날짜에 매핑된 열 수 = colspan (=colsPerDate)
                let span = 0;
                potentialDateMap.forEach((d) => { if (d === dateStr) span++; });
                currentDateColInfo.set(dateStr, { startCol, span });
            });

            continue; // 헤더 행은 데이터 파싱 스킵
        }

        // -----------------------------------------------------------
        // 2. 데이터 행 파싱 (현재 유효한 DateMap이 있을 때만)
        // -----------------------------------------------------------
        if (currentDateMap) {
            colIndex = 0;
            for (let c = 0; c < cells.length; c++) {
                const cell = cells[c];
                const text = cell.innerText.trim();
                const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);

                if (text) {
                    // 키워드 필터링
                    if (!['부족', '여유', '적정', '목표', '검수', '휴일', '합계', '인원', '근무', 'TO:'].some(k => text.includes(k))) {

                        // ✨ (휴), (OFF) 등 휴무 표시 제외 로직 추가 (v3.2)
                        // 사용자의 요청: "공휴일이라 휴무인데 배치된 걸로 인식한다" -> 휴무 표시는 스케줄에서 제외
                        const offKeywords = ['휴', '휴무', '연', '연차', '반', '반차', '오프', 'OFF', 'off'];
                        // 괄호나 대괄호로 감싸진 키워드 확인 (예: 박선규(휴), 김민재[OFF])
                        const isOffStatus = offKeywords.some(k => text.includes(`(${k}`) || text.includes(`[${k}`));

                        if (isOffStatus) {
                            console.log(`      ⏭️ 휴무 상태 감지: "${text}" -> 제외`);
                        } else {

                            // 현재 컬럼이 어떤 날짜에 속하는지 확인
                            const dateStr = currentDateMap.get(colIndex);

                            if (dateStr) {
                                // 이름 추출
                                let cleanName = text.replace(/\(.*\)/, '').replace(/[0-9.]/g, '').trim();
                                const lookupName = cleanName.replace(/\s+/g, '');

                                if (lookupName.length >= 2) {
                                    const emp = empMap.get(lookupName);
                                    if (emp && targetDeptNames.some(k => emp.deptName.includes(k))) {

                                        // 중복 체크 (같은 날짜, 같은 사람)
                                        const exists = schedules.some(s => s.date === dateStr && s.employee_id === emp.id);

                                        if (!exists) {
                                            // ✨ Grid Position 결정 (v3.3):
                                            // WHY: 순차 할당(0,1,2...)은 시트 원본 배치를 파괴함.
                                            // 행 오프셋(rowOffset)과 날짜 내 열 오프셋(colOffset)을 조합하여
                                            // 시트의 시각적 레이아웃을 웹 그리드에 그대로 복원.
                                            const rowOffset = r - headerRowIndex - 1;
                                            const dateInfo = currentDateColInfo.get(dateStr);
                                            const colsPerDate = dateInfo ? dateInfo.span : 4;
                                            let colOffset = dateInfo ? (colIndex - dateInfo.startCol) : 0;
                                            if (colOffset < 0) colOffset = 0;
                                            if (colOffset >= colsPerDate) colOffset = colsPerDate - 1;
                                            const gridPos = (rowOffset * colsPerDate) + colOffset;

                                            schedules.push({
                                                date: dateStr,
                                                name: emp.name,
                                                dept: emp.deptName,
                                                employee_id: emp.id,
                                                raw: text,
                                                grid_position: gridPos
                                            });

                                            console.log(`      ✅ ${emp.name}: row${rowOffset} col${colOffset} → pos ${gridPos}`);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                colIndex += colspan;
            }
        }
    }

    return {
        schedules: schedules,
        headerFound: detectedHeaders.length > 0,
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

// =============================================================================
// ✨ DB 적용 함수 (Targeted Overwrite)
// =============================================================================

/**
 * 파싱된 스케줄 데이터를 DB에 적용합니다.
 * WHY: 전체 삭제 대신 대상 직원(원장/진료실)만 해당 기간에서 삭제 후 삽입하여
 *      타 부서(행정팀, 기공실 등)의 기존 데이터를 보호합니다.
 */
async function applyImportedSchedules(newSchedules) {
    if (!newSchedules || newSchedules.length === 0) {
        throw new Error('적용할 스케줄 데이터가 없습니다.');
    }

    // 1. 대상 직원 ID와 날짜 범위 추출
    const targetEmpIds = [...new Set(newSchedules.map(s => s.employee_id))];
    const dates = [...new Set(newSchedules.map(s => s.date))].sort();
    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];

    console.log(`📥 applyImportedSchedules: ${newSchedules.length}건`);
    console.log(`   대상 직원: ${targetEmpIds.length}명, 기간: ${minDate} ~ ${maxDate}`);

    // 2. 대상 직원만 해당 기간에서 삭제 (타 부서 데이터 보존)
    const { error: deleteError } = await db.from('schedules')
        .delete()
        .gte('date', minDate)
        .lte('date', maxDate)
        .in('employee_id', targetEmpIds);

    if (deleteError) {
        console.error('❌ 기존 스케줄 삭제 실패:', deleteError);
        throw deleteError;
    }

    console.log('✅ 기존 스케줄 삭제 완료 (대상 직원만)');

    // 3. 새 데이터 삽입 (batch 50건 단위) — row_pos/col_pos 스키마
    const insertData = newSchedules.map(s => {
        const gp = s.grid_position;
        const onGrid = (gp != null && gp >= 0 && gp < 32);
        return {
            date: s.date,
            employee_id: s.employee_id,
            status: '근무',
            sort_order: gp,
            row_pos: onGrid ? Math.floor(gp / 4) : null,
            col_pos: onGrid ? (gp % 4) : null,
            is_annual_leave: false
        };
    });

    const BATCH_SIZE = 50;
    for (let i = 0; i < insertData.length; i += BATCH_SIZE) {
        const batch = insertData.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await db.from('schedules').insert(batch);
        if (insertError) {
            console.error(`❌ 배치 삽입 오류 (인덱스 ${i}):`, insertError);
            throw insertError;
        }
    }

    console.log('✅ 새 스케줄 삽입 완료');

    // 4. 화면 갱신
    if (window.loadAndRenderScheduleData) {
        await window.loadAndRenderScheduleData(state.schedule.currentDate);
    }

    alert(`✅ ${newSchedules.length}건의 스케줄이 성공적으로 적용되었습니다.`);
}
