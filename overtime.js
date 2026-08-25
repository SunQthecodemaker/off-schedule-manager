// =========================================================================================
// 초과근무(오버타임) — 구글시트 "2026_오버타임관리" 를 앱으로 이행
//
// 흐름: 직원 본인이 그 자리에서 제출 → 매니저 1차 확인 → 원장 최종 확정.
//       월 집계표에는 원장이 최종 확정한 것만 잡힌다.
//       결재는 연차와 같은 패턴을 그대로 쓴다 (매니저 승인 = staging, 매니저 반려 = 즉시 확정).
//
// 이 파일 하나가 직원 화면(renderMyOvertimeSection) 과 관리자 탭(renderOvertimeTab) 을 모두 담당.
// DB 접근은 전부 여기서만 한다 — 호스트 화면은 컨테이너만 넘긴다.
// =========================================================================================
import { state, db, isVisibleIn, sortByDeptOrder } from './state.js?v=20260825d';
import { stageChange, shouldStage, notifyStaged, approvePendingChange, rejectPendingChange } from './staging.js?v=20260825d';

const DEFAULT_CUTOFFS = ['15:00', '19:00', '21:00'];
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const STATUS_BADGE = {
    pending:  '<span class="bg-yellow-200 text-yellow-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">대기중</span>',
    approved: '<span class="bg-green-200 text-green-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">확정</span>',
    rejected: '<span class="bg-red-200 text-red-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">반려됨</span>'
};

// =========================================================================================
// 계산 헬퍼
// =========================================================================================

/** 'HH:MM' → 분. 형식이 아니면 null */
function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}

/**
 * 진료완료 시각의 초과분을 자동 계산한다.
 * 마감시각 후보 중 "입력 시각 이하의 가장 늦은 것" 을 그날의 기준으로 삼는다.
 *   21:31 → 21:00 기준 31분 / 19:19 → 19:00 기준 19분 / 15:34 → 15:00 기준 34분
 * 후보보다 이른 시각이면 자동 계산 불가 → null (직원이 직접 입력).
 * @returns {{minutes:number, cutoff:string}|null}
 */
export function computeAutoMinutes(endTime, cutoffs = DEFAULT_CUTOFFS) {
    const t = toMinutes(endTime);
    if (t === null) return null;

    let best = null, bestLabel = null;
    for (const c of cutoffs) {
        const cm = toMinutes(c);
        if (cm === null || cm > t) continue;
        if (best === null || cm > best) { best = cm; bestLabel = c; }
    }
    if (best === null) return null;
    return { minutes: t - best, cutoff: bestLabel };
}

