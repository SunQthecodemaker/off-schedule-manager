// 진료비 복지 — 관리자/매니저 화면 (계산기 / 전체목록 / 이행체크 / 퇴사정산)
import { state, db } from './state.js?v=20260703b';
import {
    loadConfig, loadActiveEmployees, loadAllRecords,
    loadFulfillmentByRecord, loadFulfillmentForRecords, loadAllPendingFulfillment,
    monthsBetween, calculateCosts, computeRemaining, elapsedMonthList,
    fulfilledMonthCount, formatNum, signatureUrlOf,
    createRecord, deleteRecord, upsertFulfillment, processSettlement,
    uploadFulfillmentPhoto, removeDocsFile, fulfillmentPhotoUrls,
} from './welfare.js?v=20260714c';
import {
    generateConsentHTML, generateSettlementHTML, attachSignaturePad, printHTML,
} from './welfare-consent.js';

// ============================================================
// 진입점 — main.js 의 activeTab === 'welfare' 분기에서 호출
// ============================================================
export async function renderWelfareTab(container) {
    if (!container) return;
    container.innerHTML = `<div class="text-center py-10 text-gray-500">로딩 중...</div>`;

    state.welfare ??= { activeSubTab: 'create', config: null, employees: [], records: [], signaturePad: null };

    try {
        const [config, employees, records] = await Promise.all([loadConfig(), loadActiveEmployees(), loadAllRecords()]);
        state.welfare.config    = config;
        state.welfare.employees = employees;
        state.welfare.records   = records;
    } catch (e) {
        container.innerHTML = `<div class="text-red-600 p-4">데이터 로딩 실패: ${e.message}</div>`;
        return;
    }
    renderShell(container);
}

