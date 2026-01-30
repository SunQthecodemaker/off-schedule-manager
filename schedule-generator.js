
/**
 * schedule-generator.js
 * 엑셀(AppSheet)의 자동 배정 로직을 웹으로 이식한 모듈입니다.
 * 
 * [핵심 기능]
 * 1. generateSchedule(year, month, employees, leaves, holidays)
 *    - 해당 월의 모든 날짜에 대해 스케줄을 생성하여 반환합니다.
 * 2. calculateDailyAllocation(date, ...)
 *    - 하루치 배정을 계산합니다 (원장님 별 5명 제한, 팀 매칭).
 */

export class ScheduleGenerator {
    constructor() {
        // 원장님 설정 (하드코딩된 규칙 - 엑셀 로직 기반)
        this.DOCTORS = [
            { name: '박원장', to: 5, offRule: '목', id: 'dr_park' },
            { name: '류원장', to: 5, offRule: '화', id: 'dr_ryu' },
            { name: '최원장', to: 5, offRule: '수', id: 'dr_choi' },
            { name: '김원장', to: 5, offRule: '월', id: 'dr_kim' }
        ];

        // 엑셀의 '설정' 시트 값
        this.SETTINGS = {
            maxPerDoc: 5,
            workLimit: 5
        };
    }

    /**
     * 스케줄 생성 메인 함수
     * @param {number} year 
     * @param {number} month (0-indexed)
     * @param {Array} employees DB 직원 목록
     * @param {Array} leaves 승인된 연차 목록
     * @param {Set} companyHolidays 병원 휴무일 Set
     * @returns {Array} 생성된 스케줄 객체 배열
     */
    generate(year, month, employees, leaves, companyHolidays) {
        const startDate = dayjs(new Date(year, month, 1));
        const endDate = startDate.endOf('month');
        const generatedSchedules = [];

        let currentDate = startDate.clone();

        // 주간 근무 카운트 초기화
        let weeklyCounts = {};
        employees.forEach(e => weeklyCounts[e.id] = 0);

        // 로테이션을 위한 오프셋 (매일 원장님 배정 순서를 변경하기 위함)
        let rotationOffset = 0;

        while (currentDate.isSameOrBefore(endDate)) {
            const dateStr = currentDate.format('YYYY-MM-DD');
            const dayNum = currentDate.day(); // 0: 일, 1: 월...

            // 월요일이면 주간 카운트 리셋
            if (dayNum === 1) {
                employees.forEach(e => weeklyCounts[e.id] = 0);
            }

            // 일요일은 스킵 (근무 없음)
            if (dayNum === 0) {
                currentDate = currentDate.add(1, 'day');
                continue;
            }

            // 병원 휴무일이면 스킵
            if (companyHolidays.has(dateStr)) {
                currentDate = currentDate.add(1, 'day');
                continue;
            }

            // 하루 배정 계산
            const dailyResult = this.calculateDailyAllocation(
                currentDate,
                employees,
                leaves,
                weeklyCounts,
                rotationOffset
            );

            // 결과 -> 스케줄 객체 변환
            // 0~3: 원장님 (헤더용 더미 또는 실제 표시)
            // 4~7: 1팀 (박원장)
            // 8~11: 2팀 (류원장)
            // 12~15: 3팀 (최원장)
            // 16~19: 4팀 (김원장)
            // 20~23: 예비/기타

            // 1. 원장님 배치 (0~3)
            // 원장님은 스케줄 테이블에 저장하지 않음 (직원만 저장)

            // 2. 직원 배치
            // 각 원장님 별 배정된 직원을 그리드 위치에 매핑
            const gridMapping = [
                { dr: '박원장', start: 4 },
                { dr: '류원장', start: 8 },
                { dr: '최원장', start: 12 },
                { dr: '김원장', start: 16 }
            ];

            gridMapping.forEach((mapItem, docIdx) => {
                const docName = mapItem.dr;
                const assignedStaffs = dailyResult.allocation[docName] || [];

                assignedStaffs.forEach((staff, i) => {
                    const gridPos = mapItem.start + i;
                    if (gridPos < 24) { // 그리드 범위 체크
                        generatedSchedules.push({
                            date: dateStr,
                            employee_id: staff.id,
                            status: '근무',
                            grid_position: gridPos,
                            sort_order: gridPos // 정렬 순서도 그리드 위치와 동일하게
                        });

                        // 근무 카운트 증가
                        weeklyCounts[staff.id] = (weeklyCounts[staff.id] || 0) + 1;
                    }
                });
            });

            // 매일 로테이션 변경
            rotationOffset++;

            currentDate = currentDate.add(1, 'day');
        }

        return generatedSchedules;
    }

