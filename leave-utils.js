export function getLeaveDetails(employee, referenceDate = null) {
    // 연차 근속 기준 = 연차기준일(변환입사일) 우선, 없으면 실제 입사일
    // (알바기간/재입사 공백 제외 보정용. leave_base_date 가 정본)
    const entryDateVal = employee?.leave_base_date || employee?.leaveBaseDate || employee?.entryDate || employee?.entry_date;
    if (!employee || !entryDateVal) return { legal: 0, adjustment: 0, final: 0, carriedOver: 0, note: '', periodStart: '', periodEnd: '' };

    const { leave_renewal_date, leave_adjustment, weekly_work_days } = employee;
    const workDays = weekly_work_days || 5;
    const today = referenceDate ? dayjs(referenceDate) : dayjs();
    const entryDay = dayjs(entryDateVal);
    const firstAnniversary = entryDay.add(1, 'year');

    // ═══════════════════════════════════════
    // 1. 현재 주기 계산 (사용량 필터링용)
    // ═══════════════════════════════════════
    let periodStart, periodEnd;
    if (leave_renewal_date) {
        const renewalMMDD = dayjs(leave_renewal_date).format('MM-DD');
        const renewalThisYear = dayjs(`${today.year()}-${renewalMMDD}`);
        if (!today.isBefore(renewalThisYear)) {
            periodStart = renewalThisYear;
            periodEnd = renewalThisYear.add(1, 'year').subtract(1, 'day');
        } else {
            periodStart = renewalThisYear.subtract(1, 'year');
            periodEnd = renewalThisYear.subtract(1, 'day');
        }
    } else {
        const annivThisYear = dayjs(`${today.year()}-${entryDay.format('MM-DD')}`);
        if (!today.isBefore(annivThisYear)) {
            periodStart = annivThisYear;
            periodEnd = annivThisYear.add(1, 'year').subtract(1, 'day');
        } else {
            periodStart = annivThisYear.subtract(1, 'year');
            periodEnd = annivThisYear.subtract(1, 'day');
        }
    }

    // ═══════════════════════════════════════
    // 2. 법정 연차 계산
    // ═══════════════════════════════════════
    let legalLeaves = 0;
    let carriedOver = 0;
    let note = '';

    if (today.isBefore(firstAnniversary)) {
        // 입사 12개월 미만 → 월차 (매월 1일씩, 최대 11일)
        const monthsFromEntry = today.diff(entryDay, 'month');
        legalLeaves = Math.min(Math.floor(monthsFromEntry), 11);
        note = `입사 ${monthsFromEntry}개월 (월차)`;
    } else {
        // 입사 12개월 이상 → 갱신일 기준 법정 연차
        if (leave_renewal_date) {
            const renewalMMDD = dayjs(leave_renewal_date).format('MM-DD');
            // 첫 갱신일 계산
            let firstRenewal = dayjs(`${entryDay.year()}-${renewalMMDD}`);
            if (firstRenewal.isBefore(entryDay) || firstRenewal.isSame(entryDay, 'day')) {
                firstRenewal = firstRenewal.add(1, 'year');
            }
            // 현재 주기 시작일이 첫 갱신일로부터 몇 년 지났는지
            let yearsFromFirst = periodStart.diff(firstRenewal, 'year');
            if (yearsFromFirst < 0) yearsFromFirst = 0;
            legalLeaves = 15 + Math.floor(yearsFromFirst / 2);
        } else {
            const yearsFromAnniv = today.diff(firstAnniversary, 'year');
            legalLeaves = 15 + Math.floor(Math.max(0, yearsFromAnniv) / 2);
        }
    }

    // 최대 25일 제한
    legalLeaves = Math.min(Math.max(0, legalLeaves), 25);

    // 주 근무일수 비례 계산
    const prorataLeavesExact = legalLeaves * (workDays / 5);
    const prorataLeaves = Math.floor(prorataLeavesExact);
    carriedOver = prorataLeavesExact - prorataLeaves;

    if (carriedOver > 0) {
        const renewalBase = leave_renewal_date ? dayjs(leave_renewal_date) : entryDay.add(1, 'year');
        const renewalThisYear = dayjs(`${today.year()}-${renewalBase.format('MM-DD')}`);
        const nextRenewal = renewalThisYear.isAfter(today) ? renewalThisYear : renewalThisYear.add(1, 'year');
        note = `다음 갱신일(${nextRenewal.format('YYYY-MM-DD')})에 ${carriedOver.toFixed(2)}일 이월 예정`;
    }

    // ═══════════════════════════════════════
    // 3. 이월·조정 — 주기마다 직접 입력한 값만 사용
    //    확정연차 = 법정 + 이월(그 주기) + 조정(그 주기)
    //    해당 주기에 입력한 게 없으면 0. 다른 주기 값을 끌어오거나 자동 이관하지 않음.
    // ═══════════════════════════════════════
    const periodKey = periodStart.format('YYYY-MM-DD');
    const periodEntry = (employee.adjustments || {})[periodKey];
    const adjustment = periodEntry ? (periodEntry.adjustment || 0) : 0;
    const carriedOverLeave = periodEntry ? (periodEntry.carried || 0) : 0;
    const finalLeaves = prorataLeaves + adjustment + carriedOverLeave;

    return {
        legal: prorataLeaves,
        adjustment: adjustment,
        carriedOverCnt: carriedOverLeave,
        final: finalLeaves,
        carriedOver: carriedOver,
        note: note,
        periodStart: periodStart.format('YYYY-MM-DD'),
        periodEnd: periodEnd.format('YYYY-MM-DD')
    };
}