function renderShell(container) {
    const tabs = [
        { id: 'create',  label: '📝 신규 동의서 등록' },
        { id: 'list',    label: '📋 전체 목록' },
        { id: 'fulfill', label: '✅ 월별 이행 체크' },
        { id: 'settle',  label: '💸 퇴사 정산' },
    ];
    const active = state.welfare.activeSubTab;
    container.innerHTML = `
        <div class="bg-white rounded shadow">
            <div class="border-b flex">
                ${tabs.map(t => `
                    <button data-welfare-tab="${t.id}" class="px-6 py-3 text-sm font-medium ${
                        active === t.id ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-600 hover:text-gray-800'
                    }">${t.label}</button>`).join('')}
            </div>
            <div id="welfare-pane" class="p-4"></div>
        </div>`;
    container.querySelectorAll('[data-welfare-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.welfare.activeSubTab = btn.dataset.welfareTab;
            renderShell(container);
        });
    });
    const pane = container.querySelector('#welfare-pane');
    if      (active === 'create')  renderCreateTab(pane);
    else if (active === 'list')    renderListTab(pane);
    else if (active === 'fulfill') renderFulfillTab(pane);
    else if (active === 'settle')  renderSettleTab(pane);
}

// ============================================================
// 탭 1) 진료비 계산기 — 폼 + 실시간 계산 + 동의서 생성 + 서명 저장
// ============================================================
function renderCreateTab(pane) {
    const cfg = state.welfare.config;
    const employees = state.welfare.employees;

    pane.innerHTML = `
        <div class="bg-blue-50 border border-blue-200 rounded p-3 mb-4 text-sm">
            <span class="font-bold text-blue-800">📝 신규 진료비 동의서 등록</span> —
            아래 정보를 입력하면 실시간으로 산정 결과가 보이고,
            <b>동의서 생성</b> → 서명 → <b>저장</b> 순으로 진행하면 등록됩니다.
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="space-y-3">
                <h3 class="font-bold text-lg">정보 입력</h3>
                <div><label class="block text-sm font-semibold mb-1">직원</label>
                    <select id="wf-emp" class="w-full border p-2 rounded">
                        <option value="">직원을 선택하세요</option>
                        ${employees.map(e => `<option value="${e.id}" data-entry="${e.entry_date || ''}">${e.name}</option>`).join('')}
                    </select></div>
                <div><label class="block text-sm font-semibold mb-1">구분</label>
                    <select id="wf-rel" class="w-full border p-2 rounded">
                        <option value="직원">직원</option><option value="가족">가족</option>
                    </select></div>
                <div><label class="block text-sm font-semibold mb-1">환자명 (가족인 경우)</label>
                    <input id="wf-patient" type="text" class="w-full border p-2 rounded bg-gray-100" disabled placeholder="직원 본인인 경우 비활성화"></div>
                <div><label class="block text-sm font-semibold mb-1">진료 항목</label>
                    <select id="wf-type" class="w-full border p-2 rounded">
                        <option value="A-Type">A-Type (교정, 보철, 임플란트 등)</option>
                        <option value="B-Type">B-Type (레진, 보험 진료 등)</option>
                    </select></div>
                <div><label class="block text-sm font-semibold mb-1">세부 진료 항목</label>
                    <input id="wf-detail" type="text" class="w-full border p-2 rounded" placeholder="예: 어금니 임플란트, 앞니 레진 등"></div>
                <div><label class="block text-sm font-semibold mb-1">총 진료비 (원)</label>
                    <input id="wf-fee" type="number" min="0" value="0" class="w-full border p-2 rounded"></div>
                <div><label class="block text-sm font-semibold mb-1">진료 시작일</label>
                    <input id="wf-start" type="date" value="${dayjs().format('YYYY-MM-DD')}" class="w-full border p-2 rounded"></div>
                <button id="wf-gen" class="w-full bg-blue-600 text-white py-2 rounded">동의서 생성</button>
            </div>
            <div class="space-y-3">
                <h3 class="font-bold text-lg">납부 정보 (예상)</h3>
                <div id="wf-result" class="grid grid-cols-2 gap-2 text-sm"></div>
                <div class="bg-gray-50 border rounded p-3 text-xs space-y-2">
                    <div class="font-bold">진료비 산정 기준 (내규)</div>
                    <ul class="list-disc list-inside space-y-1">
                        <li><b>A-Type</b>: 의무 직원 ${cfg.SELF_RATE_EMP}% / 가족 ${cfg.SELF_RATE_FAM}%, 12개월 초과 월 1% 차감(최대 ${cfg.PRE_CAP_EMP}/${cfg.PRE_CAP_FAM}%), 월 차감 1%</li>
                        <li><b>B-Type</b>: 직원 12개월↑ 50% 선차감/월 5% / 가족 의무 50% + 12개월↑ 25% 선차감/월 1%</li>
                    </ul>
                </div>
                <div id="wf-consent-area"></div>
            </div>
        </div>`;

    const $ = (id) => pane.querySelector('#' + id);
    const recompute = () => {
        const empOpt = $('wf-emp').selectedOptions[0];
        const entry = empOpt?.dataset.entry || '';
        const fee = Number($('wf-fee').value) || 0;
        const start = $('wf-start').value;
        const rel = $('wf-rel').value;
        const type = $('wf-type').value;
        const preMonths = entry ? monthsBetween(entry, start) : 0;
        const c = calculateCosts(fee, preMonths, type, rel, cfg);
        $('wf-result').innerHTML = `
            <div class="bg-white border rounded p-2"><div class="text-xs text-gray-500">총 진료비</div><div class="font-bold">${formatNum(fee)} 원</div></div>
            <div class="bg-white border rounded p-2"><div class="text-xs text-gray-500">의무 부담금</div><div class="font-bold">${formatNum(c.selfPay)} 원</div></div>
            <div class="bg-white border rounded p-2"><div class="text-xs text-gray-500">근속 개월</div><div class="font-bold">${preMonths} 개월</div></div>
            <div class="bg-white border rounded p-2"><div class="text-xs text-gray-500">차감 비용 (근속)</div><div class="font-bold">${formatNum(c.prePay)} 원</div></div>
            <div class="bg-blue-50 border border-blue-200 rounded p-2"><div class="text-xs text-blue-600">잔여 비용 (상환 대상)</div><div class="font-bold text-blue-700">${formatNum(c.baseAmount)} 원</div></div>
            <div class="bg-white border rounded p-2"><div class="text-xs text-gray-500">월 차감 인정액</div><div class="font-bold">${formatNum(c.monthly)} 원</div></div>`;
    };
    pane.addEventListener('input', recompute);
    pane.addEventListener('change', recompute);
    $('wf-rel').addEventListener('change', () => {
        const fam = $('wf-rel').value === '가족';
        $('wf-patient').disabled = !fam;
        $('wf-patient').classList.toggle('bg-gray-100', !fam);
        if (!fam) $('wf-patient').value = '';
    });
    recompute();

    $('wf-gen').addEventListener('click', () => {
        const empOpt = $('wf-emp').selectedOptions[0];
        if (!empOpt?.value) return alert('직원을 선택하세요.');
        const fee = Number($('wf-fee').value) || 0;
        if (fee <= 0) return alert('총 진료비를 입력하세요.');
        if (!$('wf-detail').value) return alert('세부 진료 항목을 입력하세요.');
        if (!$('wf-start').value) return alert('진료 시작일을 입력하세요.');
        const rel = $('wf-rel').value;
        if (rel === '가족' && !$('wf-patient').value) return alert('가족 관계의 경우 환자명을 입력하세요.');

        const entry = empOpt.dataset.entry || '';
        const preMonths = entry ? monthsBetween(entry, $('wf-start').value) : 0;
        const type = $('wf-type').value;
        const c = calculateCosts(fee, preMonths, type, rel, cfg);
        const data = {
            clinicName: cfg.CLINIC_NAME, createdAt: dayjs().format('YYYY-MM-DD'),
            employeeName: empOpt.textContent, relationType: rel,
            patientName: rel === '가족' ? $('wf-patient').value : empOpt.textContent,
            treatmentType: type, treatmentDetails: $('wf-detail').value,
            totalFee: fee, startDate: $('wf-start').value, ...c,
        };
        $('wf-consent-area').innerHTML = generateConsentHTML(data, null) + `
            <div class="flex gap-2 mt-3">
                <button id="wf-clear-sig" class="px-3 py-2 bg-gray-300 rounded">서명 초기화</button>
                <button id="wf-save"      class="px-3 py-2 bg-blue-600 text-white rounded">서명 후 저장</button>
            </div>`;
        state.welfare.signaturePad = attachSignaturePad('welfare-signature-canvas');
        state.welfare._formData = { empId: empOpt.value, ...data };
        $('wf-clear-sig').addEventListener('click', () => state.welfare.signaturePad?.clear());
        $('wf-save').addEventListener('click', onSaveRecord);
    });
}

async function onSaveRecord() {
    if (!state.welfare.signaturePad || state.welfare.signaturePad.isEmpty()) return alert('서명을 먼저 진행해주세요.');
    const f = state.welfare._formData;
    const sigUrl = state.welfare.signaturePad.toDataURL();
    try {
        const res = await createRecord({
            employee_id: Number(f.empId), relation_type: f.relationType,
            patient_name: f.relationType === '가족' ? f.patientName : null,
            treatment_type: f.treatmentType, treatment_details: f.treatmentDetails,
            total_fee: f.totalFee, start_date: f.startDate,
        }, sigUrl);
        alert(res.staged
            ? '동의서가 임시저장되었습니다. 관리자 승인 후 반영됩니다.'
            : '동의서가 저장되었습니다.');
        state.welfare.records = await loadAllRecords();
        state.welfare.activeSubTab = 'list';
        renderShell(document.querySelector('#admin-content'));
    } catch (e) {
        console.error('[welfare:onSaveRecord] error:', e, '\nstack:', e?.stack);
        alert('저장 실패: ' + e.message + '\n\nF12 → Console 에 상세 stack trace 가 출력되었습니다.');
    }
}

// ============================================================
// 탭 2) 전체 목록 — 필터 + 동의서 보기 + 삭제
// ============================================================
async function renderListTab(pane) {
    const cfg = state.welfare.config;
    const records = state.welfare.records;

    // 잔액 계산을 위해 모든 record 의 fulfillment 일괄 로드
    const ids = records.map(r => r.id);
    let fulfillByRec = {};
    if (ids.length) {
        const { data } = await db.from('welfare_monthly_fulfillment').select('*').in('record_id', ids);
        (data || []).forEach(f => { (fulfillByRec[f.record_id] ??= []).push(f); });
    }

    const employees = [...new Set(records.map(r => r.employee?.name).filter(Boolean))].sort();
    pane.innerHTML = `
        <div class="flex gap-3 items-center mb-3 text-sm flex-wrap">
            <select id="wf-list-emp" class="border p-2 rounded"><option value="">전체 직원</option>${employees.map(n => `<option>${n}</option>`).join('')}</select>
            <select id="wf-list-type" class="border p-2 rounded"><option value="">전체 항목</option><option>A-Type</option><option>B-Type</option></select>
            <label class="flex items-center gap-1"><input id="wf-list-settled" type="checkbox"> 정산완료 포함</label>
        </div>
        <div class="overflow-x-auto"><table class="min-w-full text-sm">
            <thead class="bg-gray-50"><tr>
                <th class="p-2 text-left">상태</th><th class="p-2 text-left">작성일</th>
                <th class="p-2 text-left">직원명</th><th class="p-2 text-left">진료 대상</th>
                <th class="p-2 text-left">세부 항목</th><th class="p-2 text-right">총 진료비</th>
                <th class="p-2 text-right">잔여 금액</th><th class="p-2 text-right">이행/경과</th>
                <th class="p-2 text-center">관리</th>
            </tr></thead>
            <tbody id="wf-list-body"></tbody>
        </table></div>`;

    const apply = () => {
        const fEmp = pane.querySelector('#wf-list-emp').value;
        const fType = pane.querySelector('#wf-list-type').value;
        const incSettled = pane.querySelector('#wf-list-settled').checked;
        const body = pane.querySelector('#wf-list-body');

        const rows = records.filter(r => {
            if (fEmp && r.employee?.name !== fEmp) return false;
            if (fType && r.treatment_type !== fType) return false;
            if (!incSettled && r.status === 'Settled') return false;
            return true;
        });

        body.innerHTML = rows.length === 0
            ? `<tr><td colspan="9" class="p-4 text-center text-gray-500">표시할 데이터가 없습니다.</td></tr>`
            : rows.map(r => {
                const fulfills = fulfillByRec[r.id] || [];
                const { remaining, fulfilledMonths } = computeRemaining(r, fulfills, cfg);
                const possible = elapsedMonthList(r.start_date).length;
                const badge = r.status === 'Settled'
                    ? '<span class="px-2 py-0.5 rounded bg-gray-500 text-white text-xs">정산완료</span>'
                    : '<span class="px-2 py-0.5 rounded bg-green-500 text-white text-xs">진행중</span>';
                return `<tr class="border-b ${r.status==='Settled'?'opacity-60':''}">
                    <td class="p-2">${badge}</td>
                    <td class="p-2">${dayjs(r.created_at).format('YYYY-MM-DD')}</td>
                    <td class="p-2">${r.employee?.name || '-'}</td>
                    <td class="p-2">${r.relation_type}${r.patient_name ? ' ('+r.patient_name+')' : ''}</td>
                    <td class="p-2">${r.treatment_details || '-'}</td>
                    <td class="p-2 text-right">${formatNum(r.total_fee)}</td>
                    <td class="p-2 text-right font-bold text-blue-700">${formatNum(remaining)}</td>
                    <td class="p-2 text-right text-xs">${fulfilledMonths} / ${possible}</td>
                    <td class="p-2 text-center whitespace-nowrap">
                        <button data-act="view" data-id="${r.id}" class="px-2 py-1 bg-gray-200 rounded text-xs">보기</button>
                        <button data-act="del"  data-id="${r.id}" class="px-2 py-1 bg-red-500 text-white rounded text-xs ml-1">삭제</button>
                    </td>
                </tr>`;
            }).join('');

        body.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = Number(btn.dataset.id);
                if (btn.dataset.act === 'view') viewRecord(id);
                if (btn.dataset.act === 'del')  deleteRecordHandler(id);
            });
        });
    };
    pane.querySelector('#wf-list-emp').addEventListener('change', apply);
    pane.querySelector('#wf-list-type').addEventListener('change', apply);
    pane.querySelector('#wf-list-settled').addEventListener('change', apply);
    apply();
}

async function viewRecord(id) {
    const r = state.welfare.records.find(x => x.id === id);
    if (!r) return;
    const cfg = state.welfare.config;
    const c = calculateCosts(r.total_fee, r.pre_tenure_months || 0, r.treatment_type, r.relation_type, cfg);
    const sigUrl = await signatureUrlOf(r.consent_sig_path);
    const html = generateConsentHTML({
        clinicName: cfg.CLINIC_NAME, createdAt: dayjs(r.created_at).format('YYYY-MM-DD'),
        employeeName: r.employee?.name || '', relationType: r.relation_type,
        patientName: r.patient_name || r.employee?.name || '',
        treatmentType: r.treatment_type, treatmentDetails: r.treatment_details || '',
        totalFee: r.total_fee, startDate: r.start_date, ...c,
    }, sigUrl);
    printHTML(html);
}

async function deleteRecordHandler(id) {
    if (!confirm('정말 이 기록을 삭제하시겠습니까?\n삭제된 데이터는 복구할 수 없습니다.')) return;
    try {
        const res = await deleteRecord(id);
        alert(res.staged ? '삭제가 임시저장되었습니다. 관리자 승인 후 반영됩니다.' : '삭제되었습니다.');
        state.welfare.records = await loadAllRecords();
        renderShell(document.querySelector('#admin-content'));
    } catch (e) { alert('삭제 실패: ' + e.message); }
}

// ============================================================
// 탭 3) 월별 이행 체크 — 매니저가 매월말 일괄 체크
// ============================================================
async function renderFulfillTab(pane) {
    const records = state.welfare.records.filter(r => r.status === 'Active');
    if (!records.length) {
        pane.innerHTML = `<div class="p-6 text-center text-gray-500">활성 진료기록이 없습니다.</div>`;
        return;
    }
    pane.innerHTML = `<div class="text-center py-8 text-gray-400 text-sm">이행 현황 불러오는 중…</div>`;

    const recordIds = records.map(r => r.id);
    let committed = {}, pending = {};
    try {
        [committed, pending] = await Promise.all([
            loadFulfillmentForRecords(recordIds),
            loadAllPendingFulfillment(),
        ]);
    } catch (e) {
        pane.innerHTML = `<div class="text-red-600 p-4">이행 데이터 로딩 실패: ${e.message}</div>`;
        return;
    }

    // 표시 창: 이번 달 기준 6개월(이번 달 포함, [이번달-5 .. 이번달]). ◀▶ 로 6개월씩 이동.
    const WINDOW = 6;
    const curM = dayjs().startOf('month');
    const curYm = curM.format('YYYY-MM');
    const lastEligibleYm = curM.subtract(1, 'month').format('YYYY-MM');
    // 가장 이른 시작월 (◀ 하한)
    let earliest = curM;
    records.forEach(r => {
        const s = dayjs(r.start_date).startOf('month');
        if (s.isValid() && s.isBefore(earliest)) earliest = s;
    });
    const earliestYm = earliest.format('YYYY-MM');

    // 앵커(창 오른쪽 끝) — 기본 이번 달. 범위 클램프.
    state.welfare.fulfillAnchorEnd ??= curYm;
    let anchorEnd = state.welfare.fulfillAnchorEnd;
    if (anchorEnd > curYm) anchorEnd = curYm;
    if (anchorEnd < earliestYm) anchorEnd = earliestYm;
    state.welfare.fulfillAnchorEnd = anchorEnd;

    const anchorM = dayjs(anchorEnd + '-01');
    const months = [];
    for (let i = WINDOW - 1; i >= 0; i--) months.push(anchorM.subtract(i, 'month').format('YYYY-MM'));
    const canOlder = months[0] > earliestYm;   // 더 과거 데이터 존재
    const canNewer = anchorEnd < curYm;         // 이번 달보다 미래로는 안 감
    const rangeLabel = `${months[0].replace('-', '.')} ~ ${months[months.length - 1].replace('-', '.')}`;

    const pendingCount = Object.keys(pending).length;

    const cellHTML = (r, ym) => {
        const startYm = dayjs(r.start_date).startOf('month').format('YYYY-MM');
        if (ym < startYm) return `<td style="width:44px;min-width:44px" class="border bg-gray-50"></td>`; // 시작 전 = 빈칸
        const key = `${r.id}_${ym}`;
        const p = pending[key], c = committed[key];
        const src = p ? p.payload : c;
        const fulfilled = src ? (src.fulfilled === true || src.fulfilled === 'true') : false;
        const hasPhoto = !!(src && Array.isArray(src.attachments) && src.attachments.length);
        const isPending = !!p;
        const ring = ym === curYm ? 'ring-2 ring-blue-400 ring-inset' : '';
        const photo = hasPhoto ? '<span style="position:absolute;right:1px;bottom:0;font-size:9px;line-height:1">📷</span>' : '';
        if (ym > lastEligibleYm) { // 이번달~미래 = 아직 이행 불가 (편집 X)
            return `<td style="width:44px;min-width:44px" class="border text-center text-gray-300 bg-gray-50 relative ${ring}">·${photo}</td>`;
        }
        const bg = isPending ? 'bg-amber-200 text-amber-800' : (fulfilled ? 'bg-green-500 text-white' : 'bg-white text-gray-300 hover:bg-gray-100');
        const mark = fulfilled ? '✓' : '·';
        const title = `${r.employee?.name || ''} · ${ym}${isPending ? ' (승인 대기)' : ''}${hasPhoto ? ' · 사진 있음' : ''}`;
        return `<td style="width:44px;min-width:44px" class="border text-center cursor-pointer relative wf-grid-cell ${bg} ${ring}"
                    data-rec="${r.id}" data-ym="${ym}" title="${title}">${mark}${photo}</td>`;
    };

    pane.innerHTML = `
        ${pendingCount > 0 ? `<div class="mb-3 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded p-2">
            <b>승인 대기 ${pendingCount}건</b> — 앰버색 칸은 임시저장(승인 전) 상태이며, 관리자 승인 후 실제 반영됩니다.
        </div>` : ''}
        <div class="flex items-center gap-3 mb-2 text-xs text-gray-500 flex-wrap">
            <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 bg-green-500 rounded-sm"></span>이행</span>
            <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 bg-white border rounded-sm"></span>미이행</span>
            <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 bg-amber-200 rounded-sm"></span>승인 대기</span>
            <span>📷 사진</span>
            <span class="text-gray-400">· 칸 클릭 → 이행·메모·사진 편집</span>
        </div>
        <div class="flex items-center gap-2 mb-2">
            <button id="wf-nav-prev" class="px-2 py-1 rounded text-sm ${canOlder ? 'bg-gray-200 hover:bg-gray-300' : 'bg-gray-100 text-gray-300 cursor-not-allowed'}" ${canOlder ? '' : 'disabled'}>◀ 이전</button>
            <span class="text-sm font-semibold text-gray-700" style="min-width:120px;text-align:center">${rangeLabel}</span>
            <button id="wf-nav-next" class="px-2 py-1 rounded text-sm ${canNewer ? 'bg-gray-200 hover:bg-gray-300' : 'bg-gray-100 text-gray-300 cursor-not-allowed'}" ${canNewer ? '' : 'disabled'}>다음 ▶</button>
            ${anchorEnd !== curYm ? `<button id="wf-nav-now" class="px-2 py-1 rounded text-sm bg-blue-50 text-blue-600 hover:bg-blue-100">오늘</button>` : ''}
        </div>
        <div id="wf-grid-scroll" class="overflow-x-auto border rounded" style="max-width:100%">
            <table class="text-xs" style="border-collapse:collapse">
                <thead><tr>
                    <th class="sticky left-0 z-10 bg-gray-100 border p-2 text-left" style="min-width:150px">직원 / 진료</th>
                    ${months.map(ym => `<th class="border p-1 text-center ${ym===curYm?'bg-blue-100 font-bold':'bg-gray-50'}" style="width:44px;min-width:44px">${ym.slice(2).replace('-', '.')}</th>`).join('')}
                </tr></thead>
                <tbody>
                    ${records.map(r => `<tr>
                        <td class="sticky left-0 z-10 bg-white border p-2 whitespace-nowrap" style="min-width:150px">
                            <div class="font-medium">${r.employee?.name || '-'}</div>
                            <div class="text-gray-400" style="font-size:11px">${r.treatment_type} · ${(r.treatment_details || '').slice(0, 12) || '-'}</div>
                        </td>
                        ${months.map(ym => cellHTML(r, ym)).join('')}
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>`;

    // 셀 클릭 → 상세 팝오버 (이행 가능 칸만 wf-grid-cell 클래스 보유)
    pane.querySelector('#wf-grid-scroll').addEventListener('click', (e) => {
        const cell = e.target.closest('.wf-grid-cell');
        if (!cell) return;
        openCellPopover(pane, Number(cell.dataset.rec), cell.dataset.ym);
    });

    // ◀▶ 창 이동 (6개월씩) / 오늘로 복귀
    const goto = (ym) => { state.welfare.fulfillAnchorEnd = ym; renderFulfillTab(pane); };
    const prev = pane.querySelector('#wf-nav-prev');
    const next = pane.querySelector('#wf-nav-next');
    const now = pane.querySelector('#wf-nav-now');
    if (prev && canOlder) prev.onclick = () => goto(anchorM.subtract(WINDOW, 'month').format('YYYY-MM'));
    if (next && canNewer) next.onclick = () => goto(anchorM.add(WINDOW, 'month').format('YYYY-MM'));
    if (now) now.onclick = () => goto(curYm);
}

// 셀(직원·월) 클릭 → 이행 토글 + 메모 + 사진(여러 장) 편집 팝오버.
async function openCellPopover(pane, recId, ym) {
    const rec = state.welfare.records.find(r => r.id === recId);
    if (!rec) return;
    let committed = {}, pending = {};
    try {
        [committed, pending] = await Promise.all([
            loadFulfillmentForRecords([recId]),
            loadAllPendingFulfillment(),
        ]);
    } catch (e) { alert('불러오기 실패: ' + e.message); return; }
    const key = `${recId}_${ym}`;
    const p = pending[key], c = committed[key];
    const src = p ? p.payload : c;
    const isPending = !!p;
    let atts = src && Array.isArray(src.attachments) ? [...src.attachments] : [];
    const fulfilled = src ? (src.fulfilled === true || src.fulfilled === 'true') : false;
    const note = src?.note || '';

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50';
    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl p-4 w-96" style="max-width:92vw">
            <div class="flex justify-between items-center mb-3">
                <div class="font-bold">${rec.employee?.name || '-'} · ${ym} 이행 ${isPending ? '<span class="text-amber-600 text-xs">(승인 대기)</span>' : ''}</div>
                <button id="wf-pop-x" class="text-gray-400 text-2xl leading-none">&times;</button>
            </div>
            <label class="flex items-center gap-2 mb-3 text-sm">
                <input type="checkbox" id="wf-pop-chk" class="w-5 h-5" ${fulfilled ? 'checked' : ''}> 이행 완료
            </label>
            <div class="mb-3">
                <label class="block text-xs font-semibold mb-1">메모</label>
                <input id="wf-pop-note" type="text" class="w-full border p-2 rounded text-sm" value="${note.replace(/"/g, '&quot;')}">
            </div>
            <div class="mb-4">
                <label class="block text-xs font-semibold mb-1">사진 (여러 장 가능)</label>
                <div class="flex items-center gap-2 flex-wrap">
                    <label class="cursor-pointer text-xs px-2 py-1 bg-gray-200 rounded hover:bg-gray-300">📷 추가
                        <input type="file" accept="image/*" multiple id="wf-pop-file" class="hidden">
                    </label>
                    <span id="wf-pop-upl" class="text-xs text-blue-500"></span>
                </div>
                <div id="wf-pop-thumbs" class="flex gap-2 flex-wrap mt-2"></div>
            </div>
            <div class="flex justify-end gap-2">
                <button id="wf-pop-cancel" class="px-3 py-1.5 bg-gray-200 rounded text-sm">닫기</button>
                <button id="wf-pop-save" class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">저장</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('#wf-pop-x').onclick = close;
    modal.querySelector('#wf-pop-cancel').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    const thumbHost = modal.querySelector('#wf-pop-thumbs');
    const paintThumbs = () => renderThumbsInto(thumbHost, atts, async (path) => {
        await removeDocsFile(path);
        const i = atts.indexOf(path); if (i >= 0) atts.splice(i, 1);
        await paintThumbs();
    });
    await paintThumbs();

    modal.querySelector('#wf-pop-file').addEventListener('change', async (e) => {
        const files = [...e.target.files]; e.target.value = '';
        const upl = modal.querySelector('#wf-pop-upl');
        let seq = atts.length, added = 0;
        for (const f of files) {
            if (!f.type.startsWith('image/')) continue;
            upl.textContent = `업로드 중… (${added + 1}/${files.length})`;
            try {
                const blob = await compressImage(f);
                const path = await uploadFulfillmentPhoto(recId, ym, blob, seq++);
                atts.push(path); added++;
            } catch (err) { console.error('[welfare] 사진 업로드 실패:', err); alert('사진 업로드 실패: ' + err.message); }
        }
        upl.textContent = '';
        await paintThumbs();
    });

    modal.querySelector('#wf-pop-save').addEventListener('click', async () => {
        const btn = modal.querySelector('#wf-pop-save');
        btn.disabled = true; btn.textContent = '저장 중…';
        try {
            const res = await upsertFulfillment(recId, ym,
                modal.querySelector('#wf-pop-chk').checked,
                modal.querySelector('#wf-pop-note').value, atts);
            close();
            if (typeof window.showToast === 'function') window.showToast(res.staged ? '임시저장됨 — 승인 후 반영' : '저장됨');
            renderFulfillTab(pane);
        } catch (err) {
            btn.disabled = false; btn.textContent = '저장';
            alert('저장 실패: ' + err.message);
        }
    });
}

