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
export async function importFromAppSheet() {
    const scriptUrl = getScriptUrl();
    if (!scriptUrl) {
        alert('AppSheet 스크립트 URL이 설정되지 않았습니다.');
        return;
    }

    const month = dayjs(state.schedule.currentDate).format('YYYY-MM');

    if (!confirm(`${month}월 스케줄을 AppSheet에서 가져오시겠습니까?\n기존 스케줄은 덮어씌워집니다.`)) return;

    try {
        // GET 요청은 CORS 문제 없이 JSON 받기 가능 (GAS가 적절히 헤더를 주면)
        // GAS 코드에 setMimeType(JSON)이 있으면 보통 리다이렉트 팔로우해서 됨.
        const url = `${scriptUrl}?action=getSchedule&month=${month}`;

        const response = await fetch(url, { method: 'GET' });
        const result = await response.json();

        if (result.status !== 'success') {
            throw new Error(result.message || 'Unknown error form script');
        }

        const rawSchedules = result.data; // [{date, name, status, team?}]
        if (!rawSchedules || rawSchedules.length === 0) {
            alert('가져올 스케줄 데이터가 없습니다. (확정된 시트가 있는지 확인하세요)');
            return;
        }

        console.log(`📥 가져온 스케줄: ${rawSchedules.length}건`);

        // 1. 직원 매핑 (이름 -> ID)
        const { data: employees } = await db.from('employees').select('id, name');
        const empMap = new Map();
        employees.forEach(e => empMap.set(e.name, e.id));

        const newSchedules = [];
        const unknownNames = new Set();

        let sortCounter = 0; // 간단한 정렬 순서

        rawSchedules.forEach(item => {
            const empId = empMap.get(item.name);
            if (!empId) {
                unknownNames.add(item.name);
                return;
            }

            // 이미 해당 날짜/직원 스케줄이 중복되는지 체크? (DB Insert 시 충돌날 수 있으니)
            // 일단 다 모은다.
            newSchedules.push({
                date: item.date,
                employee_id: empId,
                status: '근무', // AppSheet는 근무자만 줌
                sort_order: sortCounter++,
                grid_position: sortCounter // 임시
            });
        });

        if (unknownNames.size > 0) {
            alert(`⚠️ 다음 직원은 이름을 찾을 수 없어 제외되었습니다:\n${[...unknownNames].join(', ')}`);
        }

        // 2. DB 저장
        // 해당 월 기존 데이터 삭제
        const startOfMonth = dayjs(month).startOf('month').format('YYYY-MM-DD');
        const endOfMonth = dayjs(month).endOf('month').format('YYYY-MM-DD');

        await db.from('schedules').delete().gte('date', startOfMonth).lte('date', endOfMonth);

        // 배치 삽입
        const BATCH_SIZE = 100;
        for (let i = 0; i < newSchedules.length; i += BATCH_SIZE) {
            const batch = newSchedules.slice(i, i + BATCH_SIZE);
            const { error } = await db.from('schedules').insert(batch);
            if (error) throw error;
        }

        alert('스케줄 가져오기 성공!');

        // 화면 갱신
        if (window.loadAndRenderScheduleData) {
            window.loadAndRenderScheduleData(state.schedule.currentDate);
        } else {
            location.reload();
        }

    } catch (error) {
        console.error('Import Error:', error);
        alert('스케줄 가져오기 실패: ' + error.message);
    }
}
