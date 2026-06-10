// 진료비 복지 — 데이터 + 계산 로직
// Apps Script (code.gs) 1:1 포팅 + 잔액 계산을 "이행 인정 개월수" 기반으로 교체.
import { state, db } from './state.js?v=20260610e';

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

export async function upsertFulfillment(recordId, yearMonth, fulfilled, note) {
    const payload = {
        record_id: recordId, year_month: yearMonth, fulfilled: !!fulfilled,
        verified_by: state.currentUser?.id || null,
        verified_at: new Date().toISOString(),
        note: note || null,
    };
    if (!canCommit()) {
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