// 첨부 경로 배열 → signed URL 썸네일을 host 안에 렌더 (클릭=원본 열기, ×=삭제 콜백).
async function renderThumbsInto(host, paths, onRemove) {
    if (!host) return;
    if (!paths.length) { host.innerHTML = '<span class="text-xs text-gray-400">첨부된 사진 없음</span>'; return; }
    const urls = await fulfillmentPhotoUrls(paths);
    host.innerHTML = urls.map(u => `
        <span class="relative inline-block">
            <img src="${u.url}" class="w-14 h-14 object-cover rounded border cursor-pointer wf-thumb-img" data-url="${u.url}" title="클릭하면 원본 보기">
            <button class="wf-thumb-del absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none flex items-center justify-center" data-path="${u.path}" title="삭제">×</button>
        </span>`).join('');
    host.querySelectorAll('.wf-thumb-del').forEach(b => { b.onclick = () => onRemove(b.dataset.path); });
    host.querySelectorAll('.wf-thumb-img').forEach(im => { im.onclick = () => window.open(im.dataset.url, '_blank'); });
}

// 클라이언트 이미지 압축 → image/jpeg blob (긴 변 maxDim 제한). 대용량 사진 업로드 대비.
function compressImage(file, maxDim = 1600, quality = 0.72) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;
            if (Math.max(width, height) > maxDim) {
                const s = maxDim / Math.max(width, height);
                width = Math.round(width * s); height = Math.round(height * s);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('압축 실패')), 'image/jpeg', quality);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 로드 실패')); };
        img.src = url;
    });
}

