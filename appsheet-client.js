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
 * 2. 구글 시트의 확정된 스케줄을 가져와서 Supabase에 저장
 */
/**
 * 2. [변경] 앱시트(엑셀) 복사 데이터를 붙여넣어 스케줄 가져오기
 *    - 원장, 진료실 부서만 업데이트
 */
export async function importFromAppSheet() {
    // 1. 모달 생성 (붙여넣기 입력창)
    const modalHtml = `
        <div id="paste-import-modal" class="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-4xl h-3/4 flex flex-col">
                <h3 class="text-lg font-bold mb-4">앱시트 스케줄 붙여넣기</h3>
                <div class="mb-2 text-sm text-gray-600">
                    <p>1. 구글 시트(앱시트)에서 스케줄 영역을 복사(Ctrl+C)하세요.</br>(날짜 행과 이름들이 포함되도록 넓게 복사해주세요)</p>
                    <p>2. 아래 상자에 붙여넣기(Ctrl+V) 한 후 [분석 및 가져오기]를 누르세요.</p>
                </div>
                <textarea id="paste-area" class="flex-1 w-full p-4 border border-gray-300 rounded mb-4 font-mono text-xs whitespace-pre" placeholder="여기에 엑셀 데이터를 붙여넣으세요..."></textarea>
                <div class="flex justify-end gap-2">
                    <button id="cancel-paste-btn" class="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600">취소</button>
                    <button id="analyze-paste-btn" class="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700">분석 및 가져오기</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // 이벤트 핸들러
    const modal = document.getElementById('paste-import-modal');
    const textarea = document.getElementById('paste-area');
    const cancelBtn = document.getElementById('cancel-paste-btn');
    const analyzeBtn = document.getElementById('analyze-paste-btn');

    textarea.focus();

    const closeModal = () => modal.remove();

    cancelBtn.onclick = closeModal;
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };

    analyzeBtn.onclick = async () => {
        const text = textarea.value;
        if (!text.trim()) {
            alert('데이터를 붙여넣어주세요.');
            return;
        }

        try {
            await processPastedData(text);
            closeModal();
        } catch (err) {
            alert(err.message);
        }
    };
}

async function processPastedData(text) {
    const lines = text.split('\n').map(l => l.trimEnd()); // 행 단위 분리
    const rawSchedules = [];
    const debugLogs = [];

    // 1. 날짜 헤더 찾기 (예: "1일 (월)", "2일 (화)")
    //    가장 많은 "N일" 패턴이 있는 행을 헤더로 간주하거나, 등장하는 족족 처리
    //    구글 시트 복사 시 탭(\t)으로 컬럼 구분됨

    let currentDates = {}; // { columnIndex: "YYYY-MM-DD" }
    const currentYear = dayjs(state.schedule.currentDate).year();
    const currentMonth = dayjs(state.schedule.currentDate).month() + 1; // 사용자가 보고 있는 월 기준

    // 부서 정보 매핑 준비
    const targetDeptNames = ['원장', '진료', '진료실', '진료팀', '진료부']; // 타겟 키워드
    const empMap = new Map(); // Name -> { id, deptId, deptName }

    state.management.employees.forEach(e => {
        const dept = state.management.departments.find(d => d.id === e.department_id);
        empMap.set(e.name, {
            id: e.id,
            deptId: e.department_id,
            deptName: dept ? dept.name : ''
        });
    });

    const parsedSchedules = [];
    const skippedNames = new Set();
    const targetUpdates = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cells = line.split('\t'); // 엑셀 붙여넣기는 탭 구분

        // A. 날짜 행인지 판단
        const dayMatchIndices = [];
        cells.forEach((cell, idx) => {
            if (/^\d+일/.test(cell.trim())) {
                dayMatchIndices.push(idx);
            }
        });

        if (dayMatchIndices.length > 0) {
            // 날짜 헤더 갱신
            currentDates = {};
            dayMatchIndices.forEach(idx => {
                const dayStr = cells[idx].match(/(\d+)일/)[1];
                const dayNum = parseInt(dayStr, 10);
                // "1일"이 나오는데 현재 뷰가 말일쯤이면 다음달? 아니면 그냥 현재 보고 있는 월의 날짜로 간주
                // 안전하게: 현재 state.currentDate의 월을 따름
                const date = dayjs(`${currentYear}-${currentMonth}-${dayNum}`).format('YYYY-MM-DD');

                // 엑셀 병합 셀 이슈: 날짜 하나가 4칸 차지할 수 있음 (Main 시트 구조상)
                // 따라서 idx, idx+1, idx+2... 를 해당 날짜로 매핑해야 함.
                // 다음 날짜 인덱스가 나올 때까지 채우기
                // 하지만 여기선 단순하게: 날짜가 있는 idx가 시작점.
                // 보통 병합된 셀을 복사하면 첫 셀에만 값이 있나? -> 브라우저/엑셀 버전에 따라 다름.
                // 보통 그냥 빈칸으로 나옴.
                // 일단 정확한 "값"이 있는 컬럼을 기준으로 잡고, 그 아래 이름들을 매핑

                // 오프셋 처리: 보통 한 날짜에 4명의 원장/직원이 들어갈 수 있음 (4열)
                // 다음 날짜 인덱스 전까지 모두 이 날짜로 할당해야 함.
                currentDates[idx] = date;
                currentDates[idx + 1] = date;
                currentDates[idx + 2] = date;
                currentDates[idx + 3] = date; // 넉넉히 4칸 할당
            });
            continue; // 헤더 행은 스킵
        }

        // B. 데이터 행 처리
        if (Object.keys(currentDates).length === 0) continue; // 날짜 매핑이 안된 상태면 스킵

        cells.forEach((cell, idx) => {
            const name = cell.trim();
            if (!name) return;
            if (!currentDates[idx]) return;

            // 예외 키워드
            if (['부족', '여유', '적정', '목표:', '주간 검수'].some(k => name.includes(k))) return;

            // 이름 정제
            const cleanName = name.replace(/\(.*\)/, '').replace(/[0-9]/g, '').trim(); // 괄호 및 숫자 제거
            if (!cleanName) return;

            const empInfo = empMap.get(cleanName);
            const date = currentDates[idx];

            if (empInfo) {
                // 부서 체크
                const isTarget = targetDeptNames.some(k => empInfo.deptName.includes(k));
                if (isTarget) {
                    parsedSchedules.push({
                        date: date,
                        employee_id: empInfo.id,
                        name: cleanName,
                        dept: empInfo.deptName
                    });
                } else {
                    skippedNames.add(`${cleanName}(${empInfo.deptName})`);
                }
            } else {
                // DB에 없는 이름
                //  console.log('Unmapped name:', cleanName); 
            }
        });
    }

    if (parsedSchedules.length === 0) {
        throw new Error('유효한 스케줄 데이터를 찾지 못했습니다.\n- 날짜 행("1일")을 포함해서 복사했는지 확인해주세요.\n- 직원 이름이 정확한지 확인해주세요.');
    }

    const uniqueSchedules = [];
    const seen = new Set();
    parsedSchedules.forEach(s => {
        const key = `${s.date}_${s.employee_id}`;
        if (!seen.has(key)) {
            uniqueSchedules.push(s);
            seen.add(key);
        }
    });

    const targetEmployees = new Set(uniqueSchedules.map(s => s.name));
    const confirmMsg = `✅ 분석 완료!\n\n` +
        `- 대상 기간: ${dayjs(state.schedule.currentDate).format('YYYY-MM')}\n` +
        `- 업데이트 대상 직원: ${targetEmployees.size}명 (원장/진료실)\n` +
        `- 총 스케줄 건수: ${uniqueSchedules.length}건\n\n` +
        `이 데이터를 적용하시겠습니까?\n(대상 직원의 기존 스케줄은 덮어씌워집니다)`;

    if (!confirm(confirmMsg)) return;

    // DB 업데이트 로직
    await applyImportedSchedules(uniqueSchedules);
}

async function applyImportedSchedules(newSchedules) {
    // 1. 업데이트 대상 직원 ID 목록 추출
    const targetEmpIds = [...new Set(newSchedules.map(s => s.employee_id))];

    // 2. 날짜 범위 추출
    const dates = newSchedules.map(s => s.date);
    const minDate = dates.sort()[0];
    const maxDate = dates.sort()[dates.length - 1];

    if (!minDate || !maxDate) return;

    // 3. 기존 데이터 삭제 (범위 내, 타겟 직원들만)
    const { error: delError } = await db.from('schedules')
        .delete()
        .gte('date', minDate)
        .lte('date', maxDate)
        .in('employee_id', targetEmpIds); // ✨ 중요: 타겟 직원만 삭제

    if (delError) throw new Error('기존 데이터 삭제 실패: ' + delError.message);

    // 4. 새 데이터 삽입
    const insertData = newSchedules.map((s, idx) => ({
        date: s.date,
        employee_id: s.employee_id,
        status: '근무',
        sort_order: idx, // 대충 순서 넣기 (화면에서 자동 정렬됨)
        grid_position: idx % 20 // 임시 포지션
    }));

    // 배치 처리
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
