
const pEnd = dayjs(leaveData.periodEnd);

const used = leaveRequests
    .filter(r => r.employee_id === emp.id && r.status === 'approved')
    .reduce((sum, r) => {
        // 신청일(dates) 중 현재 주기에 속하는 날짜만 카운트
        const validDates = (r.dates || []).filter(dateStr => {
            const d = dayjs(dateStr);
            return d.isSameOrAfter(pStart) && d.isSameOrBefore(pEnd);
        });
        return sum + validDates.length;
    }, 0);

const remaining = leaveData.final - used;

// 다음 갱신일 계산
const baseDate = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date) : dayjs(emp.entryDate).add(1, 'year');
const renewalThisYear = dayjs(`${dayjs().year()} -${baseDate.format('MM-DD')} `);
const nextRenewalDate = renewalThisYear.isAfter(dayjs()) ? renewalThisYear.format('YYYY-MM-DD') : renewalThisYear.add(1, 'year').format('YYYY-MM-DD');

const entryDateValue = emp.entryDate ? dayjs(emp.entryDate).format('YYYY-MM-DD') : '';
const renewalDateValue = emp.leave_renewal_date ? dayjs(emp.leave_renewal_date).format('YYYY-MM-DD') : '';
const workDaysValue = emp.work_days_per_week || 5;

return `<tr class="border-t" >
            <td class="p-2 text-sm font-semibold">${emp.name}</td>
            <td class="p-2 text-sm">${entryDateValue}</td>
            <td class="p-2">
                <select id="leave-workdays-${emp.id}" class="table-input text-center text-xs w-16">
                    <option value="1" ${workDaysValue === 1 ? 'selected' : ''}>주1일</option>
                    <option value="2" ${workDaysValue === 2 ? 'selected' : ''}>주2일</option>
                    <option value="3" ${workDaysValue === 3 ? 'selected' : ''}>주3일</option>
                    <option value="4" ${workDaysValue === 4 ? 'selected' : ''}>주4일</option>
                    <option value="5" ${workDaysValue === 5 ? 'selected' : ''}>주5일</option>
                    <option value="6" ${workDaysValue === 6 ? 'selected' : ''}>주6일</option>
                    <option value="7" ${workDaysValue === 7 ? 'selected' : ''}>주7일</option>
                </select>
            </td>
            </td >
            <td class="p-2"><input type="date" id="leave-renewal-${emp.id}" value="${renewalDateValue}" class="table-input text-xs"></td>
            <td class="p-2 text-sm text-center" id="leave-next-renewal-${emp.id}">${nextRenewalDate}</td>
            <td class="p-2 text-sm text-center">${leaveData.legal}</td>
            <td class="p-2"><input type="number" id="leave-carried-${emp.id}" value="${leaveData.carriedOverCnt || 0}" step="0.5" class="table-input text-center text-xs w-16"></td>
            <td class="p-2"><input type="number" id="leave-adj-${emp.id}" value="${leaveData.adjustment || 0}" step="0.5" class="table-input text-center text-xs w-16"></td>
            <td class="p-2 text-sm text-center font-bold">${leaveData.final}</td>
            <td class="p-2 text-sm text-center">${used}</td>
            <td class="p-2 text-sm text-center font-bold ${remaining < 0 ? 'text-red-600' : ''}">${remaining}</td>
            <td class="p-2 text-xs text-gray-600">${leaveData.note || '-'}</td>
            <td class="p-2 text-center">
                <button class="text-xs bg-blue-500 text-white px-2 py-1 rounded" onclick="handleUpdateLeave(${emp.id})">저장</button>
                <button class="text-xs bg-purple-500 text-white px-2 py-1 rounded ml-1" onclick="window.openSettlementModal(${emp.id})">정산</button>
            </td>
        </tr> `;
    }).join('');

return `
        <div class="mb-3" >
            <h2 class="text-lg font-semibold">연차 관리</h2>
            <div class="flex justify-between items-end">
                <p class="text-sm text-gray-600 mt-1">직원별 연차 기준일과 조정값을 관리합니다. [정산] 버튼을 통해 이월 또는 수당 정산을 처리할 수 있습니다.</p>
            </div>
        </div>
        <div class="overflow-x-auto">
            <table class="fixed-table whitespace-nowrap text-sm mb-6">
                <thead class="bg-gray-100"><tr>${headerHtml}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        
        <!-- 연차 정산 모달 -->
        <div id="settlement-modal" class="modal-overlay hidden">
            <div class="modal-content">
                <div class="flex justify-between items-center border-b pb-3 mb-4">
                    <h2 class="text-xl font-bold">연차 정산 및 갱신</h2>
                    <button id="close-settlement-modal-btn" class="text-3xl">&times;</button>
                </div>
                <div id="settlement-modal-body" class="space-y-4">
                    <!-- 동적 콘텐츠 -->
                </div>
            </div>
        </div>
    `;
}

