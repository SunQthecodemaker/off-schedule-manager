// 진료비 복지 — 데이터 + 계산 로직
// Apps Script (code.gs) 1:1 포팅 + 잔액 계산을 "이행 인정 개월수" 기반으로 교체.
import { state, db } from './state.js?v=20260825d';

// ============================================================
// 1. 설정 / 직원 / 진료기록 로드
// ============================================================

export async function loadConfig() {
    const { data, error } = await db.from('welfare_config').select('key, value');
    if (error) throw error;
    const cfg = {};
    (data || []).forEach(r => { cfg[r.key] = r.value; });
    return {
        SELF_RATE_EMP: Number(cfg.SELF_RATE_EMP || 30),
        SELF_RATE_FAM: Number(cfg.SELF_RATE_FAM || 50),
        PRE_CAP_EMP:   Number(cfg.PRE_CAP_EMP   || 35),
        PRE_CAP_FAM:   Number(cfg.PRE_CAP_FAM   || 25),
        CLINIC_NAME:   String(cfg.CLINIC_NAME   || '프라임S치과'),
    };
}

export async function loadActiveEmployees() {
    const { data, error } = await db.from('employees')
        .select('id, name, entry_date, retired, resignation_date')
        .order('name');
    if (error) throw error;
    const today = dayjs().format('YYYY-MM-DD');
    return (data || []).filter(e =>
        !e.retired && (!e.resignation_date || e.resignation_date > today)
    );
}

export async function loadAllRecords() {
    const { data, error } = await db.from('welfare_records')
        .select('*, employee:employees!welfare_records_employee_id_fkey(id, name, entry_date, retired, resignation_date)')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function loadFulfillmentByRecord(recordId) {
    const { data, error } = await db.from('welfare_monthly_fulfillment')
        .select('*').eq('record_id', recordId).order('year_month');
    if (error) throw error;
    return data || [];
}

export async function loadFulfillmentByMonth(yearMonth) {
    const { data, error } = await db.from('welfare_monthly_fulfillment')
        .select('*').eq('year_month', yearMonth);
    if (error) throw error;
    return data || [];
}

// 여러 record 의 이행 반영분(committed) 을 일괄 로드. 월별 그리드용.
// 반환: { "<record_id>_<year_month>": row }
export async function loadFulfillmentForRecords(recordIds) {
    if (!recordIds || !recordIds.length) return {};
    const { data, error } = await db.from('welfare_monthly_fulfillment')
        .select('*').in('record_id', recordIds);
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { map[`${r.record_id}_${r.year_month}`] = r; });
    return map;
}

// 모든 pending 이행(승인 전) 을 일괄 로드. 월별 그리드 오버레이용.
// 반환: { "<record_id>_<year_month>": pending_changes row }  (같은 슬롯은 최신 1건)
export async function loadAllPendingFulfillment() {
    const { data, error } = await db.from('pending_changes')
        .select('id, payload, created_at')
        .eq('entity_type', 'welfare_fulfillment')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
    if (error) { console.warn('[welfare] pending 이행 일괄 로드 실패:', error.message); return {}; }
    const map = {};
    (data || []).forEach(r => {
        const p = r.payload || {};
        // 월 이동 스텁(payload.to_year_month)은 year_month 가 없다 — 옮겨질 달 기준으로 오버레이한다.
        const ym = p.year_month || p.to_year_month;
        if (p.record_id != null && ym) map[`${p.record_id}_${ym}`] = r; // asc → 뒤가 최신
    });
    return map;
}

// 매니저가 임시저장했지만 아직 관리자 승인 전인 이행체크(welfare_fulfillment pending) 를
// 해당 월 기준으로 로드. record_id 별 최신 1건만 반환(중복 방지). 이행체크 탭 "승인 대기" 표기용.
// 반환: { [record_id]: pending_changes row }
export async function loadPendingFulfillmentByMonth(yearMonth) {
    const { data, error } = await db.from('pending_changes')
        .select('id, payload, created_at')
        .eq('entity_type', 'welfare_fulfillment')
        .eq('status', 'pending')
        .or(`payload->>year_month.eq.${yearMonth},payload->>to_year_month.eq.${yearMonth}`)
        .order('created_at', { ascending: true });
    if (error) { console.warn('[welfare] pending 이행 로드 실패:', error.message); return {}; }
    const map = {};
    (data || []).forEach(r => { if (r.payload?.record_id != null) map[r.payload.record_id] = r; }); // asc → 뒤가 최신
    return map;
}

