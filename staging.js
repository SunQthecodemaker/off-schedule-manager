// =========================================================================================
// 매니저 임시저장(staging) 모듈
//
// 매니저가 5개 메뉴(서류 검토 / 연차 관리 / 직원 관리 / 부서 관리 / 서식 관리)에서
// 수정·생성·삭제하면 즉시 DB 반영 대신 pending_changes 테이블에 임시저장된다.
// 관리자가 [전체 승인] 또는 [개별 승인] 누르면 applyChange 가 실제 테이블에 반영.
// =========================================================================================
import { state, db } from './state.js?v=20260624b';
import { dataUrlToBlob } from './welfare.js';

// ---------- 매니저 측: 임시저장 ----------

/**
 * 매니저의 변경 의도를 pending_changes 에 저장한다.
 * @param {string} entityType  'employee' | 'department' | 'leave_management' | 'document' | 'document_request' | 'form_template'
 * @param {number|null} entityId  대상 row id (create 시 null)
 * @param {string} action  'create' | 'update' | 'delete'
 * @param {object} payload  변경 후 값(또는 update 시 변경된 필드만)
 * @param {object|null} originalSnapshot  변경 전 스냅샷(검토용, 가능하면 전달)
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function stageChange(entityType, entityId, action, payload, originalSnapshot = null) {
    const me = state.currentUser;
    if (!me?.id) return { ok: false, error: '로그인 정보 없음' };

    const { error } = await db.from('pending_changes').insert({
        entity_type: entityType,
        entity_id: entityId,
        action,
        payload,
        original_snapshot: originalSnapshot,
        created_by: me.id,
        status: 'pending'
    });

    if (error) {
        console.error('staging 실패:', error);
        return { ok: false, error: error.message };
    }
    return { ok: true };
}

/** 매니저가 본인이 임시저장한 항목 표시용 (entityType + entityId 매칭, status='pending') */
export async function getStagingForEntity(entityType, entityId) {
    const { data, error } = await db.from('pending_changes')
        .select('*')
        .eq('entity_type', entityType)
        .eq('status', 'pending')
        .eq(entityId === null ? 'entity_type' : 'entity_id', entityId === null ? entityType : entityId);
    if (error) return [];
    return data || [];
}

/**
 * 매니저 모드인지 판단. 관리자(state.userRole==='admin')는 false 반환.
 * @deprecated shouldStage(menuKey) 권장 — 메뉴별 [확정] 권한 분기 가능.
 */
export function isStagingMode() {
    return state.userRole !== 'admin';
}

/**
 * 핸들러가 임시저장(staging) 으로 가야 하는지 판단.
 * - admin: 항상 false (즉시 반영)
 * - 매니저: 해당 메뉴의 [확정] 권한 켜져 있으면 false (즉시), 꺼져 있으면 true (임시저장)
 * - 일반 직원: true (안전하게 임시저장 — 사실 호출 자체가 잘못된 경로)
 * @param {string} menuKey  manager_permissions 의 메뉴 키
 *   (schedule | leave_request_list | leave_status | document_review |
 *    leave_management | employee_management | department | form)
 */
export function shouldStage(menuKey) {
    if (state.userRole === 'admin') return false;
    const u = state.currentUser;
    if (!u) return true;
    const perm = u.manager_permissions && u.manager_permissions[menuKey];
    if (!perm) return true;  // 권한 정보 없으면 안전쪽으로 staging
    return !perm.commit;
}

/** 공통 토스트(없으면 alert) */
export function notifyStaged() {
    if (typeof window.showToast === 'function') {
        window.showToast('임시저장됨 — 관리자 승인 후 반영됩니다.');
    } else {
        alert('변경사항이 임시저장되었습니다. 관리자 승인 후 실제 데이터에 반영됩니다.');
    }
}

// ---------- 관리자 측: 조회·승인·반려 ----------

export async function loadPendingChanges() {
    const { data, error } = await db.from('pending_changes')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
    if (error) {
        console.error('pending_changes 조회 실패:', error);
        return [];
    }
    return data || [];
}

