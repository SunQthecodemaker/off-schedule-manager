export function getLeaveDetails(employee, referenceDate = null) {
    if (!employee || !employee.entryDate) return { legal: 0, adjustment: 0, final: 0, carriedOver: 0, note: '' };

    const { entryDate, leave_renewal_date, leave_adjustment, work_days_per_week } = employee;
    const workDays = work_days_per_week || 5; // 기본값 5일
    const today = referenceDate ? dayjs(referenceDate) : dayjs();
    const entryDay = dayjs(entryDate);
    const firstAnniversary = entryDay.add(1, 'year');

    let legalLeaves = 0;
    let carriedOver = 0;
    let note = '';

    // 입사 1년 미만 → 월차만
    if (today.isBefore(firstAnniversary)) {
        const monthsFromEntry = today.diff(entryDay, 'month');
        legalLeaves = Math.floor(monthsFromEntry);
    }
    // 입사 1년 이상
    else {
        // 연차 기준일이 설정된 경우
        if (leave_renewal_date) {
            const renewalBase = dayjs(leave_renewal_date);

            // 올해/작년 갱신일 계산
            const renewalThisYear = dayjs(`${today.year()}-${renewalBase.format('MM-DD')}`);
            const renewalLastYear = renewalThisYear.subtract(1, 'year');
            const renewalNextYear = renewalThisYear.add(1, 'year');

            // 현재 속한 갱신 주기 찾기
            let periodStart, periodEnd;
            if (today.isAfter(renewalThisYear) || today.isSame(renewalThisYear, 'day')) {
                periodStart = renewalThisYear;
                periodEnd = renewalNextYear;
            } else {
                periodStart = renewalLastYear;
                periodEnd = renewalThisYear;
            }

            // 입사 1주년이 현재 주기 내에 있는 경우
            if (firstAnniversary.isAfter(periodStart) && (firstAnniversary.isBefore(periodEnd) || firstAnniversary.isSame(periodEnd, 'day'))) {
                // 주기 시작 ~ 입사 1주년 전날: 월차
                const daysBeforeAnniversary = firstAnniversary.diff(periodStart, 'day');
                const monthsBeforeAnniversary = Math.floor(daysBeforeAnniversary / 30);

                // 입사 1주년 ~ 주기 끝: 15일의 비례 계산
                const totalDaysInPeriod = periodEnd.diff(periodStart, 'day');
                const daysAfterAnniversary = periodEnd.diff(firstAnniversary, 'day');
                const prorataLeavesExact = 15 * (daysAfterAnniversary / totalDaysInPeriod);
                const prorataLeaves = Math.floor(prorataLeavesExact);
                carriedOver = prorataLeavesExact - prorataLeaves;

                legalLeaves = monthsBeforeAnniversary + prorataLeaves;

                if (carriedOver > 0) {
                    note = `다음 갱신일(${periodEnd.format('YYYY-MM-DD')})에 ${carriedOver.toFixed(2)}일 이월 예정`;
                }
            }
            // 입사 1주년이 이미 지난 경우
            else {
                // 현재 주기 시작일로부터 경과 연수
                const yearsFromPeriodStart = today.diff(periodStart, 'year');
                legalLeaves = 15 + Math.floor(yearsFromPeriodStart / 2);
            }
        }
        // 연차 기준일이 없는 경우 (입사일 기준)
        else {
            const yearsFromAnniversary = today.diff(firstAnniversary, 'year');
            legalLeaves = 15 + Math.floor(yearsFromAnniversary / 2);
        }
    }

    // 최대 25일 제한
    legalLeaves = Math.min(Math.max(0, legalLeaves), 25);

    // 주 근무일수 비례 계산
    const prorataLeavesExact = legalLeaves * (workDays / 5);
    const prorataLeaves = Math.floor(prorataLeavesExact);
    const workDaysCarriedOver = prorataLeavesExact - prorataLeaves;

    // 소수점은 다음 갱신일에 이월
    if (workDaysCarriedOver > 0) {
        carriedOver += workDaysCarriedOver;
        if (note) {
            note = note.replace(/\d+\.\d+일/, (carriedOver).toFixed(2) + '일');
        } else {
            const renewalBase = leave_renewal_date ? dayjs(leave_renewal_date) : dayjs(entryDate).add(1, 'year');
            const renewalThisYear = dayjs(`${today.year()}-${renewalBase.format('MM-DD')}`);
            const nextRenewal = renewalThisYear.isAfter(today) ? renewalThisYear : renewalThisYear.add(1, 'year');
            note = `다음 갱신일(${nextRenewal.format('YYYY-MM-DD')})에 ${carriedOver.toFixed(2)}일 이월 예정`;
        }
    }

    // 현재 주기 시작/끝일 계산 (사용량 필터링용)
    // 갱신일이 있으면 그 기준으로, 없으면 입사일 기준 1년 단위
    let periodStart, periodEnd;
    if (leave_renewal_date) {
        const renewalBase = dayjs(leave_renewal_date);
        const renewalThisYear = dayjs(`${today.year()}-${renewalBase.format('MM-DD')}`);
        // renewalThisYear 가 오늘보다 뒤라면, 아직 갱신일 안 옴 -> 기간 시작은 작년 갱신일
        // renewalThisYear 가 오늘보다 앞(또는 같음)이라면, 기간 시작은 올해 갱신일

        if (!today.isBefore(renewalThisYear)) {
            periodStart = renewalThisYear;
            periodEnd = renewalThisYear.add(1, 'year').subtract(1, 'day');
        } else {
            periodStart = renewalThisYear.subtract(1, 'year'); // 작년 갱신일
            periodEnd = renewalThisYear.subtract(1, 'day'); // 올해 갱신일 전날
        }
    } else {
        // 입사일 기준
        // 입사일의 올해 기념일 계산
        const currentYearAnniversary = dayjs(`${today.year()}-${entryDay.format('MM-DD')}`);

        if (!today.isBefore(currentYearAnniversary)) {
            periodStart = currentYearAnniversary;
            periodEnd = currentYearAnniversary.add(1, 'year').subtract(1, 'day');
        } else {
            periodStart = currentYearAnniversary.subtract(1, 'year');
            periodEnd = currentYearAnniversary.subtract(1, 'day');
        }
    }

    const adjustment = leave_adjustment || 0;
    const carriedOverLeave = employee.carried_over_leave || 0;

    // 최종 연차 = (법정 + 조정 + 이월)
    // * carriedOver (자동 계산된 예상 이월분)는 통계용으로만 유지하고, 실제 합산은 DB값(carriedOverLeave)을 사용
    const finalLeaves = prorataLeaves + adjustment + carriedOverLeave;

    return {
        legal: prorataLeaves,
        adjustment: adjustment,
        carriedOverCnt: carriedOverLeave, // 명칭 구분: carriedOverCnt (확정 이월), carriedOver (예상 이월)
        final: finalLeaves,
        carriedOver: carriedOver,
        note: note,
        periodStart: periodStart.format('YYYY-MM-DD'),
        periodEnd: periodEnd.format('YYYY-MM-DD')
    };
}