// ============================================================
// 2. 계산 (Apps Script calculateCosts_ 1:1)
// ============================================================

export function monthsBetween(d1, d2) {
    const a = dayjs(d1), b = dayjs(d2);
    if (!a.isValid() || !b.isValid()) return 0;
    let m = (b.year() - a.year()) * 12 + (b.month() - a.month());
    if (b.date() < a.date()) m--;
    return m <= 0 ? 0 : m;
}

export function calculateCosts(totalFee, preMonths, treatmentType, relationType, config) {
    let selfPay = 0, prePay = 0, baseAmount = 0, monthly = 0;

    if (treatmentType === 'A-Type') {
        const selfRate = (relationType === '직원' ? config.SELF_RATE_EMP : config.SELF_RATE_FAM) / 100;
        const preCap   = (relationType === '직원' ? config.PRE_CAP_EMP   : config.PRE_CAP_FAM);
        const preRate  = Math.min(preCap, Math.max(0, preMonths - 12)) / 100;
        selfPay    = totalFee * selfRate;
        prePay     = totalFee * preRate;
        baseAmount = totalFee - selfPay - prePay;
        monthly    = totalFee * 0.01;
    } else { // B-Type
        if (relationType === '가족') {
            selfPay    = totalFee * 0.50;
            prePay     = (preMonths >= 12) ? (totalFee * 0.25) : 0;
            baseAmount = totalFee - selfPay - prePay;
            monthly    = totalFee * 0.01;
        } else { // 직원
            selfPay    = 0;
            prePay     = (preMonths >= 12) ? (totalFee * 0.50) : 0;
            baseAmount = totalFee - prePay;
            monthly    = totalFee * 0.05;
        }
    }
    return { selfPay, prePay, baseAmount, monthly };
}

// ============================================================
// 3. 잔액 계산 — 핵심 변경점
//    기존: monthly × 시작일~오늘 경과 개월수
//    변경: monthly × 이행 인정된 개월수
//    fulfillments: welfare_monthly_fulfillment 행 배열 (record_id 일치)
// ============================================================

export function fulfilledMonthCount(fulfillments) {
    return (fulfillments || []).filter(f => f.fulfilled === true).length;
}

export function computeRemaining(record, fulfillments, config, asOfDate) {
    const preMonths = record.pre_tenure_months || 0;
    const { baseAmount, monthly, selfPay, prePay } =
        calculateCosts(record.total_fee, preMonths, record.treatment_type, record.relation_type, config);

    if (record.status === 'Settled') {
        return { baseAmount, monthly, selfPay, prePay, fulfilledMonths: 0, deducted: 0, remaining: 0 };
    }

    const fulfilledMonths = fulfilledMonthCount(fulfillments);
    const deducted = monthly * fulfilledMonths;
    const remaining = Math.max(0, baseAmount - deducted);
    return { baseAmount, monthly, selfPay, prePay, fulfilledMonths, deducted, remaining };
}

// ============================================================
// 4. 이행 가능한 월 목록 — record 시작월부터 (asOf 기준) 지난 달까지
//    매니저 화면이 "체크 가능한 월"을 결정할 때 사용.
// ============================================================
export function elapsedMonthList(startDateStr, asOfDate) {
    const out = [];
    if (!startDateStr) return out;
    const start = dayjs(startDateStr).startOf('month');
    // "지난 달까지" — 진행 중인 이번 달은 아직 체크 X (매월말에 일괄 체크)
    const end   = (asOfDate ? dayjs(asOfDate) : dayjs()).startOf('month').subtract(1, 'month');
    if (end.isBefore(start)) return out;
    let cur = start;
    while (cur.isSameOrBefore(end, 'month')) {
        out.push(cur.format('YYYY-MM'));
        cur = cur.add(1, 'month');
    }
    return out;
}

// ============================================================
// 5. CRUD — 동의서 / 이행 / 정산
//    매니저는 staging(pending_changes) 거치고, admin 은 직접 반영.
// ============================================================

// 직접 반영 가능한가? (admin 은 항상, 매니저는 manager_permissions.welfare.commit=true 일 때만)
// false → pending_changes 임시저장 → 관리자 결재 후 반영.
function canCommit() {
    const u = state.currentUser;
    if (!u) return false;
    if (u.role === 'admin') return true;
    return !!(u.isManager && u.manager_permissions?.welfare?.commit === true);
}