    /**
     * 하루치 배정 로직 (Core Logic)
     */
    calculateDailyAllocation(date, employees, leaves, weeklyCounts, rotationOffset) {
        const dateStr = date.format('YYYY-MM-DD');
        const dayName = ['일', '월', '화', '수', '목', '금', '토'][date.day()];
        const weekNum = Math.ceil(date.date() / 7);

        const allocation = { '박원장': [], '류원장': [], '최원장': [], '김원장': [] };
        const doctorStatus = {};

        // 1. 원장님 근무 여부 확인
        this.DOCTORS.forEach(doc => {
            let isWorking = !this.isDoctorOff(doc.offRule, dayName, weekNum);
            doctorStatus[doc.name] = { isWorking };
        });

        // 2. 근무 가능 직원 필터링
        const availableStaff = employees.filter(emp => {
            // 퇴사자 제외
            if (emp.status === 'retired') return false;

            // 연차 확인
            const isOnLeave = leaves.some(l => {
                // l.dates 배열에 dateStr이 포함되어 있는지 확인
                // Supabase에서 가져온 leaves 데이터 구조에 따라 l.dates가 배열일 수도 있고,
                // start_date, end_date 범위일 수도 있음. 여기서는 dates 배열로 가정하거나 범위 체크 필요.
                // 현재 Documents.js 등에서 dates 배열을 사용하는지 확인 필요하나, 
                // 통상적으로 l.dates = ['2023-01-01', ...] 형태를 가정.
                return l.employee_id === emp.id && (l.dates && l.dates.includes(dateStr));
            });
            if (isOnLeave) return false;

            // 주간 근무 한도 (5일) 체크
            if ((weeklyCounts[emp.id] || 0) >= this.SETTINGS.workLimit) return false;

            // 고정 휴무일 체크
            if (emp.regular_holiday_rules && emp.regular_holiday_rules.includes(dayName)) return false;

            return true;
        });

        // 3. 부서별 그룹화 및 배정
        // [진료실] 직원만 원장님 배정 대상
        // 부서 이름에 '진료'가 포함되거나, 특정 부서 아이디인 경우
        const clinicalStaff = availableStaff.filter(emp => {
            const deptName = emp.departments?.name || '';
            const position = emp.positions?.name || '';
            // 임시: 진료실, 위생사, 조무사, 또는 팀 정보가 있는 경우
            // 여기서는 모든 직원을 배정하되, 데스크/상담실 등은 제외할 수도 있음.
            // 일단 '진료실'만 대상으로 하거나, 전체 대상으로 함.
            // 요구사항: "진료실 직원을 불러와서"
            return deptName.includes('진료') || position.includes('진료') || position.includes('위생사');
        });

        // 나머지 직원은 배정하지 않음 (스케줄표에는 나오지 않거나 별도 영역에 배치되어야 하나, 현재 로직은 원장님 밑에 배정함)
        // 만약 진료실 외 직원이 스케줄표에 있어야 한다면, 별도 처리가 필요함.
        // 현재는 '진료실' 인원만 그리드에 배치하는 것으로 가정.

        // 근무 가능한 원장님 목록 찾기
        const workingDoctors = this.DOCTORS.filter(d => doctorStatus[d.name].isWorking);

        if (workingDoctors.length === 0) return { allocation, doctorStatus };

        // 4. 균등 배분 (Round Robin)
        // 매일 시작 원장님을 바꿔서 편중 방지 (rotationOffset 활용)
        const startIndex = rotationOffset % workingDoctors.length;

        // 직원을 무작위로 섞지 않고, 이름순 등으로 정렬하여 일관성을 주거나, 
        // 지난 주 근무 횟수 등을 고려해야 하나, 여기서는 단순 셔플+라운드로빈
        const shuffledStaff = [...clinicalStaff].sort(() => Math.random() - 0.5);

        shuffledStaff.forEach((staff, index) => {
            // 현재 순서의 원장님 선택
            const docIndex = (startIndex + index) % workingDoctors.length;
            const targetDoc = workingDoctors[docIndex];

            // 정원(5명) 체크 - 정원 초과시 다음 원장님 시도 (단, 모든 원장님이 꽉 차지 않도록)
            if (allocation[targetDoc.name].length < this.SETTINGS.maxPerDoc) {
                allocation[targetDoc.name].push(staff);
            } else {
                // 해당 원장님이 꽉 참. 다른 원장님 찾기
                const freeDoc = workingDoctors.find(d => allocation[d.name].length < this.SETTINGS.maxPerDoc);
                if (freeDoc) {
                    allocation[freeDoc.name].push(staff);
                } else {
                    // 모든 원장님이 꽉 참 -> 배정 불가 (예비 인원으로 빠짐)
                    // console.log('배정 불가:', staff.name);
                }
            }
        });

        return { allocation, doctorStatus };
    }

    isDoctorOff(rule, dayName, weekNum) {
        if (!rule) return false;
        if (rule.includes(dayName)) return true;
        // "2주-목" 등의 패턴 처리 로직은 필요 시 추가
        return false;
    }
}
