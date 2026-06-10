// 진료비 복지 — 관리자/매니저 화면 (계산기 / 전체목록 / 이행체크 / 퇴사정산)
import { state, db } from './state.js?v=20260610c';
import {
    loadConfig, loadActiveEmployees, loadAllRecords,
    loadFulfillmentByRecord, loadFulfillmentByMonth,
    monthsBetween, calculateCosts, computeRemaining, elapsedMonthList,
    fulfilledMonthCount, formatNum, signatureUrlOf,
    createRecord, deleteRecord, upsertFulfillment, processSettlement,
} from './welfare.js';
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
    const lastMonth = dayjs().subtract(1, 'month').format('YYYY-MM');
    state.welfare.fulfillMonth ??= lastMonth;
    const ym = state.welfare.fulfillMonth;

    const rows = await loadFulfillmentByMonth(ym);
    const map = {};
    rows.forEach(r => { map[r.record_id] = r; });

    pane.innerHTML = `
        <div class="flex justify-between items-center mb-3">
            <div>
                <label class="text-sm font-semibold mr-2">대상 월</label>
                <input id="wf-month" type="month" value="${ym}" class="border p-2 rounded">
                <span class="text-xs text-gray-500 ml-2">매월말 일괄 체크 — 미래 월은 의미 없음</span>
            </div>
            <button id="wf-fulfill-save" class="px-4 py-2 bg-blue-600 text-white rounded">변경사항 저장</button>
        </div>
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50"><tr>
                <th class="p-2 text-left">직원</th><th class="p-2 text-left">진료 내역</th>
                <th class="p-2 text-left">시작일</th><th class="p-2 text-center">이행</th>
                <th class="p-2 text-left">메모</th>
            </tr></thead>
            <tbody>
                ${records.length === 0 ? `<tr><td colspan="5" class="p-4 text-center text-gray-500">활성 진료기록이 없습니다.</td></tr>` :
                records.map(r => {
                    const f = map[r.id];
                    const eligible = elapsedMonthList(r.start_date).includes(ym);
                    return `<tr class="border-b ${eligible ? '' : 'opacity-40'}">
                        <td class="p-2">${r.employee?.name || '-'}</td>
                        <td class="p-2">${r.treatment_type} · ${r.treatment_details || '-'}</td>
                        <td class="p-2">${r.start_date}</td>
                        <td class="p-2 text-center">
                            <input type="checkbox" data-rec="${r.id}" class="wf-fulfill-chk w-5 h-5"
                                   ${f?.fulfilled ? 'checked' : ''} ${eligible ? '' : 'disabled'}>
                        </td>
                        <td class="p-2"><input type="text" data-rec="${r.id}" class="wf-fulfill-note w-full border p-1 rounded text-xs"
                                   value="${(f?.note || '').replace(/"/g, '&quot;')}" ${eligible ? '' : 'disabled'}></td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>`;

    pane.querySelector('#wf-month').addEventListener('change', e => {
        state.welfare.fulfillMonth = e.target.value;
        renderFulfillTab(pane);
    });
    pane.querySelector('#wf-fulfill-save').addEventListener('click', async () => {
        const checks = pane.querySelectorAll('.wf-fulfill-chk');
        const notes  = pane.querySelectorAll('.wf-fulfill-note');
        const noteMap = {};
        notes.forEach(n => { noteMap[n.dataset.rec] = n.value; });
        let staged = 0, applied = 0, fail = 0;
        for (const chk of checks) {
            if (chk.disabled) continue;
            try {
                const res = await upsertFulfillment(Number(chk.dataset.rec), ym, chk.checked, noteMap[chk.dataset.rec]);
                if (res.staged) staged++; else applied++;
            } catch (e) { console.error(e); fail++; }
        }
        alert(`저장 완료 — 즉시반영 ${applied}건 / 임시저장 ${staged}건 / 실패 ${fail}건`);
        renderFulfillTab(pane);
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
