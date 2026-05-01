// =========================================================================================
// 매니저 임시저장(staging) 모듈
//
// 매니저가 5개 메뉴(서류 검토 / 연차 관리 / 직원 관리 / 부서 관리 / 서식 관리)에서
// 수정·생성·삭제하면 즉시 DB 반영 대신 pending_changes 테이블에 임시저장된다.
// 관리자가 [전체 승인] 또는 [개별 승인] 누르면 applyChange 가 실제 테이블에 반영.
// =========================================================================================
import { state, db } from './state.js?v=20260501f';

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
 * 5개 메뉴 핸들러 진입 시 이 함수로 분기 → true면 stageChange 후 return.
 */
export function isStagingMode() {
    return state.userRole !== 'admin';
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
            case 'document_request':
                return await applyDocumentRequest(action, entity_id, payload);
            case 'document':
                return await applyDocument(action, entity_id, payload);
            case 'form_template':
                return await applyFormTemplate(action, entity_id, payload);
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