export async function createRecord(payload, signatureDataUrl) {
    console.log('[welfare:createRecord] payload=', payload, 'currentUser=', state.currentUser);

    const { data: empRow, error: empErr } = await db.from('employees')
        .select('entry_date').eq('id', payload.employee_id).single();
    if (empErr) { console.error('[welfare:createRecord] empErr=', empErr); throw empErr; }
    const preMonths = empRow?.entry_date ? monthsBetween(empRow.entry_date, payload.start_date) : 0;

    const insertPayload = { ...payload, pre_tenure_months: preMonths, status: 'Active', created_by: state.currentUser?.id || null };
    console.log('[welfare:createRecord] insertPayload=', insertPayload, 'canCommit=', canCommit());

    if (!canCommit()) {
        if (!state.currentUser?.id) throw new Error('로그인 정보가 없습니다 (state.currentUser.id 누락).');
        const { error } = await db.from('pending_changes').insert({
            entity_type: 'welfare_record', action: 'create',
            payload: { ...insertPayload, _signature: signatureDataUrl },
            created_by: state.currentUser.id, status: 'pending',
        });
        if (error) { console.error('[welfare:createRecord] staging error=', error); throw error; }
        return { staged: true };
    }

    const { data: ins, error } = await db.from('welfare_records').insert(insertPayload).select().single();
    console.log('[welfare:createRecord] insert result: ins=', ins, 'error=', error);
    if (error) throw error;
    if (!ins || !ins.id) throw new Error('INSERT 후 row 가 반환되지 않았습니다 (RLS SELECT 차단 의심): ' + JSON.stringify({ins, error}));

    if (signatureDataUrl) {
        const path = `welfare/signatures/${ins.id}.png`;
        const blob = dataUrlToBlob(signatureDataUrl);
        const { error: upErr } = await db.storage.from('docs').upload(path, blob, { contentType: 'image/png', upsert: true });
        if (upErr) console.warn('[welfare:createRecord] 서명 업로드 실패:', upErr.message);
        else await db.from('welfare_records').update({ consent_sig_path: path }).eq('id', ins.id);
    }
    return { staged: false, record: ins };
}

export async function deleteRecord(recordId) {
    if (!canCommit()) {
        const { error } = await db.from('pending_changes').insert({
            entity_type: 'welfare_record', entity_id: recordId, action: 'delete',
            payload: { id: recordId }, created_by: state.currentUser.id, status: 'pending',
        });
        if (error) throw error;
        return { staged: true };
    }
    // 서명 파일 삭제
    const { data: row } = await db.from('welfare_records').select('consent_sig_path').eq('id', recordId).single();
    if (row?.consent_sig_path) {
        await db.storage.from('docs').remove([row.consent_sig_path]).catch(() => {});
    }
    const { error } = await db.from('welfare_records').delete().eq('id', recordId);
    if (error) throw error;
    return { staged: false };
}

export async function upsertFulfillment(recordId, yearMonth, fulfilled, note, attachments) {
    const payload = {
        record_id: recordId, year_month: yearMonth, fulfilled: !!fulfilled,
        verified_by: state.currentUser?.id || null,
        verified_at: new Date().toISOString(),
        note: note || null,
        attachments: Array.isArray(attachments) ? attachments : [],
    };
    if (!canCommit()) {
        if (!state.currentUser?.id) throw new Error('로그인 정보가 없습니다 (state.currentUser.id 누락).');
        // 같은 (record_id, year_month) 의 기존 pending 임시저장분을 먼저 제거 후 재등록.
        // → 매니저가 같은 항목을 여러 번 저장해도 승인 대기가 1건으로 유지(중복 누적 방지).
        const dup = await findPendingFulfillment(recordId, yearMonth);
        if (dup) await db.from('pending_changes').delete().eq('id', dup.id);
        const { error } = await db.from('pending_changes').insert({
            entity_type: 'welfare_fulfillment', action: 'update',
            payload, created_by: state.currentUser.id, status: 'pending',
        });
        if (error) throw error;
        return { staged: true };
    }
    const { error } = await db.from('welfare_monthly_fulfillment')
        .upsert(payload, { onConflict: 'record_id,year_month' });
    if (error) throw error;
    return { staged: false };
}

