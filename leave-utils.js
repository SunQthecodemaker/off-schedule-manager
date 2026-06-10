export function getLeaveDetails(employee, referenceDate = null) {
    const entryDateVal = employee?.entryDate || employee?.entry_date;
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