/** 135 → '2시간 15분' */
export function formatMinutes(min) {
    const n = Number(min) || 0;
    if (n <= 0) return '0분';
    const h = Math.floor(n / 60), m = n % 60;
    if (!h) return `${m}분`;
    if (!m) return `${h}시간`;
    return `${h}시간 ${m}분`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function monthRange(month) {
    const start = dayjs(month + '-01');
    return { from: start.format('YYYY-MM-DD'), to: start.endOf('month').format('YYYY-MM-DD') };
}

function currentMonth() {
    return dayjs().format('YYYY-MM');
}

/** app_settings.overtime_cutoffs — 부팅마다 한 번만 읽고 state 에 캐시 */
async function loadCutoffs() {
    if (Array.isArray(state.overtimeCutoffs) && state.overtimeCutoffs.length) return state.overtimeCutoffs;
    try {
        const { data } = await db.from('app_settings').select('value').eq('key', 'overtime_cutoffs').maybeSingle();
        const v = data?.value;
        state.overtimeCutoffs = (Array.isArray(v) && v.length) ? v : DEFAULT_CUTOFFS.slice();
    } catch {
        state.overtimeCutoffs = DEFAULT_CUTOFFS.slice();
    }
    return state.overtimeCutoffs;
}

// =========================================================================================
// 직원 화면 — 기록 제출 + 내 기록
// =========================================================================================

export async function renderMyOvertimeSection(container) {
    if (!container) return;
    const user = state.currentUser;
    if (!user?.id) { container.innerHTML = '<p class="text-red-500">로그인 정보가 없습니다.</p>'; return; }

    container.innerHTML = '<p class="text-gray-500 text-center py-6">불러오는 중…</p>';

    state.employee.overtimeMonth ||= currentMonth();
    const month = state.employee.overtimeMonth;
    const { from, to } = monthRange(month);

    const cutoffs = await loadCutoffs();

    let records = [], doctors = [];
    try {
        const [recRes, docRes] = await Promise.all([
            db.from('overtime_records').select('*')
                .eq('employee_id', user.id).gte('work_date', from).lte('work_date', to)
                .order('work_date', { ascending: false }).order('end_time', { ascending: false }),
            db.from('employees').select('id, name, department_id, resignation_date')
        ]);
        if (recRes.error) throw recRes.error;
        records = recRes.data || [];
        doctors = await resolveDoctorNames(docRes.data || []);
    } catch (e) {
        container.innerHTML = `<p class="text-red-500 p-4">초과근무 기록을 불러오지 못했습니다: ${esc(e.message)}</p>`;
        return;
    }

    state.employee.overtimeRecords = records;

    const approvedMin = records.filter(r => r.status === 'approved').reduce((s, r) => s + (r.minutes || 0), 0);
    const pendingMin  = records.filter(r => r.status === 'pending').reduce((s, r) => s + (r.minutes || 0), 0);

    container.innerHTML = `
        <div class="bg-white shadow rounded p-4 mb-4">
            <h2 class="text-xl font-bold mb-1">초과근무 기록 남기기</h2>
            <p class="text-sm text-gray-500 mb-4">
                진료가 늦게 끝나 남은 날, 그날 바로 남겨두세요.
                <b>추가근무 분</b>은 마감시각(${cutoffs.map(esc).join(' / ')}) 기준으로 자동 계산되고, 다르면 직접 고칠 수 있습니다.
            </p>

            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <label class="block">
                    <span class="text-sm font-semibold text-gray-700">진료 날짜</span>
                    <input type="date" id="ot-date" value="${dayjs().format('YYYY-MM-DD')}"
                           max="${dayjs().format('YYYY-MM-DD')}"
                           class="mt-1 w-full border rounded px-3 py-2 text-sm" />
                </label>
                <label class="block">
                    <span class="text-sm font-semibold text-gray-700">진료완료 시각</span>
                    <input type="time" id="ot-endtime" step="60"
                           class="mt-1 w-full border rounded px-3 py-2 text-sm" />
                </label>
                <label class="block">
                    <span class="text-sm font-semibold text-gray-700">추가근무 (분)</span>
                    <div class="flex items-center gap-2 mt-1">
                        <input type="number" id="ot-minutes" min="1" max="720" placeholder="자동"
                               class="w-full border rounded px-3 py-2 text-sm" />
                        <button type="button" id="ot-recalc"
                                class="text-xs px-2 py-2 border rounded text-gray-600 hover:bg-gray-50 whitespace-nowrap">자동</button>
                    </div>
                    <span id="ot-minutes-hint" class="text-xs text-gray-500"></span>
                </label>
                <label class="block">
                    <span class="text-sm font-semibold text-gray-700">환자 <span class="text-gray-400 font-normal">(선택)</span></span>
                    <input type="text" id="ot-patient" maxlength="60" placeholder="환자 이름"
                           class="mt-1 w-full border rounded px-3 py-2 text-sm" />
                </label>
                <label class="block">
                    <span class="text-sm font-semibold text-gray-700">담당의사 <span class="text-gray-400 font-normal">(선택)</span></span>
                    <input type="text" id="ot-doctor" list="ot-doctor-list" maxlength="40" placeholder="담당 원장"
                           class="mt-1 w-full border rounded px-3 py-2 text-sm" />
                    <datalist id="ot-doctor-list">${doctors.map(d => `<option value="${esc(d)}"></option>`).join('')}</datalist>
                </label>
                <label class="block">
                    <span class="text-sm font-semibold text-gray-700">비고 <span class="text-gray-400 font-normal">(선택)</span></span>
                    <input type="text" id="ot-note" maxlength="120" placeholder="특이사항"
                           class="mt-1 w-full border rounded px-3 py-2 text-sm" />
                </label>
            </div>

            <button id="ot-submit"
                    class="mt-4 bg-blue-600 text-white px-5 py-2 rounded font-semibold hover:bg-blue-700">기록 제출</button>
        </div>

        <div class="bg-white shadow rounded p-4">
            <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h2 class="text-xl font-bold">내 초과근무 기록</h2>
                <div class="flex items-center gap-2">
                    <button data-ot-month="-1" class="px-2 py-1 border rounded text-sm hover:bg-gray-50">◀</button>
                    <span class="font-semibold text-sm">${esc(month)}</span>
                    <button data-ot-month="1" class="px-2 py-1 border rounded text-sm hover:bg-gray-50">▶</button>
                </div>
            </div>

            <div class="flex flex-wrap gap-3 mb-4 text-sm">
                <div class="px-3 py-2 rounded bg-green-50 border border-green-200">
                    확정 합계 <b class="text-green-700">${formatMinutes(approvedMin)}</b>
                    <span class="text-gray-500">(${approvedMin}분)</span>
                </div>
                <div class="px-3 py-2 rounded bg-yellow-50 border border-yellow-200">
                    승인 대기 <b class="text-yellow-700">${formatMinutes(pendingMin)}</b>
                    <span class="text-gray-500">(${pendingMin}분)</span>
                </div>
            </div>

            <div class="overflow-x-auto">${myRecordsTable(records)}</div>
        </div>
    `;

    bindEmployeeHandlers(container, cutoffs);
}

function myRecordsTable(records) {
    if (!records.length) {
        return '<p class="text-gray-500 text-center py-6">이 달에는 기록이 없습니다.</p>';
    }
    const rows = records.map(r => {
        const d = dayjs(r.work_date);
        const edited = r.auto_minutes != null && r.auto_minutes !== r.minutes
            ? ` <span class="text-[11px] text-orange-500" title="자동계산 ${r.auto_minutes}분에서 수정">✎</span>` : '';
        const del = r.status === 'pending'
            ? `<button onclick="window.handleOvertimeDelete(${r.id})" class="text-xs text-red-600 hover:underline">삭제</button>`
            : (r.status === 'rejected' && r.reject_reason
                ? `<span class="text-xs text-gray-500" title="${esc(r.reject_reason)}">사유 보기</span>` : '<span class="text-xs text-gray-400">-</span>');
        return `
            <tr class="border-b">
                <td class="p-2 whitespace-nowrap">${d.format('M/D')} (${DOW[d.day()]})</td>
                <td class="p-2 whitespace-nowrap">${esc(r.end_time)}</td>
                <td class="p-2 whitespace-nowrap font-semibold">${r.minutes}분${edited}</td>
                <td class="p-2">${esc(r.patient) || '-'}</td>
                <td class="p-2">${esc(r.doctor) || '-'}</td>
                <td class="p-2">${STATUS_BADGE[r.status] || esc(r.status)}</td>
                <td class="p-2 text-center">${del}</td>
            </tr>`;
    }).join('');

    return `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-2 text-left">날짜</th>
                    <th class="p-2 text-left">진료완료</th>
                    <th class="p-2 text-left">추가근무</th>
                    <th class="p-2 text-left">환자</th>
                    <th class="p-2 text-left">담당의사</th>
                    <th class="p-2 text-left">상태</th>
                    <th class="p-2 text-center">처리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function bindEmployeeHandlers(container, cutoffs) {
    const timeEl = container.querySelector('#ot-endtime');
    const minEl = container.querySelector('#ot-minutes');
    const hintEl = container.querySelector('#ot-minutes-hint');
    let manualOverride = false;

    const autofill = (force = false) => {
        const auto = computeAutoMinutes(timeEl.value, cutoffs);
        if (!auto) {
            hintEl.textContent = timeEl.value ? '마감시각보다 이른 시각 — 분을 직접 입력하세요.' : '';
            if (force) minEl.value = '';
            return;
        }
        hintEl.textContent = `${auto.cutoff} 기준 ${auto.minutes}분`;
        if (force || !manualOverride) { minEl.value = auto.minutes; manualOverride = false; }
    };

    timeEl?.addEventListener('input', () => autofill(false));
    minEl?.addEventListener('input', () => { manualOverride = true; });
    container.querySelector('#ot-recalc')?.addEventListener('click', () => autofill(true));
    container.querySelector('#ot-submit')?.addEventListener('click', () => submitOvertime(container, cutoffs));

    container.querySelectorAll('[data-ot-month]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.employee.overtimeMonth = dayjs(state.employee.overtimeMonth + '-01')
                .add(Number(btn.dataset.otMonth), 'month').format('YYYY-MM');
            renderMyOvertimeSection(container);
        });
    });
}

async function submitOvertime(container, cutoffs) {
    const btn = container.querySelector('#ot-submit');
    const workDate = container.querySelector('#ot-date').value;
    const endTime = container.querySelector('#ot-endtime').value;
    const minutes = parseInt(container.querySelector('#ot-minutes').value, 10);
    const patient = container.querySelector('#ot-patient').value.trim();
    const doctor = container.querySelector('#ot-doctor').value.trim();
    const note = container.querySelector('#ot-note').value.trim();

    if (!workDate) return alert('진료 날짜를 선택해주세요.');
    if (dayjs(workDate).isAfter(dayjs(), 'day')) return alert('미래 날짜는 등록할 수 없습니다.');
    if (!endTime || toMinutes(endTime) === null) return alert('진료완료 시각을 입력해주세요.');
    if (!Number.isFinite(minutes) || minutes <= 0) return alert('추가근무 분을 확인해주세요. (1분 이상)');
    if (minutes > 720) return alert('추가근무는 최대 720분(12시간)까지 등록할 수 있습니다.');

    const auto = computeAutoMinutes(endTime, cutoffs);
    if (auto && Math.abs(auto.minutes - minutes) > 0) {
        const ok = confirm(
            `자동 계산값은 ${auto.cutoff} 기준 ${auto.minutes}분인데 ${minutes}분으로 적으셨습니다.\n` +
            `이대로 제출할까요? (사유가 있으면 비고에 남겨주세요)`);
        if (!ok) return;
    }

    btn.disabled = true;
    btn.textContent = '제출 중…';
    try {
        const { error } = await db.from('overtime_records').insert({
            employee_id: state.currentUser.id,
            employee_name: state.currentUser.name,
            work_date: workDate,
            end_time: endTime,
            minutes,
            auto_minutes: auto ? auto.minutes : null,
            cutoff_time: auto ? auto.cutoff : null,
            patient: patient || null,
            doctor: doctor || null,
            note: note || null,
            status: 'pending'
        });
        // 같은 날 같은 완료시각으로 이미 낸 건 (uniq_overtime_active)
        if (error && error.code === '23505') {
            alert('그 날짜·시각으로 이미 제출한 기록이 있습니다. 아래 목록을 확인해주세요.');
            return;
        }
        if (error) throw error;

        alert('초과근무 기록이 제출되었습니다. 확인 후 확정됩니다.');
        state.employee.overtimeMonth = dayjs(workDate).format('YYYY-MM');
        await renderMyOvertimeSection(container);
    } catch (e) {
        console.error('초과근무 제출 오류:', e);
        alert('제출 중 오류가 발생했습니다: ' + e.message);
    } finally {
        if (btn.isConnected) { btn.disabled = false; btn.textContent = '기록 제출'; }
    }
}

window.handleOvertimeDelete = async function (id) {
    const rec = (state.employee.overtimeRecords || []).find(r => r.id === id);
    if (!rec) return;
    if (rec.status !== 'pending') return alert('이미 처리된 기록은 삭제할 수 없습니다.');
    if (!confirm(`${rec.work_date} ${rec.end_time} 기록을 삭제할까요?`)) return;

    try {
        // status 가드 — 목록을 띄워둔 사이 관리자가 확정했다면 지워지지 않는다
        const { data, error } = await db.from('overtime_records')
            .delete().eq('id', id).eq('status', 'pending').select('id');
        if (error) throw error;
        if (!data?.length) {
            alert('이미 처리된 기록이라 삭제할 수 없습니다.');
        }
        await renderMyOvertimeSection(document.getElementById('employee-overtime-tab'));
    } catch (e) {
        alert('삭제 실패: ' + e.message);
    }
};

// =========================================================================================
// 관리자 화면 — 월 집계표 + 기록 목록 + 결재
// =========================================================================================

export async function renderOvertimeTab(container) {
    if (!container) return;
    container.innerHTML = '<p class="text-gray-500 text-center py-6">불러오는 중…</p>';

    state.overtime ??= { month: null, records: [], staged: {}, filter: 'all' };
    state.overtime.month ||= (state.schedule.currentDate ? dayjs(state.schedule.currentDate).format('YYYY-MM') : currentMonth());

    const month = state.overtime.month;
    const { from, to } = monthRange(month);
    const cutoffs = await loadCutoffs();

    let records = [], staged = {};
    try {
        const [recRes, stagedRes] = await Promise.all([
            db.from('overtime_records').select('*')
                .gte('work_date', from).lte('work_date', to)
                .order('work_date', { ascending: true }).order('end_time', { ascending: true }),
            db.from('pending_changes').select('id, entity_id, payload, created_by')
                .eq('entity_type', 'overtime_approval').eq('status', 'pending')
        ]);
        if (recRes.error) throw recRes.error;
        records = recRes.data || [];
        (stagedRes.data || []).forEach(s => { staged[s.entity_id] = s; });
    } catch (e) {
        container.innerHTML = `<p class="text-red-500 p-4">초과근무 기록을 불러오지 못했습니다: ${esc(e.message)}</p>`;
        return;
    }

    state.overtime.records = records;
    state.overtime.staged = staged;

    const isAdmin = state.currentUser?.role === 'admin';
    const filter = state.overtime.filter || 'all';
    const pendingCnt = records.filter(r => r.status === 'pending').length;

    container.innerHTML = `
        <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div class="flex items-center gap-2">
                <button data-ot-admin-month="-1" class="px-3 py-1 border rounded hover:bg-gray-50">◀</button>
                <h2 class="text-xl font-bold">${esc(month)} 초과근무</h2>
                <button data-ot-admin-month="1" class="px-3 py-1 border rounded hover:bg-gray-50">▶</button>
            </div>
            ${isAdmin ? `
            <div class="flex items-center gap-2 text-sm">
                <span class="text-gray-600 whitespace-nowrap">마감시각</span>
                <input type="text" id="ot-cutoffs" value="${esc(cutoffs.join(', '))}"
                       class="border rounded px-2 py-1 text-sm w-40" placeholder="15:00, 19:00, 21:00" />
                <button id="ot-cutoffs-save" class="px-3 py-1 border rounded hover:bg-gray-50">저장</button>
            </div>` : ''}
        </div>

        ${renderSummaryTable(records)}

        <div class="bg-white shadow rounded p-4">
            <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h3 class="font-bold">기록 목록 <span class="text-sm font-normal text-gray-500">(${records.length}건${pendingCnt ? `, 대기 ${pendingCnt}건` : ''})</span></h3>
                <div class="flex gap-1 text-xs">
                    ${[['all', '전체'], ['pending', '대기'], ['approved', '확정'], ['rejected', '반려']].map(([k, label]) =>
                        `<button data-ot-filter="${k}" class="px-3 py-1 rounded border ${filter === k ? 'bg-blue-600 text-white border-blue-600' : 'hover:bg-gray-50'}">${label}</button>`
                    ).join('')}
                </div>
            </div>
            <div class="overflow-x-auto">${renderRecordsTable(records, staged, filter)}</div>
        </div>
    `;

    container.querySelectorAll('[data-ot-admin-month]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.overtime.month = dayjs(state.overtime.month + '-01')
                .add(Number(btn.dataset.otAdminMonth), 'month').format('YYYY-MM');
            renderOvertimeTab(container);
        });
    });
    container.querySelectorAll('[data-ot-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.overtime.filter = btn.dataset.otFilter;
            renderOvertimeTab(container);
        });
    });
    container.querySelector('#ot-cutoffs-save')?.addEventListener('click', () => saveCutoffs(container));
}

/** 월 집계표 — 확정된 것만 합산. 시트 우측 집계표에 대응 */
function renderSummaryTable(records) {
    const employees = (state.management.employees || [])
        .filter(e => isVisibleIn('leave_review', e, { userRole: state.userRole, userId: state.currentUser?.id }));
    const deptById = {};
    (state.management.departments || []).forEach(d => { deptById[d.id] = d.name; });

    // 원장은 초과근무 대상이 아니다 — 집계 로스터에서 제외
    const roster = sortByDeptOrder(
        employees.filter(e => deptById[e.department_id] !== '원장'),
        state.management.departments || []
    );

    const byEmp = {};
    records.filter(r => r.status === 'approved').forEach(r => {
        byEmp[r.employee_id] ??= { min: 0, cnt: 0 };
        byEmp[r.employee_id].min += r.minutes || 0;
        byEmp[r.employee_id].cnt += 1;
    });
    const pendingByEmp = {};
    records.filter(r => r.status === 'pending').forEach(r => {
        pendingByEmp[r.employee_id] = (pendingByEmp[r.employee_id] || 0) + (r.minutes || 0);
    });

    // 로스터에 없는데 기록만 있는 직원(퇴사 등)도 빠뜨리지 않는다
    const rosterIds = new Set(roster.map(e => e.id));
    const extras = [];
    records.forEach(r => {
        if (!rosterIds.has(r.employee_id) && !extras.find(x => x.id === r.employee_id)) {
            extras.push({ id: r.employee_id, name: r.employee_name, _extra: true });
        }
    });

    const list = [...roster, ...extras];
    const totalMin = Object.values(byEmp).reduce((s, v) => s + v.min, 0);

    const rows = list.map((e, i) => {
        const agg = byEmp[e.id] || { min: 0, cnt: 0 };
        const pend = pendingByEmp[e.id] || 0;
        const zero = agg.min === 0 && pend === 0;
        return `
            <tr class="border-b ${zero ? 'text-gray-400' : ''}">
                <td class="p-2 text-center">${i + 1}</td>
                <td class="p-2 whitespace-nowrap">${esc(e.name)}${e._extra ? ' <span class="text-[11px] text-gray-400">(로스터 외)</span>' : ''}</td>
                <td class="p-2 text-right font-semibold">${agg.min}</td>
                <td class="p-2 text-right whitespace-nowrap">${agg.min ? formatMinutes(agg.min) : '-'}</td>
                <td class="p-2 text-right">${agg.cnt || '-'}</td>
                <td class="p-2 text-right ${pend ? 'text-yellow-700' : 'text-gray-300'}">${pend ? pend + '분' : '-'}</td>
            </tr>`;
    }).join('');

    return `
        <div class="bg-white shadow rounded p-4 mb-4">
            <h3 class="font-bold mb-1">월 집계 <span class="text-sm font-normal text-gray-500">(원장 확정분만 합산)</span></h3>
            <p class="text-xs text-gray-500 mb-3">총 <b>${totalMin}분</b> · ${formatMinutes(totalMin)}</p>
            <div class="overflow-x-auto">
                <table class="min-w-full text-sm">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="p-2 w-10 text-center">#</th>
                            <th class="p-2 text-left">직원</th>
                            <th class="p-2 text-right">분</th>
                            <th class="p-2 text-right">시간</th>
                            <th class="p-2 text-right">건수</th>
                            <th class="p-2 text-right">대기중</th>
                        </tr>
                    </thead>
                    <tbody>${rows || '<tr><td colspan="6" class="p-4 text-center text-gray-500">직원 정보가 없습니다.</td></tr>'}</tbody>
                </table>
            </div>
        </div>`;
}

function renderRecordsTable(records, staged, filter) {
    const rows = records.filter(r => filter === 'all' || r.status === filter);
    if (!rows.length) return '<p class="text-gray-500 text-center py-6">해당하는 기록이 없습니다.</p>';

    const isAdmin = state.currentUser?.role === 'admin';
    const isManager = !!state.currentUser?.isManager;

    // 날짜가 바뀌는 지점에만 날짜를 찍는다 (시트의 병합 셀과 같은 읽기 감각)
    let prevDate = null;

    return `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-2 text-left">날짜</th>
                    <th class="p-2 text-left">직원</th>
                    <th class="p-2 text-left">진료완료</th>
                    <th class="p-2 text-left">추가근무</th>
                    <th class="p-2 text-left">환자</th>
                    <th class="p-2 text-left">담당의사</th>
                    <th class="p-2 text-left">매니저</th>
                    <th class="p-2 text-left">상태</th>
                    <th class="p-2 text-center">처리</th>
                </tr>
            </thead>
            <tbody>${rows.map(r => {
                const d = dayjs(r.work_date);
                const dateCell = r.work_date === prevDate ? '' : `${d.format('M/D')} (${DOW[d.day()]})`;
                prevDate = r.work_date;

                // 매니저 1차 판정 — 실제 도장 또는 staging overlay
                const stagedRow = staged[r.id];
                const middle = stagedRow
                    ? (stagedRow.payload?.decision === 'rejected' ? 'rejected' : 'approved')
                    : r.middle_manager_status;
                const middleCell = r.status !== 'pending' && middle === 'pending'
                    ? '<span class="text-xs text-gray-400">생략</span>'
                    : ({
                        approved: '<span class="text-xs text-blue-600 font-semibold">승인</span>',
                        rejected: '<span class="text-xs text-red-500 font-semibold">반려</span>'
                    }[middle] || '<span class="text-xs text-gray-400">대기</span>');

                const edited = r.auto_minutes != null && r.auto_minutes !== r.minutes
                    ? ` <span class="text-[11px] text-orange-500" title="자동계산 ${r.auto_minutes}분(${esc(r.cutoff_time)} 기준)에서 수정">✎</span>` : '';

                let minCell = `<span class="font-semibold">${r.minutes}분</span>${edited}`;
                let actions = '<span class="text-xs text-gray-400">-</span>';

                if (r.status === 'approved') {
                    actions = '<span class="text-xs text-green-600">확정</span>';
                } else if (r.status === 'rejected') {
                    actions = `<span class="text-xs text-red-400" title="${esc(r.reject_reason || '')}">반려됨</span>`;
                } else if (isAdmin) {
                    // 원장은 확정 직전에 분을 조정할 수 있다 (자동계산 예외 대응)
                    minCell = `<input type="number" id="ot-min-${r.id}" value="${r.minutes}" min="1" max="720"
                                      class="w-20 border rounded px-2 py-1 text-sm" />`;
                    actions = `
                        <button onclick="window.handleOvertimeFinal(${r.id}, 'approved')"
                                class="text-xs bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700">확정</button>
                        <button onclick="window.handleOvertimeFinal(${r.id}, 'rejected')"
                                class="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 ml-1">반려</button>`;
                } else if (isManager) {
                    actions = middle === 'pending'
                        ? `<button onclick="window.handleOvertimeMiddle(${r.id}, 'approved')"
                                   class="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700">승인</button>
                           <button onclick="window.handleOvertimeMiddle(${r.id}, 'rejected')"
                                   class="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 ml-1">반려</button>`
                        : '<span class="text-xs text-gray-400">원장 확정 대기</span>';
                }

                return `
                    <tr class="border-b" data-ot-id="${r.id}" data-status="${esc(r.status)}">
                        <td class="p-2 whitespace-nowrap text-gray-600">${dateCell}</td>
                        <td class="p-2 whitespace-nowrap font-semibold">${esc(r.employee_name)}</td>
                        <td class="p-2 whitespace-nowrap">${esc(r.end_time)}</td>
                        <td class="p-2 whitespace-nowrap">${minCell}</td>
                        <td class="p-2">${esc(r.patient) || '-'}</td>
                        <td class="p-2">${esc(r.doctor) || '-'}</td>
                        <td class="p-2">${middleCell}</td>
                        <td class="p-2">${STATUS_BADGE[r.status] || esc(r.status)}</td>
                        <td class="p-2 text-center whitespace-nowrap">${actions}</td>
                    </tr>`;
            }).join('')}</tbody>
        </table>`;
}

async function saveCutoffs(container) {
    const raw = container.querySelector('#ot-cutoffs').value;
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return alert('마감시각을 최소 1개 입력해주세요. (예: 15:00, 19:00, 21:00)');

    const bad = list.filter(t => toMinutes(t) === null);
    if (bad.length) return alert(`시각 형식이 잘못되었습니다: ${bad.join(', ')}\nHH:MM 형태로 입력해주세요.`);

    const normalized = [...new Set(list)].sort((a, b) => toMinutes(a) - toMinutes(b));
    try {
        const { data, error } = await db.from('app_settings')
            .upsert({ key: 'overtime_cutoffs', value: normalized, updated_at: new Date().toISOString() }, { onConflict: 'key' })
            .select('key');
        if (error) throw error;
        if (!data?.length) throw new Error('저장 결과가 비어 있습니다 (RETURNING 0행)');

        // 저장 직후 재조회 검증 — 운영 토글 silent fail 방지 패턴
        const { data: check } = await db.from('app_settings').select('value').eq('key', 'overtime_cutoffs').maybeSingle();
        if (JSON.stringify(check?.value) !== JSON.stringify(normalized)) throw new Error('저장값이 반영되지 않았습니다');

        state.overtimeCutoffs = normalized;
        alert('마감시각이 저장되었습니다: ' + normalized.join(', '));
        renderOvertimeTab(container);
    } catch (e) {
        alert('마감시각 저장 실패: ' + e.message);
        renderOvertimeTab(container);
    }
}

// ---------- 결재 핸들러 ----------

function refreshOvertimeTab() {
    const c = document.getElementById('admin-content');
    if (c && state.management.activeTab === 'overtime') return renderOvertimeTab(c);
}

/** 매니저 1차. 승인은 staging 큐로, 반려는 즉시 확정 (연차와 동일 예외) */
window.handleOvertimeMiddle = async function (id, decision) {
    const rec = (state.overtime?.records || []).find(r => r.id === id);
    if (!rec) return;
    if (!state.currentUser?.isManager) return alert('매니저 권한이 없습니다.');

    let reason = null;
    if (decision === 'rejected') {
        reason = prompt('반려 사유를 입력해주세요:');
        if (!reason) return;
    }
    if (!confirm(`${rec.employee_name} ${rec.work_date} ${rec.minutes}분 — ${decision === 'approved' ? '승인' : '반려'}하시겠습니까?`)) return;

    try {
        if (decision === 'approved' && shouldStage('overtime')) {
            const r = await stageChange('overtime_approval', id, 'update', { decision: 'approved' }, rec);
            if (!r.ok) return alert('임시저장 실패: ' + r.error);
            notifyStaged();
        } else {
            const { error } = await db.from('overtime_records').update({
                status: decision === 'rejected' ? 'rejected' : rec.status,
                middle_manager_status: decision,
                middle_manager_id: state.currentUser.id,
                middle_manager_at: new Date().toISOString(),
                reject_reason: reason || null
            }).eq('id', id);
            if (error) throw error;
        }
        await refreshOvertimeTab();
        await window.refreshPendingUI?.();
    } catch (e) {
        alert('처리 실패: ' + e.message);
    }
};

/** 원장 최종 확정. 매니저 staging 행이 있으면 그 경로로 소비해 대기 배지까지 정리한다 */
window.handleOvertimeFinal = async function (id, decision) {
    const rec = (state.overtime?.records || []).find(r => r.id === id);
    if (!rec) return;
    if (state.currentUser?.role !== 'admin') return alert('원장만 최종 확정할 수 있습니다.');

    const input = document.getElementById(`ot-min-${id}`);
    const minutes = input ? parseInt(input.value, 10) : rec.minutes;
    if (decision === 'approved') {
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 720) {
            return alert('추가근무 분이 올바르지 않습니다. (1~720분)');
        }
    }

    let reason = null;
    if (decision === 'rejected') {
        reason = prompt('반려 사유를 입력해주세요:');
        if (!reason) return;
    }

    const stagedRow = state.overtime?.staged?.[id];
    const changed = decision === 'approved' && minutes !== rec.minutes;
    const msg = decision === 'approved'
        ? `${rec.employee_name} ${rec.work_date} — ${minutes}분으로 확정할까요?` +
          (changed ? `\n(제출값 ${rec.minutes}분에서 수정됩니다)` : '') +
          (!stagedRow && rec.middle_manager_status === 'pending' ? '\n\n⚠️ 아직 매니저 확인 전입니다. 생략하고 바로 확정합니다.' : '')
        : `${rec.employee_name} ${rec.work_date} 기록을 반려할까요?`;
    if (!confirm(msg)) return;

    try {
        // 분 조정은 결재 반영 전에 먼저 기록한다 (staging 경로로 가도 값이 살아있게)
        if (changed) {
            const { error } = await db.from('overtime_records').update({ minutes }).eq('id', id);
            if (error) throw error;
        }

        if (stagedRow) {
            const r = decision === 'approved'
                ? await approvePendingChange(stagedRow.id)
                : await rejectPendingChange(stagedRow.id, reason);
            if (!r.ok) throw new Error(r.error);
            if (decision === 'rejected') {
                const { error } = await db.from('overtime_records').update({
                    status: 'rejected', reject_reason: reason,
                    reviewed_by: state.currentUser.id, reviewed_at: new Date().toISOString()
                }).eq('id', id);
                if (error) throw error;
            }
        } else {
            const { error } = await db.from('overtime_records').update({
                status: decision,
                reject_reason: decision === 'rejected' ? reason : null,
                reviewed_by: state.currentUser.id,
                reviewed_at: new Date().toISOString()
            }).eq('id', id);
            if (error) throw error;
        }

        await refreshOvertimeTab();
        await window.refreshPendingUI?.();
        window.refreshAdminSummary?.();
    } catch (e) {
        console.error('초과근무 결재 오류:', e);
        alert('처리 실패: ' + e.message);
    }
};

// ---------- 보조 ----------

/** 담당의사 자동완성 목록 — 원장 부서 재직자 */
async function resolveDoctorNames(employees) {
    try {
        const { data: depts } = await db.from('departments').select('id, name');
        const drDept = (depts || []).find(d => d.name === '원장');
        if (!drDept) return [];
        return employees
            .filter(e => e.department_id === drDept.id && !e.resignation_date)
            .map(e => e.name);
    } catch {
        return [];
    }
}