// (record_id, year_month) 로 아직 승인 전인 내 임시저장분(pending_changes)을 찾는다.
// 있으면 그 payload 를 직접 고쳐써야 한다 — clearPendingFulfillment 로 지우고 좌표만 담은
// 스텁을 새로 꽂으면 체크/메모/사진 같은 실제 입력값이 통째로 사라진다 (한 번 실측한 데이터 유실 버그).
async function findPendingFulfillment(recordId, yearMonth) {
    // 월 이동 스텁은 year_month 대신 to_year_month 를 쓰므로 둘 다 매치해야 한다.
    const { data } = await db.from('pending_changes')
        .select('id, payload')
        .eq('entity_type', 'welfare_fulfillment')
        .eq('status', 'pending')
        .filter('payload->>record_id', 'eq', String(recordId))
        .or(`payload->>year_month.eq.${yearMonth},payload->>to_year_month.eq.${yearMonth}`)
        .maybeSingle();
    return data || null;
}

// 이행 기록 삭제(취소). 실수로 체크한 달을 통째로 지울 때 사용.
// welfare_monthly_fulfillment 는 감사 트리거(trg_welfare_fulfillment_audit)가 모든 UPDATE/DELETE 를
// welfare_audit_log 에 before/after 로 자동 기록하므로, 확정 반영된 기록의 실수 삭제도 그 로그로 복구 가능하다.
export async function deleteFulfillment(recordId, yearMonth) {
    // 아직 승인 전인 내 임시저장분이 있으면 그것부터 취소.
    const existingPending = await findPendingFulfillment(recordId, yearMonth);
    if (existingPending) {
        await db.from('pending_changes').delete().eq('id', existingPending.id);
    }
    if (!canCommit()) {
        if (!state.currentUser?.id) throw new Error('로그인 정보가 없습니다 (state.currentUser.id 누락).');
        // 이미 확정 반영된 실제 기록이 있을 때만 삭제 요청을 스테이징 (없으면 방금 취소로 끝).
        const { data: existing } = await db.from('welfare_monthly_fulfillment')
            .select('id').eq('record_id', recordId).eq('year_month', yearMonth).maybeSingle();
        if (!existing) return { staged: true };
        const { error } = await db.from('pending_changes').insert({
            entity_type: 'welfare_fulfillment', action: 'delete',
            payload: { record_id: recordId, year_month: yearMonth },
            created_by: state.currentUser.id, status: 'pending',
        });
        if (error) throw error;
        return { staged: true };
    }
    const { error } = await db.from('welfare_monthly_fulfillment')
        .delete().eq('record_id', recordId).eq('year_month', yearMonth);
    if (error) throw error;
    return { staged: false };
}

// 이행 기록의 적용 월 변경 (잘못된 달에 체크한 것을 바로잡을 때). 대상 월에 이미 기록이 있으면 막는다
// (덮어써서 기존 기록을 잃는 사고 방지 — 먼저 그 쪽을 정리하도록 안내).
export async function moveFulfillment(recordId, fromYm, toYm) {
    // 아직 승인 전인 내 임시저장분이 있으면 payload 는 그대로 두고 월만 바꾼다 — 데이터 유실 방지.
    const existingPending = await findPendingFulfillment(recordId, fromYm);
    if (existingPending) {
        const p = existingPending.payload || {};
        // 이미 "월 이동" 대기 중인 걸 또 옮기는 경우 — from_year_month(실제 원본 행 기준)는 유지하고
        // 목적지(to_year_month)만 갱신. 그 외(체크/메모 임시저장)는 year_month 만 교체.
        const newPayload = p.to_year_month ? { ...p, to_year_month: toYm } : { ...p, year_month: toYm };
        const { error } = await db.from('pending_changes')
            .update({ payload: newPayload })
            .eq('id', existingPending.id);
        if (error) throw error;
        return { staged: true };
    }
    if (!canCommit()) {
        if (!state.currentUser?.id) throw new Error('로그인 정보가 없습니다 (state.currentUser.id 누락).');
        // 확정 반영된 실제 기록을 옮기는 요청 — pending_changes.action 은 'create'/'update'/'delete' 만
        // 허용(DB 체크 제약)이라 action='update' 로 스테이징하고 payload 의 to_year_month 유무로 구분한다.
        // 승인 시 실제 행의 year_month 컬럼만 바뀌므로 체크/메모/사진은 그대로 보존된다.
        const { error } = await db.from('pending_changes').insert({
            entity_type: 'welfare_fulfillment', action: 'update',
            payload: { record_id: recordId, from_year_month: fromYm, to_year_month: toYm },
            created_by: state.currentUser.id, status: 'pending',
        });
        if (error) throw error;
        return { staged: true };
    }
    const { data: existing } = await db.from('welfare_monthly_fulfillment')
        .select('id').eq('record_id', recordId).eq('year_month', toYm).maybeSingle();
    if (existing) throw new Error(`${toYm} 에 이미 이행 기록이 있어 이동할 수 없습니다. 먼저 그 쪽을 정리해주세요.`);
    const { error } = await db.from('welfare_monthly_fulfillment')
        .update({ year_month: toYm }).eq('record_id', recordId).eq('year_month', fromYm);
    if (error) throw error;
    return { staged: false };
}