export async function approvePendingChange(id) {
    const { data: rows, error: loadErr } = await db.from('pending_changes')
        .select('*').eq('id', id).maybeSingle();
    if (loadErr || !rows) return { ok: false, error: loadErr?.message || '항목 없음' };
    if (rows.status !== 'pending') return { ok: false, error: '이미 처리된 항목' };

    const applyResult = await applyChange(rows);
    if (!applyResult.ok) return applyResult;

    const me = state.currentUser;
    const { error: updErr } = await db.from('pending_changes').update({
        status: 'approved',
        reviewed_by: me?.id || null,
        reviewed_at: new Date().toISOString()
    }).eq('id', id);
    if (updErr) return { ok: false, error: updErr.message };
    return { ok: true };
}

export async function rejectPendingChange(id, reason) {
    const me = state.currentUser;
    const { error } = await db.from('pending_changes').update({
        status: 'rejected',
        rejection_reason: reason || null,
        reviewed_by: me?.id || null,
        reviewed_at: new Date().toISOString()
    }).eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
}

export async function approveAllPending() {
    const items = await loadPendingChanges();
    const results = { success: 0, failed: 0, errors: [] };
    for (const it of items) {
        const r = await approvePendingChange(it.id);
        if (r.ok) results.success++;
        else { results.failed++; results.errors.push(`#${it.id}: ${r.error}`); }
    }
    return results;
}

export async function rejectAllPending(reason) {
    const items = await loadPendingChanges();
    const results = { success: 0, failed: 0 };
    for (const it of items) {
        const r = await rejectPendingChange(it.id, reason);
        if (r.ok) results.success++; else results.failed++;
    }
    return results;
}

// ---------- 실제 DB 반영 reducer (entity_type 별) ----------