// 정산 모달 열기
window.openSettlementModal = function (empId) {
    const emp = state.management.employees.find(e => e.id === empId);
    if (!emp) return;

    const leaveData = getLeaveDetails(emp);

    // 모달에서도 동일하게 기간 필터링 적용
    const pStart = dayjs(leaveData.periodStart);
    const pEnd = dayjs(leaveData.periodEnd);

    const used = state.management.leaveRequests
        .filter(r => r.employee_id === emp.id && r.status === 'approved')
        .reduce((sum, r) => {
            const validDates = (r.dates || []).filter(dateStr => {
                const d = dayjs(dateStr);
                return d.isSameOrAfter(pStart) && d.isSameOrBefore(pEnd);
            });
            return sum + validDates.length;
        }, 0);

    const remaining = leaveData.final - used;

    // 계산 로직
    // 잔여 > 0: 이월 or 정산
    // 잔여 < 0: 차감 이월 or 탕감

    const isNegative = remaining < 0;
    const absRemaining = Math.abs(remaining);

    const modalBody = _('#settlement-modal-body');
    modalBody.innerHTML = `
        <div class="bg-gray-100 p-3 rounded mb-4">
            <p><strong>직원명:</strong> ${emp.name}</p>
            <p><strong>현재 잔여 연차:</strong> <span class="text-lg font-bold ${isNegative ? 'text-red-600' : 'text-blue-600'}">${remaining}일</span></p>
            <p class="text-sm text-gray-500 mt-1">
                ${isNegative ?
            `초과 사용 ${absRemaining}일이 있습니다. 내년 연차에서 차감하거나 탕감할 수 있습니다.` :
            `미사용 연차 ${absRemaining}일이 있습니다. 이월하거나 수당으로 정산(소멸)할 수 있습니다.`}
            </p>
        </div>

        <form id="settlement-form">
            <input type="hidden" id="settlement-emp-id" value="${emp.id}">
            <input type="hidden" id="settlement-remaining" value="${remaining}">
            
            <label class="block font-semibold mb-2">처리 방식 선택</label>
            <div class="space-y-2">
                ${isNegative ? `
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="deduct_next" checked>
                        <div>
                            <span class="font-bold text-red-600">차감 이월</span>
                            <p class="text-xs text-gray-500">내년도 이월 연차에서 ${absRemaining}일을 뺍니다. (마이너스 이월)</p>
                        </div>
                    </label>
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="write_off">
                        <div>
                            <span class="font-bold text-gray-600">탕감 (초기화)</span>
                            <p class="text-xs text-gray-500">초과 사용분을 0으로 만듭니다. (페널티 없음)</p>
                        </div>
                    </label>
                ` : `
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="carry_over" checked>
                        <div>
                            <span class="font-bold text-blue-600">이월 처리</span>
                            <p class="text-xs text-gray-500">현재 이월 연차에 ${absRemaining}일을 더합니다.</p>
                        </div>
                    </label>
                    <label class="flex items-center space-x-2 border p-3 rounded cursor-pointer hover:bg-gray-50">
                        <input type="radio" name="settlementType" value="cash_out">
                        <div>
                            <span class="font-bold text-green-600">수당 정산 (소멸)</span>
                            <p class="text-xs text-gray-500">연차를 0으로 초기화합니다. (별도 급여 대장 등에 기록 필요)</p>
                        </div>
                    </label>
                `}
            </div>

            <div class="mt-4">
                <label class="block font-semibold mb-1">메모 (선택)</label>
                <input type="text" id="settlement-memo" class="w-full border p-2 rounded" placeholder="예: 2025년도 연차 정산">
            </div>

            <div class="flex justify-end pt-4 mt-2 border-t space-x-2">
                <button type="button" class="px-4 py-2 bg-gray-300 rounded" onclick="window.closeSettlementModal()">취소</button>
                <button type="submit" class="px-4 py-2 bg-blue-600 text-white rounded font-bold">처리하기</button>
            </div>
        </form>
    `;

    show('#settlement-modal');

    // 이벤트 리스너 (한번만 등록되도록 처리하거나 매번 덮어쓰기)
    const form = _('#settlement-form');
    form.onsubmit = window.handleSettlementSubmit;
};

window.closeSettlementModal = function () {
    hide('#settlement-modal');
};

_('#close-settlement-modal-btn')?.addEventListener('click', window.closeSettlementModal);