export async function processSettlement(employeeId, resignDateStr) {
    if (!canCommit()) {
        const { error } = await db.from('pending_changes').insert({
            entity_type: 'welfare_record', action: 'update',
            payload: { _settlement: true, employee_id: employeeId, resign_date: resignDateStr },
            created_by: state.currentUser.id, status: 'pending',
        });
        if (error) throw error;
        return { staged: true };
    }
    const { error } = await db.from('welfare_records')
        .update({ status: 'Settled', resign_date: resignDateStr })
        .eq('employee_id', employeeId).eq('status', 'Active');
    if (error) throw error;
    return { staged: false };
}

// ============================================================
// 6. 유틸
// ============================================================

export function dataUrlToBlob(dataUrl) {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

export function formatNum(n) {
    if (typeof n !== 'number' || isNaN(n)) return '0';
    return new Intl.NumberFormat('ko-KR').format(Math.round(n));
}

export async function signatureUrlOf(consentSigPath) {
    if (!consentSigPath) return null;
    const { data, error } = await db.storage.from('docs').createSignedUrl(consentSigPath, 60 * 60);
    if (error) return null;
    return data?.signedUrl || null;
}

// ============================================================
// 7. 이행체크 메모 첨부 사진 (docs 버킷, 비공개 → 표시는 signed URL)
// ============================================================

// 압축된 image/jpeg blob 을 docs 버킷에 업로드 → 경로 반환.
// keyPrefix: 폴더 구분자. 이행 체크가 직원 단위로 바뀐 뒤로는 `emp{employee_id}` 를 넘긴다
//            (옛 데이터는 record_id 로 저장돼 있어 그대로 읽힘 — 경로는 표시용 구분일 뿐).
export async function uploadFulfillmentPhoto(keyPrefix, yearMonth, blob, seq) {
    const path = `welfare/fulfillment/${keyPrefix}_${yearMonth}/${Date.now()}_${seq}.jpg`;
    const { error } = await db.storage.from('docs')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    return path;
}

// docs 버킷 파일 삭제 (사진 제거 시). 실패는 무시(멱등).
export async function removeDocsFile(path) {
    if (!path) return;
    await db.storage.from('docs').remove([path]).catch(() => {});
}

// 첨부 경로 배열 → signed URL 배열 (표시용). 실패분은 제외.
export async function docsSignedUrls(paths) {
    const list = Array.isArray(paths) ? paths : [];
    const out = [];
    for (const p of list) {
        const url = await signatureUrlOf(p);
        if (url) out.push({ path: p, url });
    }
    return out;
}

// 클라이언트 이미지 압축 → image/jpeg blob (긴 변 maxDim 제한). 대용량 사진 업로드 대비.
export function compressImage(file, maxDim = 1600, quality = 0.72) {
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
// 8. 복지 미션 게시판 (welfare_posts)
//    직원이 본인 블로그 글 / 혜택 미션 인증을 텍스트 + 사진으로 등록.
//    직원 발신이라 staging 안 거침 (연차 취소 요청과 동일 — 본인 소유 데이터).
//    year_month = 미션 해당 월 (작성일과 별개, 직원이 선택. 기본 = 이번 달)
// ============================================================

export function currentYearMonth() {
    return dayjs().format('YYYY-MM');
}

// 게시판 글 로드 (소프트 삭제된 글은 제외). 휴지통 조회는 loadDeletedWelfarePosts() 사용.
//   employeeId 지정 → 본인 글만 (직원 화면) / 미지정 → 전체 (관리자 화면)
export async function loadWelfarePosts({ employeeId = null, yearMonth = null, category = null } = {}) {
    let q = db.from('welfare_posts')
        .select('*, employee:employees!welfare_posts_employee_id_fkey(id, name, email, department_id)')
        .is('deleted_at', null)
        .order('year_month', { ascending: false })
        .order('created_at', { ascending: false });
    if (employeeId) q = q.eq('employee_id', employeeId);
    if (yearMonth)  q = q.eq('year_month', yearMonth);
    if (category)   q = q.eq('category', category);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
}

// 관리자 휴지통 — 소프트 삭제된 글만 (삭제 시각 최신순).
export async function loadDeletedWelfarePosts({ yearMonth = null } = {}) {
    let q = db.from('welfare_posts')
        .select('*, employee:employees!welfare_posts_employee_id_fkey(id, name, email, department_id)')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
    if (yearMonth) q = q.eq('year_month', yearMonth);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
}

// 직원·월별 글 개수 맵 — 관리자 이행 그리드에서 "직원이 올렸는지" 표기용.
// 반환: { "<employee_id>_<YYYY-MM>": 글 수 }
export async function loadPostCountsByEmpMonth() {
    const { data, error } = await db.from('welfare_posts').select('employee_id, year_month').is('deleted_at', null);
    if (error) { console.warn('[welfare] 미션 글 집계 실패:', error.message); return {}; }
    const map = {};
    (data || []).forEach(p => {
        const k = `${p.employee_id}_${p.year_month}`;
        map[k] = (map[k] || 0) + 1;
    });
    return map;
}

export async function createWelfarePost({ employeeId, yearMonth, category, title, body, linkUrl, photos }) {
    if (!employeeId) throw new Error('로그인 정보가 없습니다.');
    const { data, error } = await db.from('welfare_posts').insert({
        employee_id: employeeId,
        year_month:  yearMonth || currentYearMonth(),
        category:    category === 'blog' ? 'blog' : 'mission',
        title:       (title || '').trim(),
        body:        (body || '').trim(),
        link_url:    (linkUrl || '').trim() || null,
        photos:      Array.isArray(photos) ? photos : [],
    }).select().single();
    if (error) throw error;
    return data;
}

export async function updateWelfarePost(id, { yearMonth, category, title, body, linkUrl, photos }) {
    const { error } = await db.from('welfare_posts').update({
        year_month: yearMonth,
        category:   category === 'blog' ? 'blog' : 'mission',
        title:      (title || '').trim(),
        body:       (body || '').trim(),
        link_url:   (linkUrl || '').trim() || null,
        photos:     Array.isArray(photos) ? photos : [],
    }).eq('id', id);
    if (error) throw error;
}

// 글 삭제 — 소프트 삭제(휴지통行). 행/사진은 보존되어 복원 가능하다.
// 실수로 지운 직원 데이터를 되돌릴 수 있어야 하므로 하드 삭제는 하지 않는다 (purgeWelfarePost 참고).
export async function deleteWelfarePost(id) {
    const { error } = await db.from('welfare_posts')
        .update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
}

// 휴지통에서 복원 — 실수로 삭제된 글을 원상복구.
export async function restoreWelfarePost(id) {
    const { error } = await db.from('welfare_posts').update({ deleted_at: null }).eq('id', id);
    if (error) throw error;
}

// 영구 삭제 — 휴지통에서만 호출. 행 + 첨부 사진을 실제로 제거하며 되돌릴 수 없다.
// 정말 유효하지 않은(스팸·오등록 등) 글을 관리자가 확인 후 확정 삭제할 때만 사용.
export async function purgeWelfarePost(id) {
    const { data: row } = await db.from('welfare_posts').select('photos').eq('id', id).single();
    const { error } = await db.from('welfare_posts').delete().eq('id', id);
    if (error) throw error;
    const paths = Array.isArray(row?.photos) ? row.photos : [];
    if (paths.length) await db.storage.from('docs').remove(paths).catch(() => {});
}

// 게시판 사진 업로드 (압축된 image/jpeg blob) → docs 버킷 경로 반환.
export async function uploadPostPhoto(employeeId, blob, seq) {
    const path = `welfare/posts/${employeeId}/${Date.now()}_${seq}.jpg`;
    const { error } = await db.storage.from('docs')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    return path;
}
