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

        // 3. 전송 (no-cors 모드 주의: GAS 웹앱은 POST 응답을 제대로 받으려면 리다이렉트가 일어나는데 
        // fetch는 이를 opaque response로 처리할 수 있음.
        // 또는 text/plain으로 보내야 CORS 프리플라이트를 피할 수 있음)

        // GAS는 POST 요청 시 JSON.parse(e.postData.contents)로 읽으려면 Content-Type이 필요할 수 있으나
        // text/plain으로 보내고 GAS에서 파싱하는 게 가장 안전함.

        const response = await fetch(scriptUrl, {
            method: 'POST',
            mode: 'no-cors', // 불투명 응답 (성공 여부 알 수 없음)
            headers: {
                'Content-Type': 'text/plain;charset=utf-8',
            },
            body: JSON.stringify(payload)
        });

        // no-cors라 response.ok 확인 불가, response.json() 불가.
        // 에러가 안 나면 성공으로 간주하거나, GET으로 확인해야 함.
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

    const modalHtml = `
        <div id="paste-import-modal" class="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-6xl h-5/6 flex flex-col">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-bold">📆 앱시트 스케줄 가져오기 (복사-붙여넣기)</h3>
                    <button id="close-modal-x" class="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
                </div>

                <div class="grid grid-cols-2 gap-6 flex-1 min-h-0">
                    <!-- 왼쪽: 입력 -->
                    <div class="flex flex-col h-full">
                        <div class="mb-2 text-sm text-gray-700 bg-gray-50 p-3 rounded">
                            <label class="block font-bold mb-1">1. 적용할 월 선택</label>
                            <input type="month" id="import-month" value="${currentMonthStr}" class="border rounded px-2 py-1 w-full mb-3">
                            

                            <div class="flex items-center justify-between mb-1">
                                <p class="font-bold">2. 데이터 붙여넣기</p>
                                <label class="flex items-center space-x-2 text-xs text-gray-600 cursor-pointer select-none">
                                    <input type="checkbox" id="wrap-toggle" class="form-checkbox h-3 w-3 text-purple-600 rounded focus:ring-purple-500">
                                    <span class="font-medium">줄바꿈 (Word Wrap)</span>
                                </label>
                            </div>
                            <p class="text-xs text-gray-500 mb-1">앱시트(구글 시트)에서 날짜 행(예: 1일, 2일...)을 포함하여 스케줄 전체를 복사(Ctrl+C)한 뒤 아래에 붙여넣기(Ctrl+V) 하세요.</p>
                        </div>
                        <textarea id="paste-area" class="flex-1 w-full p-2 border border-gray-300 rounded font-mono text-xs whitespace-pre overflow-auto" placeholder="여기에 엑셀 데이터를 붙여넣으세요..."></textarea>
                        <button id="analyze-paste-btn" class="mt-2 w-full py-3 bg-purple-600 text-white rounded font-bold hover:bg-purple-700">🔍 데이터 분석 및 미리보기</button>
                    </div>

                    <!-- 오른쪽: 미리보기 -->
                    <div class="flex flex-col h-full bg-gray-50 rounded p-3 border border-gray-200">
                        <h4 class="font-bold mb-2 flex justify-between">
                            <span>미리보기 (적용 대상: 원장/진료실)</span>
                            <span id="preview-count" class="text-sm font-normal text-purple-600"></span>
                        </h4>
                        <div id="preview-container" class="flex-1 overflow-auto border bg-white text-xs">
                            <div class="p-4 text-center text-gray-400 mt-10">
                                왼쪽 테두리에 데이터를 붙여넣고 [분석] 버튼을 눌러주세요.
                            </div>
                        </div>
                        <div id="preview-actions" class="mt-2 text-right hidden">
                             <p class="text-xs text-red-500 mb-2 font-bold">* 기존 스케줄은 덮어쓰기 됩니다.</p>
                            <button id="apply-import-btn" class="px-6 py-3 bg-green-600 text-white rounded font-bold hover:bg-green-700 shadow-md">✅ 적용하기 (위치 포함)</button>
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
            if (confirm(`총 ${parsedDataResult.schedules.length}건의 스케줄을 적용하시겠습니까?`)) {
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
 */
function analyzePastedText(text, targetMonthStr) {
    const lines = text.split('\n').map(l => l.trimEnd());
    const targetDate = dayjs(targetMonthStr + '-01'); // 선택한 월의 1일
    const targetYear = targetDate.year();
    const targetMonth = targetDate.month() + 1; // 1-12

    // 1. 직원 정보 및 타겟 부서 매핑
    const targetDeptNames = ['원장', '진료', '진료실', '진료팀', '진료부'];
    const empMap = new Map();
    state.management.employees.forEach(e => {
        const dept = state.management.departments.find(d => d.id === e.department_id);
        if (dept) {
            empMap.set(e.name, {
                id: e.id,
                name: e.name,
                deptId: e.department_id,
                deptName: dept.name
            });
        }
    });

    let currentDates = {}; // { colIndex: { date: "YYYY-MM-DD", startColIdx: number } }
    const schedules = [];

    let headerRowIndex = -1;
    const skippedNames = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        const cells = line.split('\t');

        // A. 날짜 행 판단
        const dateIndices = [];
        cells.forEach((cell, idx) => {
            const trimmed = cell.trim();
            const match = trimmed.match(/(\d+)\s*일/) || trimmed.match(/^(\d+)\s*\(/);
            if (match) {
                dateIndices.push({ idx, day: parseInt(match[1], 10) });
            }
        });

        // 헤더 행 발견
        if (dateIndices.length >= 1) { // 1개라도 있으면 헤더로 의심 (2월 1일이 일요일이라 스킵될 수 있으므로 느슨하게)
            // 기존 currentDates가 있고, 데이터가 충분히 지나지 않았는데 또 나왔다? -> 다음 주 헤더
            // 그냥 매번 갱신
            currentDates = {};
            headerRowIndex = i;

            dateIndices.forEach(item => {
                const dateObj = dayjs(`${targetYear}-${targetMonth}-${item.day}`);
                if (dateObj.isValid()) {
                    const dateStr = dateObj.format('YYYY-MM-DD');
                    const info = { date: dateStr, startColIdx: item.idx };

                    // 해당 컬럼부터 +3 (총 4칸)까지 이 날짜 구역으로 설정
                    currentDates[item.idx] = info;
                    currentDates[item.idx + 1] = info;
                    currentDates[item.idx + 2] = info;
                    currentDates[item.idx + 3] = info;
                }
            });
            continue;
        }

        // B. 데이터 행 처리
        if (headerRowIndex === -1) continue;

        // 현재 행이 헤더로부터 얼마나 떨어져 있는지 (0부터 시작)
        const rowOffset = i - headerRowIndex - 1;
        if (rowOffset < 0) continue;

        // 너무 멀면(예: 30줄 아래) 다른 데이터일 수 있으니 무시? 
        // -> 보통 한 주 스케줄이 6~10줄 내외. 일단 제한두지 않음.

        cells.forEach((cell, idx) => {
            const rawName = cell.trim();
            if (!rawName) return;

            const dateInfo = currentDates[idx];
            if (!dateInfo) return; // 날짜 매핑 없는 칸

            // 필터 키워드
            if (['부족', '여유', '적정', '목표', '검수', '휴일'].some(k => rawName.includes(k))) return;

            let cleanName = rawName.replace(/\(.*\)/, '').replace(/[0-9.]/g, '').trim();
            if (cleanName.length < 2) return;

            const emp = empMap.get(cleanName);
            if (emp) {
                const isTarget = targetDeptNames.some(k => emp.deptName.includes(k));
                if (isTarget) {
                    // ✨ 그리드 포지션 계산
                    // 가로 오프셋 (0~3)
                    const colOffset = idx - dateInfo.startColIdx;
                    // 그리드 포지션 = (세로 * 4) + 가로
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
                            grid_position: gridPos // ✨ 위치 저장
                        });
                    }
                }
            }
        });
    }

    // 정렬 (미리보기용)
    schedules.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.grid_position - b.grid_position; // 위치 순 정렬
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
        container.innerHTML = `<div class="p-4 text-center text-red-500 font-bold">❌ 날짜 행을 찾을 수 없습니다.<br>복사한 데이터에 "1일", "2일" 같은 날짜가 포함되어 있어야 합니다.</div>`;
        actions.classList.add('hidden');
        return;
    }

    if (result.schedules.length === 0) {
        container.innerHTML = `<div class="p-4 text-center text-orange-500 font-bold">⚠️ 날짜는 찾았으나, 매칭되는 직권(원장/진료실)이 없습니다.<br>직원 이름이 DB와 일치하는지 확인해주세요.</div>`;
        actions.classList.add('hidden');
        return;
    }

    countSpan.textContent = `총 ${result.schedules.length}건`;
    actions.classList.remove('hidden');

    // 날짜별 그룹화
    const grouped = {};
    result.schedules.forEach(s => {
        if (!grouped[s.date]) grouped[s.date] = [];
        grouped[s.date].push(s);
    });

    // 날짜 오름차순 정렬
    const sortedDates = Object.keys(grouped).sort();

    // HTML 생성
    let html = `<div class="grid grid-cols-1 gap-4 p-2">`;

    sortedDates.forEach(date => {
        const daySchedules = grouped[date];
        const dayStr = dayjs(date).format('MM-DD (ddd)');

        // 최대 grid_position 찾기 (행 개수 결정용)
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

        // 그리드 셀 생성
        const totalCells = rowCount * 4;
        for (let i = 0; i < totalCells; i++) {
            const match = daySchedules.find(s => s.grid_position === i);
            if (match) {
                html += `
                    <div class="bg-white p-2 min-h-[60px] flex flex-col justify-center items-center text-center relative hover:bg-purple-50 transition-colors">
                        <span class="font-bold text-sm text-gray-800">${match.name}</span>
                        <span class="text-[10px] text-gray-500 block leading-tight mt-0.5">${match.dept}</span>
                        ${match.raw !== match.name ? `<span class="text-[9px] text-gray-400 block zoom-text absolute top-1 right-1" title="${match.raw}">*</span>` : ''}
                    </div>
                `;
            } else {
                html += `<div class="bg-gray-50 min-h-[60px]"></div>`; // 빈 셀
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

    // 2. 새 데이터 삽입 (grid_position 포함)
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
