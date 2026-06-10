// 진료비 복지 — 직원 본인 화면 ("내 복지 현황")
// 자기 진료기록만 조회. 잔액 + 월별 이행 현황 + 동의서 보기.
import { state, db } from './state.js?v=20260610k';
import {
    loadConfig, loadFulfillmentByRecord,
    calculateCosts, computeRemaining, elapsedMonthList,
    formatNum, signatureUrlOf,
} from './welfare.js';
import { generateConsentHTML, printHTML } from './welfare-consent.js';

export async function renderMyWelfareSection(container) {
    if (!container) return;
    container.innerHTML = `<div class="text-center py-6 text-gray-500">불러오는 중...</div>`;

    const empId = state.currentUser?.id;
    if (!empId) {
        container.innerHTML = `<p class="text-red-600">로그인 정보를 확인할 수 없습니다.</p>`;
        return;
    }

    let cfg, records;
    try {
        cfg = await loadConfig();
        const { data, error } = await db.from('welfare_records')
            .select('*').eq('employee_id', empId).order('created_at', { ascending: false });
        if (error) throw error;
        records = data || [];
    } catch (e) {
        container.innerHTML = `<p class="text-red-600 p-4">로딩 실패: ${e.message}</p>`;
        return;
    }

    if (records.length === 0) {
        container.innerHTML = `<div class="bg-white rounded shadow p-6 text-gray-500">등록된 진료비 복지 기록이 없습니다.</div>`;
        return;
    }

    // 각 record 의 fulfillment 동시 로드
    const fulfillByRec = {};
    await Promise.all(records.map(async r => {
        fulfillByRec[r.id] = await loadFulfillmentByRecord(r.id);
    }));

    container.innerHTML = `
        <div class="space-y-4">
            ${records.map(r => renderRecordCard(r, fulfillByRec[r.id] || [], cfg)).join('')}
        </div>`;

    container.querySelectorAll('button[data-view-record]').forEach(btn => {
        btn.addEventListener('click', () => viewMyConsent(Number(btn.dataset.viewRecord), cfg, records));
    });
}

function renderRecordCard(record, fulfillments, cfg) {
    const { remaining, baseAmount, monthly, fulfilledMonths } =
        computeRemaining(record, fulfillments, cfg);
    const possibleMonths = elapsedMonthList(record.start_date);
    const missed = possibleMonths.length - fulfilledMonths;

    const monthlyMap = {};
    fulfillments.forEach(f => { monthlyMap[f.year_month] = f.fulfilled; });
    const monthChips = possibleMonths.map(ym => {
        const ok = monthlyMap[ym] === true;
        const checked = monthlyMap[ym] !== undefined;
        const cls = ok ? 'bg-green-100 text-green-700 border-green-300'
                       : (checked ? 'bg-red-100 text-red-700 border-red-300'
                                  : 'bg-gray-100 text-gray-500 border-gray-300');
        const sym = ok ? '✓' : (checked ? '✗' : '·');
        return `<span class="inline-block px-2 py-1 rounded border text-xs ${cls}" title="${ym}">${ym.slice(2)} ${sym}</span>`;
    }).join(' ');

    const statusBadge = record.status === 'Settled'
        ? '<span class="px-2 py-0.5 rounded bg-gray-500 text-white text-xs">정산완료</span>'
        : '<span class="px-2 py-0.5 rounded bg-green-500 text-white text-xs">진행중</span>';

    return `
    <div class="bg-white rounded shadow p-5">
      <div class="flex justify-between items-start mb-3">
        <div>
          <div class="font-bold text-lg">${record.treatment_type} · ${record.treatment_details || '-'}</div>
          <div class="text-sm text-gray-500">시작일 ${record.start_date} · 동의일자 ${dayjs(record.created_at).format('YYYY-MM-DD')}</div>
        </div>
        ${statusBadge}
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
        <div class="bg-gray-50 rounded p-2"><div class="text-xs text-gray-500">총 진료비</div><div class="font-bold">${formatNum(record.total_fee)} 원</div></div>
        <div class="bg-gray-50 rounded p-2"><div class="text-xs text-gray-500">상환 대상</div><div class="font-bold">${formatNum(baseAmount)} 원</div></div>
        <div class="bg-gray-50 rounded p-2"><div class="text-xs text-gray-500">월 차감 인정액</div><div class="font-bold">${formatNum(monthly)} 원</div></div>
        <div class="bg-blue-50 rounded p-2 border border-blue-200"><div class="text-xs text-blue-600">현재 잔액</div><div class="font-bold text-blue-700">${formatNum(remaining)} 원</div></div>
      </div>
      <div class="text-sm mb-2">
        <span class="font-semibold">이행 현황:</span>
        <span class="text-green-600">${fulfilledMonths}개월 인정</span>
        ${missed > 0 ? ` <span class="text-red-600 ml-2">⚠️ ${missed}개월 미이행</span>` : ''}
        <span class="text-gray-500"> (총 ${possibleMonths.length}개월 경과)</span>
      </div>
      <div class="leading-loose">${monthChips || '<span class="text-xs text-gray-400">아직 경과한 달이 없습니다.</span>'}</div>
      <div class="mt-3">
        <button data-view-record="${record.id}" class="px-3 py-1 bg-gray-200 rounded text-xs">동의서 보기/인쇄</button>
      </div>
    </div>`;
}

async function viewMyConsent(recordId, cfg, records) {
    const r = records.find(x => x.id === recordId);
    if (!r) return;
    const sigUrl = await signatureUrlOf(r.consent_sig_path);
    const c = calculateCosts(r.total_fee, r.pre_tenure_months || 0, r.treatment_type, r.relation_type, cfg);
    const html = generateConsentHTML({
        clinicName: cfg.CLINIC_NAME,
        createdAt: dayjs(r.created_at).format('YYYY-MM-DD'),
        employeeName: state.currentUser.name || '',
        relationType: r.relation_type,
        patientName: r.patient_name || state.currentUser.name || '',
        treatmentType: r.treatment_type,
        treatmentDetails: r.treatment_details || '',
        totalFee: r.total_fee, startDate: r.start_date, ...c,
    }, sigUrl);
    printHTML(html);
}
