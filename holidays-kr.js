// =============================================================================
// 한국 법정 공휴일 정본 (관공서의 공휴일에 관한 규정)
// =============================================================================
// 스케줄 그리드의 "공휴일 자동 반영" 용 데이터 + 규칙. DB·state 를 모르는 순수 모듈.
//
// 구분
//   basic      = 기본 공휴일 (신정·삼일절·설연휴·어린이날·부처님오신날·현충일·광복절·
//                추석연휴·개천절·한글날·성탄절 + 그 해 지정된 선거일/임시공휴일)
//                → 스케줄에 자동 반영
//   substitute = 대체공휴일 (기본 공휴일이 주말/다른 공휴일과 겹쳐 생기는 날)
//                → 자동 반영하지 않고 사용자(원장·매니저) 확인 후 반영
//
// 음력 기반 공휴일(설날·부처님오신날·추석)은 계산할 수 없어 연도별 표로 관리한다.
// 표에 없는 연도는 양력 고정 공휴일만 반환하고 hasLunarData=false 로 알린다.
// =============================================================================

// 음력 기반 공휴일의 양력 날짜 (당일 기준. 설·추석 연휴는 전날·다음날 자동 확장)
const LUNAR_BASED = {
    2026: { seollal: '2026-02-17', buddha: '2026-05-24', chuseok: '2026-09-25' },
    2027: { seollal: '2027-02-07', buddha: '2027-05-13', chuseok: '2027-09-15' },
    2028: { seollal: '2028-01-27', buddha: '2028-05-02', chuseok: '2028-10-03' }
};

// 양력 고정 공휴일. sub=true 면 토·일과 겹칠 때 대체공휴일 대상.
// (신정·현충일·선거일은 규정상 대체공휴일 대상이 아니다)
// ⚠️ 제헌절(7/17)은 2026-05-11 시행 개정으로 18년 만에 공휴일 부활 — 2026년부터 적용.
const FIXED_HOLIDAYS = [
    { md: '01-01', name: '신정', sub: false },
    { md: '03-01', name: '삼일절', sub: true },
    { md: '05-05', name: '어린이날', sub: true },
    { md: '06-06', name: '현충일', sub: false },
    { md: '07-17', name: '제헌절', sub: true, since: 2026 },
    { md: '08-15', name: '광복절', sub: true },
    { md: '10-03', name: '개천절', sub: true },
    { md: '10-09', name: '한글날', sub: true },
    { md: '12-25', name: '기독탄신일', sub: true }
];

// 그 해에만 있는 공휴일 (임기만료 선거일·임시공휴일). 정부 지정 시 여기에 한 줄 추가.
// 임시공휴일은 예측 불가 — 지정되면 여기에 추가해야 자동 반영된다.
const EXTRA_HOLIDAYS = {
    2026: [{ date: '2026-06-03', name: '제9회 전국동시지방선거' }],
    2028: [{ date: '2028-04-12', name: '제23대 국회의원선거' }]
};

const pad = n => String(n).padStart(2, '0');
const toDate = str => new Date(`${str}T00:00:00`);
const toStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shiftDays = (str, n) => {
    const d = toDate(str);
    d.setDate(d.getDate() + n);
    return toStr(d);
};
const dayOfWeek = str => toDate(str).getDay(); // 0=일 … 6=토

/**
 * 그 해 기본 공휴일 + 대체공휴일 전체 목록.
 * @param {number} year
 * @returns {{ hasLunarData: boolean, holidays: Array<{date:string,name:string,kind:'basic'|'substitute'}> }}
 */