// ============================================================
// 탭 4) 퇴사 정산
// ============================================================
async function renderSettleTab(pane) {
    const cfg = state.welfare.config;
    // 잔액 있는 직원만 추출
    const ids = state.welfare.records.filter(r => r.status === 'Active').map(r => r.id);
    let fulfillByRec = {};
    if (ids.length) {
        const { data } = await db.from('welfare_monthly_fulfillment').select('*').in('record_id', ids);
        (data || []).forEach(f => { (fulfillByRec[f.record_id] ??= []).push(f); });
    }
    const empMap = {};
    state.welfare.records.filter(r => r.status === 'Active').forEach(r => {
        const { remaining } = computeRemaining(r, fulfillByRec[r.id] || [], cfg);
        if (remaining <= 0) return;
        const k = r.employee_id;
        empMap[k] ??= { id: k, name: r.employee?.name || `(직원${k})`, total: 0, items: [] };
        empMap[k].total += remaining;
        empMap[k].items.push({
            recordId: r.id, patientName: r.patient_name || r.employee?.name,
            treatmentDetails: r.treatment_details, startDate: r.start_date, remaining,
        });
    });
    const employees = Object.values(empMap).sort((a, b) => a.name.localeCompare(b.name));

    pane.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
                <h3 class="font-bold text-lg mb-3">정산 대상 직원</h3>
                <select id="wf-settle-emp" class="w-full border p-2 rounded mb-3">
                    <option value="">선택하세요</option>
                    ${employees.map(e => `<option value="${e.id}">${e.name} (잔액 ${formatNum(e.total)} 원)</option>`).join('')}
                </select>
                <label class="block text-sm font-semibold mb-1">예상 퇴사일</label>
                <input id="wf-settle-date" type="date" value="${dayjs().format('YYYY-MM-DD')}" class="w-full border p-2 rounded mb-3">
                <button id="wf-settle-show" class="w-full px-4 py-2 bg-blue-600 text-white rounded">정산 내역 보기</button>
            </div>
            <div id="wf-settle-detail" class="text-sm"></div>
        </div>`;

    pane.querySelector('#wf-settle-show').addEventListener('click', () => {
        const empId = Number(pane.querySelector('#wf-settle-emp').value);
        const date = pane.querySelector('#wf-settle-date').value;
        if (!empId || !date) return alert('직원과 퇴사일을 모두 선택하세요.');
        const e = empMap[empId];
        if (!e) return alert('잔액 데이터가 없습니다.');

        pane.querySelector('#wf-settle-detail').innerHTML = `
            <h3 class="font-bold text-lg mb-3">${e.name}님 정산 내역 (퇴사일: ${date})</h3>
            <table class="min-w-full text-sm border">
                <thead class="bg-gray-50"><tr><th class="p-2 text-left">진료 대상</th><th class="p-2 text-left">세부</th><th class="p-2 text-left">시작일</th><th class="p-2 text-right">잔액</th></tr></thead>
                <tbody>${e.items.map(i => `<tr class="border-b"><td class="p-2">${i.patientName}</td><td class="p-2">${i.treatmentDetails || '-'}</td><td class="p-2">${i.startDate}</td><td class="p-2 text-right">${formatNum(i.remaining)} 원</td></tr>`).join('')}</tbody>
                <tfoot><tr class="font-bold bg-yellow-50"><td colspan="3" class="p-2 text-right">합계</td><td class="p-2 text-right text-red-600">${formatNum(e.total)} 원</td></tr></tfoot>
            </table>
            <div class="flex gap-2 mt-3">
                <button id="wf-settle-print" class="px-4 py-2 bg-gray-500 text-white rounded">정산 확인서 인쇄</button>
                <button id="wf-settle-do" class="px-4 py-2 bg-red-600 text-white rounded">정산 완료 처리</button>
            </div>`;
        pane.querySelector('#wf-settle-print').addEventListener('click', () => {
            printHTML(generateSettlementHTML({
                employeeName: e.name, resignDate: date, details: e.items, totalRemaining: e.total,
            }));
        });
        pane.querySelector('#wf-settle-do').addEventListener('click', async () => {
            if (!confirm(`${e.name}님의 활성 기록 ${e.items.length}건을 모두 [정산 완료] 처리하고 퇴사일을 ${date}로 기록하시겠습니까?`)) return;
            try {
                const res = await processSettlement(empId, date);
                alert(res.staged ? '정산 처리가 임시저장되었습니다. 관리자 승인 후 반영됩니다.' : '정산이 완료되었습니다.');
                state.welfare.records = await loadAllRecords();
                renderShell(document.querySelector('#admin-content'));
            } catch (err) { alert('정산 실패: ' + err.message); }
        });
    });
}