// =========================================================================================
// 파트타임 '근무일 공휴일 = 유급 연차' 감지 유틸 (schedule.js isFixedOffDay 와 동일 규칙)
// 근거: .intent/schedule.md 파트타임 행 + grid_principles 15단계.
//   - 파트타임(주<5, 김민재·박보현)은 근무요일 고정 계약 → 공휴일이 근무일과 겹치면 메울 수 없어 연차 차감.
//   - 일반 주5·류효경(weeks/대체)은 대상 아님 → 이 함수가 [] 반환(주<5 게이트).
// =========================================================================================
function getCalWeekRow(dateStr) {
    const d = dayjs(dateStr);
    const firstOfMonth = d.startOf('month');
    const firstDow = firstOfMonth.day();
    const firstMonday = firstDow <= 1
        ? firstOfMonth.subtract(firstDow === 0 ? 6 : 0, 'day')
        : firstOfMonth.subtract(firstDow - 1, 'day');
    const dow = d.day();
    const thisMonday = dow === 0 ? d.subtract(6, 'day') : d.subtract(dow - 1, 'day');
    return Math.floor(thisMonday.diff(firstMonday, 'day') / 7) + 1;
}

/** 특정 날짜가 그 직원의 고정 휴무일인지 (주차 규칙 weeks 포함) */
function isFixedOffDate(rules, dateStr) {
    if (!rules || !Array.isArray(rules) || rules.length === 0) return false;
    const parsed = (typeof rules[0] === 'number') ? rules.map(d => ({ day: d, sub: true })) : rules;
    const dow = dayjs(dateStr).day();
    return parsed.some(r => {
        if (r.day !== dow) return false;
        if (!r.weeks) return true;
        return r.weeks.includes(getCalWeekRow(dateStr));
    });
}

/**
 * 파트타임(주<5) 직원의 '근무일에 걸린 공휴일' 날짜 목록.
 * = 공휴일 중 일요일 아님 + 그 직원 고정휴무일 아님(= 원래 근무했어야 할 날) → 신청서 없어도 유급 연차 차감 대상.
 * @param {object} emp 직원 (weekly_work_days, regular_holiday_rules)
 * @param {string[]} holidayDates company_holidays 날짜 배열
 * @returns {string[]} 대상 날짜 (오름차순)
 */
export function getPartTimeHolidayLeaveDates(emp, holidayDates) {
    if (!emp || (emp.weekly_work_days || 5) >= 5) return [];
    const rules = emp.regular_holiday_rules;
    return (holidayDates || [])
        .filter(d => dayjs(d).day() !== 0 && !isFixedOffDate(rules, d))
        .sort();
}

// =========================================================================================
// 연차 소속 주기 판별 유틸리티 (수동 강제 배정 대응)
// =========================================================================================
export function isLeaveInPeriod(request, dateStr, periodStart, periodEnd) {
    const pStartDayjs = dayjs(periodStart);
    const pEndDayjs = dayjs(periodEnd);
    const dateDayjs = dayjs(dateStr);

    // 1. Reason 필드에서 강제 귀속 태그 확인
    const reason = request.reason || '';
    const match = reason.match(/\[TARGET_PERIOD:\s*([^\]]+)\]/);
    if (match) {
        const targetStartStr = match[1].trim();
        const targetStartDayjs = dayjs(targetStartStr);
        if (targetStartDayjs.isSame(pStartDayjs, 'day')) {
            return true;
        } else {
            return false;
        }
    }

    // 2. 태그가 없으면 원래 사용 날짜가 해당 주기에 포함되는지 확인
    return (dateDayjs.isSame(pStartDayjs, 'day') || dateDayjs.isAfter(pStartDayjs, 'day')) &&
        (dateDayjs.isSame(pEndDayjs, 'day') || dateDayjs.isBefore(pEndDayjs, 'day'));
}