export function getKoreanHolidays(year) {
    const basics = [];

    FIXED_HOLIDAYS.forEach(h => {
        if (h.since && year < h.since) return;
        basics.push({ date: `${year}-${h.md}`, name: h.name, sub: h.sub, lunarPack: false });
    });

    const lunar = LUNAR_BASED[year];
    if (lunar) {
        // 설날·추석은 전날·당일·다음날 3일 연휴.
        // 연휴는 토요일과 겹쳐도 대체 없음 — "다른 공휴일(일요일 포함)과 겹칠 때"만 대상.
        [['설날', lunar.seollal], ['추석', lunar.chuseok]].forEach(([label, dayOf]) => {
            [-1, 0, 1].forEach(offset => {
                const date = shiftDays(dayOf, offset);
                const name = offset === 0 ? label : `${label} 연휴`;
                basics.push({ date, name, sub: true, lunarPack: true });
            });
        });
        basics.push({ date: lunar.buddha, name: '부처님오신날', sub: true, lunarPack: false });
    }

    (EXTRA_HOLIDAYS[year] || []).forEach(h => {
        basics.push({ date: h.date, name: h.name, sub: false, lunarPack: false });
    });

    basics.sort((a, b) => a.date.localeCompare(b.date));

    // ── 대체공휴일 산정 ──────────────────────────────────────────────
    // 규정 요지 (관공서의 공휴일에 관한 규정 §3)
    //  · 삼일절·제헌절·광복절·개천절·한글날·부처님오신날·기독탄신일 → 토·일과 겹치면 대체
    //  · 설·추석 연휴, 어린이날 → 다른 공휴일(일요일 포함)과 겹치면 대체. 토요일만으로는 X
    //  · 대체일 = 그 공휴일 다음의 첫 번째 비공휴일 (토·일·다른 공휴일은 건너뜀)
    //  · 신정·현충일·선거일은 대체 대상 아님
    const occupied = new Set(basics.map(h => h.date));
    // 한 날짜에 공휴일이 2개 겹친 경우(예: 2028 추석=개천절) → 겹친 수만큼 대체 1일씩
    const perDateCount = basics.reduce((acc, h) => acc.set(h.date, (acc.get(h.date) || 0) + 1), new Map());
    const collisionUsed = new Set();

    const substitutes = [];
    basics.forEach(h => {
        if (!h.sub) return;
        const dow = dayOfWeek(h.date);
        // 다른 공휴일과 같은 날짜에 겹쳤는가 (날짜당 1회만 대체 발생)
        const collides = perDateCount.get(h.date) > 1 && !collisionUsed.has(h.date);
        const weekendOverlap = h.lunarPack ? dow === 0 : (dow === 0 || dow === 6);
        if (!weekendOverlap && !collides) return;
        if (collides) collisionUsed.add(h.date);

        let cursor = h.date;
        for (let i = 0; i < 10; i++) {
            cursor = shiftDays(cursor, 1);
            const cdow = dayOfWeek(cursor);
            if (cdow === 0 || cdow === 6) continue;   // 토·일은 건너뜀
            if (occupied.has(cursor)) continue;        // 이미 공휴일이면 건너뜀
            occupied.add(cursor);
            substitutes.push({ date: cursor, name: `${h.name} 대체공휴일`, kind: 'substitute' });
            return;
        }
    });

    const holidays = [
        ...basics.map(h => ({ date: h.date, name: h.name, kind: 'basic' })),
        ...substitutes
    ].sort((a, b) => a.date.localeCompare(b.date));

    return { hasLunarData: !!lunar, holidays };
}

/**
 * 특정 달(1~12)의 공휴일 목록.
 */
export function getKoreanHolidaysOfMonth(year, month1to12) {
    const { hasLunarData, holidays } = getKoreanHolidays(year);
    const prefix = `${year}-${pad(month1to12)}`;
    return { hasLunarData, holidays: holidays.filter(h => h.date.startsWith(prefix)) };
}

/**
 * 자동 반영 데이터가 있는 연도인지 (없으면 UI 가 수동 등록 안내).
 */
export function hasHolidayData(year) {
    return !!LUNAR_BASED[year];
}

/** 날짜(YYYY-MM-DD) 가 한국 공휴일이면 그 정보를, 아니면 null. */
export function findKoreanHoliday(dateStr) {
    const year = Number(dateStr.slice(0, 4));
    if (!year) return null;
    return getKoreanHolidays(year).holidays.find(h => h.date === dateStr) || null;
}

export const KR_HOLIDAY_YEARS = Object.keys(LUNAR_BASED).map(Number);