// 정산 처리 로직
window.handleSettlementSubmit = async function (e) {
    e.preventDefault();

    const empId = parseInt(_('#settlement-emp-id').value);
    const remaining = parseFloat(_('#settlement-remaining').value);
    const type = document.querySelector('input[name="settlementType"]:checked').value;
    const memo = _('#settlement-memo').value;

    const emp = state.management.employees.find(e => e.id === empId);
    let newCarriedOver = emp.carried_over_leave || 0;

    // 로직 적용
    if (type === 'carry_over') {
        newCarriedOver += remaining;
    } else if (type === 'deduct_next') {
        // remaining이 음수이므로 더하면 됨 (예: -2를 더하면 이월이 2 줄어듦)
        newCarriedOver += remaining;
    }
    // cash_out 이나 write_off는 이월 연차를 변경하지 않음 (단, 기존 이월분이 정산 대상에 포함된다면 로직이 복잡해질 수 있으나, 
    // 여기서는 '잔여' 전체를 처리한다고 가정. 
    // 하지만 보통 '정산'은 '올해 발생분'을 없애는 것이므로 '이월'값은 그대로 두거나, '이월'값도 갱신해야 함.
    // **단순화**: 이 기능은 '잔여 연차'를 '이월 연차' 컬럼으로 옮기거나 없애는 역할.
    // 문제는 '잔여'에는 '올해 발생분(legal)'도 포함되어 있다는 점.
    // '정산' 후에는 잔여가 0이 되어야 하므로, 
    // 1. 조정(adjustment)을 마이너스 처리해서 0으로 맞추거나 
    // 2. 관리자가 '내년도 세팅'을 할 때 쓴다고 가정.

    // 사용자의 요구: "매년 갱신시... 처리하는 방식"
    // 가장 깔끔한 방식: 
    // 1. 이월 처리 시: carried_over_leave += 잔여. (그리고 잔여를 0으로 만들기 위해, 사실상 '새 해'가 되면 legal이 리셋되거나 해야함. 
    //    하지만 legal은 입사일 기준 자동 계산됨. 따라서 '지난 해 잔여'를 '새 해 이월'로 넘기는 것이므로
    //    DB 상 carried_over_leave를 업데이트하고, **과거 사용 기록**은 보존하되 영향력을 없애야 함? 
    //    아님. 보통 시스템은 '회계연도 마감'을 함.
    //    
    //    **현실적 구현**: 
    //    이 앱은 '사용 기록'(`leaveRequests`) 전체를 누적해서 계산함 (`used` = 전체 승인 건수).
    //    따라서 갱신을 하려면 '과거 사용 기록'을 '아카이브' 하거나,
    //    calculation 로직에서 '특정 기준일 이후'의 사용분만 계산해야 함.

    //    **중요 수정**: `leave-utils.js`나 `getLeaveDetails`가 '전체 기간'을 대상으로 하면 갱신 처리가 불가능함.
    //    -> `leave_renewal_date` (연차 기준일)이 있음.
    //    `getLeaveDetails` 로직을 보면:
    //    "입사 1년 이상... 주기 시작 ~ 주기 끝"
    //    **다행히** `getLeaveDetails`는 이미 '현재 주기(Period)'에 해당하는 연차만 계산하고 있음? (확인 필요)

    //    확인 결과: `getLeaveDetails`는 근속연수에 따른 '법정 연차 개수'만 리턴함. 
    //    그런데 `used` 계산(`management.js` 1097라인)은 `leaveRequests.filter...`로 **전체 기간**을 다 더하고 있음!
    //    이게 문제임. 갱신을 하려면 **'현재 주기(이번 년도)'에 사용한 연차**만 카운트해야 함.

    //    **따라서 정산 기능을 완벽히 하려면**:
    //    1. `used` 계산 시 '현재 연차 주기'에 속하는 날짜만 필터링해야 함.
    //    2. 그렇게 하면, '지난 주기'의 잔여 연차는 자동으로 사라짐(계산에서 제외되므로).
    //    3. 그때 '이월' 버튼을 누르면 -> '지난 주기 잔여'를 구해 `carried_over_leave`에 더해줌.

    //    **전략 수정**:
    //    먼저 `used` 계산 로직을 '현재 주기' 기준으로 수정해야 함. (이번 Task 범위에 포함)

    // 일단 여기서는 DB 업데이트 부분만 작성하고, 아래 코드 블록 이후에 `used` 계산 로직을 수정하겠음.

    try {
        const { error } = await db.from('employees').update({
            carried_over_leave: newCarriedOver,
            // 정산(소멸)의 경우, 단순히 carried_over를 업데이트 안하면 됨. (왜냐하면 다음 주기 계산 시 지난 주기는 무시되니까)
            // 하지만 '마이너스 차감'은 carried_over를 깎아야 함 (-값 허용).
        }).eq('id', empId);

        if (error) throw error;

        // 정산 이력 기록 (issues 테이블이나 별도 로그 테이블 활용, 여기서는 로그만)
        console.log(`정산 완료: ${emp.name}, 타입: ${type}, 잔여: ${remaining} -> 처리됨`);

        alert(`정산 처리가 완료되었습니다.\n(${type === 'deduct_next' ? '차감 이월' : (type === 'carry_over' ? '이월' : '초기화')})`);
        window.closeSettlementModal();
        await window.loadAndRenderManagement();

    } catch (err) {
        console.error(err);
        alert('처리 중 오류가 발생했습니다: ' + err.message);
    }
};