async function applyChange(change) {
    const { entity_type, entity_id, action, payload } = change;

    try {
        switch (entity_type) {
            case 'employee':
                return await applyEmployee(action, entity_id, payload);
            case 'department':
                return await applyDepartment(action, entity_id, payload);
            case 'leave_management':
                return await applyLeaveManagement(action, entity_id, payload);
            case 'leave_approval':
                return await applyLeaveApproval(action, entity_id, payload, change.reviewed_by);
            case 'leave_request':
                return await applyLeaveRequest(action, entity_id, payload);
            case 'leave_cancel':
                return await applyLeaveCancel(entity_id, payload);
            case 'document_request':
                return await applyDocumentRequest(action, entity_id, payload);
            case 'document':
                return await applyDocument(action, entity_id, payload);
            case 'form_template':
                return await applyFormTemplate(action, entity_id, payload);
            case 'welfare_record':
                return await applyWelfareRecord(action, entity_id, payload);
            case 'welfare_fulfillment':
                return await applyWelfareFulfillment(action, payload);
            default:
                return { ok: false, error: `알 수 없는 entity_type: ${entity_type}` };
        }
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function applyEmployee(action, id, payload) {
    if (action === 'create') {
        const { error } = await db.from('employees').insert([payload]);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'update') {
        const { error } = await db.from('employees').update(payload).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'delete') {
        const { error } = await db.from('employees').delete().eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

async function applyDepartment(action, id, payload) {
    if (action === 'create') {
        const { error } = await db.from('departments').insert([payload]);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'update') {
        const { error } = await db.from('departments').update(payload).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'delete') {
        await db.from('employees').update({ department_id: null }).eq('department_id', id);
        const { error } = await db.from('departments').delete().eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

async function applyLeaveManagement(action, id, payload) {
    // payload: { table: 'employees'|'leave_settlements'|'leave_adjustments', data: {...} }
    const tbl = payload?.table || 'employees';
    const data = payload?.data || payload;
    if (action === 'update') {
        const { error } = await db.from(tbl).update(data).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'create') {
        const { error } = await db.from(tbl).insert([data]);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'delete') {
        const { error } = await db.from(tbl).delete().eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

// 매니저의 [중간 승인]/[중간 반려] 의사를 관리자가 staging 승인 시 처리.
// approved 면 middle + final 동시 도장 (관리자가 본 것 자체가 최종 승인) + schedules 휴무 동기화.
// rejected 면 middle/final 모두 rejected + rejection_reason 저장.
async function applyLeaveApproval(action, id, payload, reviewerId) {
    const decision = payload?.decision;
    const reason = payload?.reason || null;
    const me = state.currentUser;
    const adminId = me?.id || reviewerId || null;

    if (decision === 'approved') {
        const nowIso = new Date().toISOString();
        const updateData = {
            middle_manager_status: 'approved',
            middle_approved_at: nowIso,
            final_manager_id: adminId,
            final_manager_status: 'approved',
            final_approved_at: nowIso,
            status: 'approved'
        };
        const { error } = await db.from('leave_requests').update(updateData).eq('id', id);
        if (error) return { ok: false, error: error.message };

        // schedules 휴무 동기화 (handleFinalApproval 의 syncLeaveToSchedules 와 동일 로직)
        try {
            const { data: req } = await db.from('leave_requests')
                .select('employee_id, dates').eq('id', id).single();
            if (req?.dates?.length) {
                for (const date of req.dates) {
                    const { data: existing } = await db.from('schedules')
                        .select('id').eq('employee_id', req.employee_id).eq('date', date);
                    if (existing && existing.length > 0) {
                        await db.from('schedules').update({ status: '휴무' })
                            .eq('employee_id', req.employee_id).eq('date', date);
                    }
                }
            }
        } catch (e) {
            console.warn('schedules 동기화 실패 (비치명적):', e);
        }
        return { ok: true };
    }

    if (decision === 'rejected') {
        const updateData = {
            middle_manager_status: 'rejected',
            final_manager_status: 'rejected',
            status: 'rejected'
        };
        if (reason) updateData.rejection_reason = reason;
        const { error } = await db.from('leave_requests').update(updateData).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }

    return { ok: false, error: `unknown decision: ${decision}` };
}

// 매니저의 단일 연차 신청 CRUD (우클릭 삭제·취소·수동등록 등 leave_approval 외 경로).
// payload 구조에 따라 적절히 처리.
async function applyLeaveRequest(action, id, payload) {
    if (action === 'create') {
        const { error } = await db.from('leave_requests').insert([payload]);
        if (error) return { ok: false, error: error.message };
        // 휴무 동기화 (수동 등록 시 schedules 도 휴무로)
        if (payload?.employee_id && Array.isArray(payload?.dates)) {
            try {
                for (const date of payload.dates) {
                    const { data: existing } = await db.from('schedules')
                        .select('id').eq('employee_id', payload.employee_id).eq('date', date);
                    if (existing && existing.length > 0) {
                        await db.from('schedules').update({ status: '휴무' })
                            .eq('employee_id', payload.employee_id).eq('date', date);
                    }
                }
            } catch (e) { console.warn('schedules 동기화 실패:', e); }
        }
        return { ok: true };
    }
    if (action === 'update') {
        const { error } = await db.from('leave_requests').update(payload).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'delete') {
        const { error } = await db.from('leave_requests').delete().eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

// 직원의 연차 취소 요청 승인 (매니저 단독 또는 원장).
// payload: { dates: [취소할 날짜들 — 보통 '오늘 이후'], reason? }
// - 취소 대상 날짜를 leave_requests.dates 에서 제거.
// - 남는 날짜가 없으면 status='cancelled' (DELETE 안 함 — anon DELETE RLS 회피 + 감사 추적 보존).
// - 일부만 취소(과거+미래 혼합)면 dates 만 갱신하고 status 유지.
async function applyLeaveCancel(id, payload) {
    const cancelDates = Array.isArray(payload?.dates) ? payload.dates : [];
    const { data: req, error: loadErr } = await db.from('leave_requests')
        .select('dates, status').eq('id', id).maybeSingle();
    if (loadErr) return { ok: false, error: loadErr.message };
    if (!req) return { ok: false, error: '연차 신청을 찾을 수 없습니다 (이미 삭제/취소됨).' };

    const curDates = Array.isArray(req.dates) ? req.dates : [];
    const remaining = cancelDates.length > 0
        ? curDates.filter(d => !cancelDates.includes(d))
        : [];  // 취소 날짜 미지정 → 전체 취소로 간주

    const updateData = (remaining.length > 0)
        ? { dates: remaining }                       // 일부 취소 — status 유지
        : { dates: [], status: 'cancelled' };        // 전체 취소 — soft cancel

    const { error } = await db.from('leave_requests').update(updateData).eq('id', id);
    return error ? { ok: false, error: error.message } : { ok: true };
}

async function applyDocumentRequest(action, id, payload) {
    if (action === 'create') {
        const { error } = await db.from('document_requests').insert([payload]);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'update') {
        const { error } = await db.from('document_requests').update(payload).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'delete') {
        const { error } = await db.from('document_requests').delete().eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

async function applyDocument(action, id, payload) {
    // payload: { status: 'approved'|'rejected', rejection_reason?, ... }
    if (action === 'update') {
        const { error } = await db.from('submitted_documents').update(payload).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'document only supports update' };
}

async function applyFormTemplate(action, id, payload) {
    if (action === 'create') {
        const { error } = await db.from('document_templates').insert([payload]);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'update') {
        const { error } = await db.from('document_templates').update(payload).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'delete') {
        const { error } = await db.from('document_templates').delete().eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

// 진료비 복지 - 동의서/진료기록 (welfare_records)
// create payload 에 _signature(dataURL) 가 있으면 INSERT 후 Storage 업로드 + consent_sig_path UPDATE.
// update with payload._settlement=true 는 퇴사 정산 (employee_id 의 Active row 일괄 Settled).
async function applyWelfareRecord(action, id, payload) {
    if (action === 'create') {
        const { _signature, ...insertPayload } = payload || {};
        const { data: ins, error } = await db.from('welfare_records').insert(insertPayload).select().single();
        if (error) return { ok: false, error: error.message };
        if (!ins?.id) return { ok: false, error: 'INSERT 후 row 미반환 (RLS SELECT 차단 의심)' };
        if (_signature) {
            try {
                const path = `welfare/signatures/${ins.id}.png`;
                const blob = dataUrlToBlob(_signature);
                const { error: upErr } = await db.storage.from('docs').upload(path, blob, { contentType: 'image/png', upsert: true });
                if (!upErr) {
                    await db.from('welfare_records').update({ consent_sig_path: path }).eq('id', ins.id);
                } else {
                    console.warn('[staging:welfare_record] 서명 업로드 실패:', upErr.message);
                }
            } catch (e) {
                console.warn('[staging:welfare_record] 서명 처리 예외:', e);
            }
        }
        return { ok: true };
    }
    if (action === 'update') {
        // 퇴사 정산 분기 (welfare.js processSettlement 의 staging payload)
        if (payload && payload._settlement === true) {
            const { employee_id, resign_date } = payload;
            if (!employee_id) return { ok: false, error: 'settlement: employee_id 누락' };
            const { error } = await db.from('welfare_records')
                .update({ status: 'Settled', resign_date: resign_date || null })
                .eq('employee_id', employee_id).eq('status', 'Active');
            return error ? { ok: false, error: error.message } : { ok: true };
        }
        // 일반 update
        const { error } = await db.from('welfare_records').update(payload).eq('id', id);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    if (action === 'delete') {
        // 서명 파일도 삭제
        const targetId = id || payload?.id;
        if (!targetId) return { ok: false, error: 'delete: id 누락' };
        const { data: row } = await db.from('welfare_records').select('consent_sig_path').eq('id', targetId).single();
        if (row?.consent_sig_path) {
            await db.storage.from('docs').remove([row.consent_sig_path]).catch(() => {});
        }
        const { error } = await db.from('welfare_records').delete().eq('id', targetId);
        return error ? { ok: false, error: error.message } : { ok: true };
    }
    return { ok: false, error: 'unknown action' };
}

// 진료비 복지 - 월별 이행 체크 (welfare_monthly_fulfillment)
// payload: { record_id, year_month, fulfilled, verified_by, verified_at, note }
// (record_id, year_month) unique 제약 → upsert.
async function applyWelfareFulfillment(action, payload) {
    if (action !== 'update') return { ok: false, error: 'welfare_fulfillment only supports update (upsert)' };
    if (!payload?.record_id || !payload?.year_month) {
        return { ok: false, error: 'welfare_fulfillment: record_id 또는 year_month 누락' };
    }
    const { error } = await db.from('welfare_monthly_fulfillment')
        .upsert(payload, { onConflict: 'record_id,year_month' });
    return error ? { ok: false, error: error.message } : { ok: true };
}