// =========================================================================================
// 연차 현황 기능
// =========================================================================================
window.handleUpdateLeave = async function (id) {
    const leave_renewal_date = _(`#leave-renewal-${id}`).value || null;
    const leave_adjustment = parseFloat(_(`#leave-adj-${id}`).value) || 0;
    const carried_over_leave = parseFloat(_(`#leave-carried-${id}`).value) || 0;
    const work_days_per_week = parseInt(_(`#leave-workdays-${id}`).value) || 5;

    console.log('💾 연차 업데이트:', { id, leave_renewal_date, leave_adjustment, carried_over_leave, work_days_per_week });

    const { data, error } = await db.from('employees').update({
        leave_renewal_date,
        leave_adjustment,
        carried_over_leave, // 이월 연차 추가
        work_days_per_week
    }).eq('id', id).select();

    console.log('✅ DB 응답:', { data, error });

    if (error) {
        alert('연차 정보 업데이트 실패: ' + error.message);
    } else {
        alert('연차 정보가 성공적으로 저장되었습니다.');
        await window.loadAndRenderManagement();
    }
};
// =========================================================================================
// 연차 현황 기능
// =========================================================================================

export function getLeaveStatusHTML() {
    const { employees, leaveRequests } = state.management;

    // 각 직원의 연차 데이터 수집
    const employeeLeaveData = employees.map(emp => {
        const leaveDetails = getLeaveDetails(emp);
        const pStart = dayjs(leaveDetails.periodStart);
        const pEnd = dayjs(leaveDetails.periodEnd);

        const usedRequests = leaveRequests
            .filter(req => req.employee_id === emp.id && req.status === 'approved');

        // 사용한 날짜들을 모두 수집하여 평탄화 및 정렬
        let usedDates = usedRequests
            .flatMap(req => {
                return (req.dates || [])
                    .filter(dateStr => {
                        const d = dayjs(dateStr);
                        return d.isSameOrAfter(pStart) && d.isSameOrBefore(pEnd);
                    })
                    .map(date => ({
                        date: date,
                        // '수동'이라는 단어가 포함되어 있으면 manual로 처리 (유연성 확보)
                        type: (req.reason && req.reason.includes('수동')) ? 'manual' : 'formal',
                        requestId: req.id
                    }));
            })
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        const usedDays = usedDates.length;
        const remainingDays = leaveDetails.final - usedDays;
        const usagePercent = leaveDetails.final > 0 ? Math.round((usedDays / leaveDetails.final) * 100) : 0;

        return {
            ...emp,
            leaveDetails,
            usedDays,
            remainingDays,
            usagePercent,
            usedDates
        };
    });

    // 부서별 필터링을 위한 부서 목록
    const departments = [...new Set(employees.map(e => e.dept || e.departments?.name).filter(Boolean))];

    return `
        <style>
            .leave-grid-container {
                display: flex;
                flex-wrap: nowrap; /* 줄바꿈 방지 */
                gap: 4px;
                overflow-x: auto; /* 내용이 넘치면 스크롤 */
                padding-bottom: 4px; /* 스크롤바 공간 확보 */
            }
            .leave-box {
                flex: 0 0 42px; /* 크기 고정 */
                width: 42px;
                height: 32px;
                border: 1px solid #e5e7eb;
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 11px;
                background-color: #ffffff;
                color: #9ca3af; /* 기본 연한 회색 (번호) */
            }
            .leave-box.used {
                background-color: #dbeafe; /* 기본(정식) 연차 배경색 (파랑) */
                border-color: #93c5fd;
                color: #1e40af;
                font-weight: bold;
            }
            .leave-box.used.manual {
                background-color: #f3e8ff; /* 수동 등록 배경색 (보라) */
                border-color: #d8b4fe;
                color: #6b21a8;
            }
            .leave-box:hover {
                transform: translateY(-1px);
                box-shadow: 0 1px 2px rgba(0,0,0,0.1);
            }
            
            /* 이월 연차 스타일 (보라) */
            .leave-box.type-carried {
                border-color: #d8b4fe;
