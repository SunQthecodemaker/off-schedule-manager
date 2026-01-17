import { state, db } from './state.js';
import { _, show, hide } from './utils.js';

// =========================================================================================
// 서류 검토 탭 (관리자용)
// =========================================================================================

export function renderDocumentReviewTab(container) {
    container.innerHTML = getDocumentReviewHTML();
    
    // 데이터 로드 및 렌더링
    renderRequestedDocuments();
    renderPendingDocuments();
    renderCompletedDocuments();
    
    // 이벤트 리스너
    _('#create-doc-request-btn')?.addEventListener('click', openCreateRequestModal);
}

function getDocumentReviewHTML() {
    return `
        <div class="space-y-6">
            <!-- 서류 요청 목록 (제출 전) -->
            <div class="bg-white p-4 rounded-lg border">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-semibold">서류 제출 요청 관리 <span class="text-sm text-gray-500">(직원에게 요청한 서류)</span></h3>
                    <button id="create-doc-request-btn" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold">+ 새 요청 생성</button>
                </div>
                <div id="requested-documents-list"></div>
            </div>
            
            <!-- 승인 대기 중인 서류 -->
            <div class="bg-white p-4 rounded-lg border">
                <h3 class="text-lg font-semibold mb-4">제출된 서류 <span class="text-sm text-gray-500">(승인 대기 중)</span></h3>
                <div id="pending-documents-list"></div>
            </div>
            
            <!-- 처리 완료된 서류 -->
            <div class="bg-white p-4 rounded-lg border">
                <h3 class="text-lg font-semibold mb-4">처리 완료된 서류 <span class="text-sm text-gray-500">(승인/반려 완료)</span></h3>
                <div id="completed-documents-list"></div>
            </div>
        </div>
    `;
}

function renderRequestedDocuments() {
    const container = _('#requested-documents-list');
    if (!container) {
        console.error('⛔ requested-documents-list 컨테이너를 찾을 수 없습니다');
        return;
    }
    
    const { documentRequests, employees } = state.management;
    
    if (!documentRequests || documentRequests.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">서류 제출 요청이 없습니다.</p>';
        return;
    }
    
    // pending 상태만 표시
    const requestedDocs = documentRequests.filter(req => req.status === 'pending');
    
    if (requestedDocs.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">대기 중인 요청이 없습니다.</p>';
        return;
    }
    
    const rows = requestedDocs.map(req => {
        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-3">${req.employeeName || '알 수 없음'}</td>
                <td class="p-3">${req.type || '일반 서류'}</td>
                <td class="p-3 text-sm text-gray-600">${req.message || '-'}</td>
                <td class="p-3">${dayjs(req.created_at).format('YYYY-MM-DD HH:mm')}</td>
                <td class="p-3">
                    <span class="bg-yellow-200 text-yellow-800 text-xs font-medium px-2.5 py-0.5 rounded-full">제출 대기</span>
                </td>
                <td class="p-3 text-center">
                    <button onclick="window.cancelDocumentRequest(${req.id})" class="text-sm bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600">취소</button>
                </td>
            </tr>
        `;
    }).join('');
    
    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left text-xs">직원</th>
                    <th class="p-3 text-left text-xs">서류 유형</th>
                    <th class="p-3 text-left text-xs">요청 사유</th>
                    <th class="p-3 text-left text-xs">요청일시</th>
                    <th class="p-3 text-left text-xs">상태</th>
                    <th class="p-3 text-center text-xs">관리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function renderPendingDocuments() {
    const container = _('#pending-documents-list');
    if (!container) return;
    
    const { submittedDocs } = state.management;
    
    if (!submittedDocs || submittedDocs.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">제출된 서류가 없습니다.</p>';
        return;
    }
    
    const pendingDocs = submittedDocs.filter(doc => doc.status === 'submitted');
    
    if (pendingDocs.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">승인 대기 중인 서류가 없습니다.</p>';
        return;
    }
    
    const rows = pendingDocs.map(doc => {
        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-3">${doc.employee_name || '알 수 없음'}</td>
                <td class="p-3">${doc.template_name || '일반 서류'}</td>
                <td class="p-3 text-sm text-gray-600">${dayjs(doc.created_at).format('YYYY-MM-DD HH:mm')}</td>
                <td class="p-3">
                    <span class="bg-yellow-200 text-yellow-800 text-xs font-medium px-2.5 py-0.5 rounded-full">검토 대기</span>
                </td>
                <td class="p-3 text-center">
                    <button onclick="window.viewDocument(${doc.id})" class="text-sm bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 mr-2">내용 보기</button>
                    <button onclick="window.approveDocument(${doc.id})" class="text-sm bg-green-500 text-white px-3 py-1 rounded hover:bg-green-600 mr-2">승인</button>
                    <button onclick="window.rejectDocument(${doc.id})" class="text-sm bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600">반려</button>
                </td>
            </tr>
        `;
    }).join('');
    
    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left text-xs">제출자</th>
                    <th class="p-3 text-left text-xs">서식명</th>
                    <th class="p-3 text-left text-xs">제출일시</th>
                    <th class="p-3 text-left text-xs">상태</th>
                    <th class="p-3 text-center text-xs">관리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function renderCompletedDocuments() {
    const container = _('#completed-documents-list');
    if (!container) return;
    
    const { submittedDocs } = state.management;
    
    if (!submittedDocs || submittedDocs.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">제출된 서류가 없습니다.</p>';
        return;
    }
    
    const completedDocs = submittedDocs.filter(doc => doc.status === 'approved' || doc.status === 'rejected');
    
    if (completedDocs.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">처리 완료된 서류가 없습니다.</p>';
        return;
    }
    
    const rows = completedDocs.map(doc => {
        let statusBadge = '';
        
        if (doc.status === 'approved') {
            statusBadge = '<span class="bg-green-200 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded-full">승인됨</span>';
        } else if (doc.status === 'rejected') {
            statusBadge = '<span class="bg-red-200 text-red-800 text-xs font-medium px-2.5 py-0.5 rounded-full">반려됨</span>';
        }
        
        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-3">${doc.employee_name || '알 수 없음'}</td>
                <td class="p-3">${doc.template_name || '일반 서류'}</td>
                <td class="p-3 text-sm text-gray-600">${dayjs(doc.created_at).format('YYYY-MM-DD HH:mm')}</td>
                <td class="p-3">${statusBadge}</td>
                <td class="p-3 text-center">
                    <button onclick="window.viewDocument(${doc.id})" class="text-sm bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600">내용 보기</button>
                </td>
            </tr>
        `;
    }).join('');
    
    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left text-xs">제출자</th>
                    <th class="p-3 text-left text-xs">서식명</th>
                    <th class="p-3 text-left text-xs">제출일시</th>
                    <th class="p-3 text-left text-xs">상태</th>
                    <th class="p-3 text-center text-xs">관리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// =========================================================================================
// 서류 요청 생성 - 서식 목록 동적 로딩으로 수정
// =========================================================================================

function openCreateRequestModal() {
    const { employees, templates } = state.management;
    
    const employeeOptions = employees.map(emp => 
        `<option value="${emp.id}">${emp.name} (${emp.departments?.name || '부서 미지정'})</option>`
    ).join('');
    
    // 서식 목록을 동적으로 가져오기
    const templateOptions = templates && templates.length > 0 
        ? templates.map(template => 
            `<option value="${template.template_name}" data-template-id="${template.id}" data-requires-attachment="${template.requires_attachment || false}">${template.template_name}</option>`
          ).join('')
        : '<option value="기타">기타</option>';
    
    const modalHTML = `
        <div id="temp-request-modal" class="modal-overlay">
            <div class="modal-content">
                <div class="flex justify-between items-center border-b pb-3 mb-4">
                    <h2 class="text-2xl font-bold">서류 제출 요청</h2>
                    <button id="close-temp-request-modal" class="text-3xl">&times;</button>
                </div>
                <form id="document-request-form" class="space-y-4">
                    <div>
                        <label class="block font-semibold mb-2">대상 직원</label>
                        <select id="req-employee-id" class="w-full p-2 border rounded" required>
                            <option value="">-- 직원 선택 --</option>
                            ${employeeOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block font-semibold mb-2">서류 유형</label>
                        <select id="req-type" class="w-full p-2 border rounded">
                            ${templateOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block font-semibold mb-2">요청 사유</label>
                        <textarea id="req-message" rows="3" class="w-full p-2 border rounded" placeholder="예: 무단결근으로 인한 경위서 제출" required></textarea>
                    </div>
                    <div class="flex justify-end space-x-3 pt-4 border-t">
                        <button type="button" id="cancel-request-btn" class="px-4 py-2 bg-gray-300 rounded">취소</button>
                        <button type="submit" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-bold">요청 생성</button>
                    </div>
                </form>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    
    _('#close-temp-request-modal').addEventListener('click', closeRequestModal);
    _('#cancel-request-btn').addEventListener('click', closeRequestModal);
    _('#document-request-form').addEventListener('submit', handleCreateRequest);
}

function closeRequestModal() {
    const modal = _('#temp-request-modal');
    if (modal) modal.remove();
}

async function handleCreateRequest(e) {
    e.preventDefault();
    
    const employeeId = parseInt(_('#req-employee-id').value);
    const employee = state.management.employees.find(emp => emp.id === employeeId);
    const type = _('#req-type').value;
    const message = _('#req-message').value.trim();
    
    if (!employee) {
        alert('직원을 선택해주세요.');
        return;
    }
    
    try {
        const { error } = await db.from('document_requests').insert({
            employeeId: employeeId,
            employeeName: employee.name,
            type: type,
            message: message,
            status: 'pending',
            created_at: new Date().toISOString()
        });
        
        if (error) throw error;
        
        alert(`${employee.name} 직원에게 서류 제출 요청이 전송되었습니다.`);
        
        closeRequestModal();
        await window.loadAndRenderManagement();
    } catch (error) {
        console.error('서류 요청 생성 실패:', error);
        alert('서류 요청 생성에 실패했습니다: ' + error.message);
    }
}

// =========================================================================================
// 서류 승인/반려
// =========================================================================================

window.approveDocument = async function(docId) {
    if (!confirm('이 서류를 승인하시겠습니까?')) return;
    
    try {
        const { error: docError } = await db.from('submitted_documents')
            .update({ status: 'approved' })
            .eq('id', docId);
        
        if (docError) throw docError;
        
        const doc = state.management.submittedDocs.find(d => d.id === docId);
        if (doc && doc.related_issue_id) {
            await db.from('document_requests')
                .update({ status: 'approved' })
                .eq('id', doc.related_issue_id);
        }
        
        alert('서류가 승인되었습니다.');
        await window.loadAndRenderManagement();
    } catch (error) {
        console.error('서류 승인 실패:', error);
        alert('서류 승인에 실패했습니다: ' + error.message);
    }
};

window.rejectDocument = async function(docId) {
    const feedback = prompt('반려 사유를 입력해주세요:');
    if (!feedback) return;
    
    try {
        const { error: docError } = await db.from('submitted_documents')
            .update({ status: 'rejected' })
            .eq('id', docId);
        
        if (docError) throw docError;
        
        const doc = state.management.submittedDocs.find(d => d.id === docId);
        if (doc && doc.related_issue_id) {
            await db.from('document_requests')
                .update({ 
                    status: 'pending',
                    message: `${doc.message || ''}\n\n[반려 사유: ${feedback}]`
                })
                .eq('id', doc.related_issue_id);
        }
        
        alert('서류가 반려되었습니다.');
        await window.loadAndRenderManagement();
    } catch (error) {
        console.error('서류 반려 실패:', error);
        alert('서류 반려에 실패했습니다: ' + error.message);
    }
};

window.cancelDocumentRequest = async function(requestId) {
    if (!confirm('이 요청을 취소하시겠습니까?')) return;
    
    try {
        const { error } = await db.from('document_requests')
            .delete()
            .eq('id', requestId);
        
        if (error) throw error;
        
        alert('요청이 취소되었습니다.');
        await window.loadAndRenderManagement();
    } catch (error) {
        console.error('요청 취소 실패:', error);
        alert('요청 취소에 실패했습니다: ' + error.message);
    }
};

window.viewDocument = function(docId) {
    const doc = state.management.submittedDocs.find(d => d.id === docId);
    if (!doc) {
        alert('서류를 찾을 수 없습니다.');
        return;
    }
    
    const content = doc.submission_data?.text || doc.text || '내용 없음';
    const attachmentHtml = doc.attachment_url ? 
        `<div class="mb-4"><strong>첨부파일:</strong> <a href="${doc.attachment_url}" target="_blank" class="text-blue-600 hover:underline">파일 보기</a></div>` : '';
    
    const modalHTML = `
        <div class="modal-overlay" id="view-doc-modal">
            <div class="modal-content-lg" style="max-height: 90vh; overflow-y: auto;">
                <div class="flex justify-between items-center border-b pb-3 mb-4">
                    <h2 class="text-2xl font-bold">${doc.template_name || '서류'} 내용</h2>
                    <button id="close-view-doc-modal" class="text-3xl">&times;</button>
                </div>
                <div class="bg-white border-2 border-gray-800 p-6">
                    <div class="text-center mb-6">
                        <h1 class="text-2xl font-bold mb-2">${doc.template_name || '서류'}</h1>
                        <div class="text-xs text-gray-600">제출자: ${doc.employee_name}</div>
                        <div class="text-xs text-gray-600">제출일시: ${dayjs(doc.created_at).format('YYYY-MM-DD HH:mm')}</div>
                    </div>
                    ${attachmentHtml}
                    <div class="mb-4 whitespace-pre-wrap border p-4 rounded" style="line-height: 1.8;">${content}</div>
                    ${doc.signature ? `<div class="text-right"><img src="${doc.signature}" alt="서명" class="inline-block border-2 border-gray-800" style="width: 180px; height: 90px;"></div>` : ''}
                </div>
                <div class="flex justify-end pt-4 mt-4 border-t">
                    <button id="close-view-doc-btn" class="px-6 py-2 bg-gray-300 rounded hover:bg-gray-400">닫기</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    
    _('#close-view-doc-modal')?.addEventListener('click', () => {
        _('#view-doc-modal')?.remove();
    });
    _('#close-view-doc-btn')?.addEventListener('click', () => {
        _('#view-doc-modal')?.remove();
    });
};

// =========================================================================================
// 서식 관리
// =========================================================================================

export function getManagementTemplatesHTML() {
    return `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <!-- 왼쪽: 서식 편집기 -->
            <div class="bg-white border rounded-lg p-6">
                <h3 class="text-xl font-bold mb-4">서식 만들기/수정</h3>
                
                <form id="template-form" class="space-y-4">
                    <input type="hidden" id="template-id" value="">
                    
                    <div>
                        <label class="block font-semibold mb-2">서식 이름 *</label>
                        <input type="text" id="templateName" 
                               class="w-full p-2 border rounded" 
                               placeholder="예: 시말서, 경위서" required>
                    </div>
                    
                    <div>
                        <label class="block font-semibold mb-2">설명</label>
                        <textarea id="templateDescription" rows="2" 
                                  class="w-full p-2 border rounded text-sm" 
                                  placeholder="이 서식의 용도를 간단히 설명하세요"></textarea>
                    </div>
                    
                    <div>
                        <label class="block font-semibold mb-2">서식 본문 (A4 기준)</label>
                        <div class="mb-2 text-xs text-gray-600 bg-blue-50 p-2 rounded">
                            변수 사용법: {{직원명}}, {{부서}}, {{날짜}}, {{내용}}<br>
                            직원이 작성할 때 자동으로 채워지거나 입력할 수 있습니다.
                        </div>
                        <textarea id="templateContent" rows="15" 
                                  class="w-full p-3 border rounded font-mono text-sm" 
                                  placeholder="서식 내용을 입력하세요..."></textarea>
                    </div>
                    
                    <div class="flex items-center gap-4 text-sm">
                        <label class="flex items-center">
                            <input type="checkbox" id="requiresAttachment" class="mr-2">
                            파일 첨부 필수
                        </label>
                    </div>
                    
                    <div class="flex gap-2">
                        <button type="submit" class="flex-1 bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 font-bold">
                            저장하기
                        </button>
                        <button type="button" id="reset-form-btn" class="px-6 py-3 bg-gray-300 rounded-lg hover:bg-gray-400">
                            초기화
                        </button>
                    </div>
                </form>
            </div>
            
            <!-- 오른쪽: 미리보기 -->
            <div class="bg-gray-50 border rounded-lg p-6">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-xl font-bold">실시간 미리보기</h3>
                    <button id="preview-print-btn" 
                            class="text-sm px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700">
                        인쇄 미리보기
                    </button>
                </div>
                
                <div class="bg-white shadow-lg mx-auto overflow-auto" style="max-height: 600px;">
                    <div id="a4-preview" class="a4-document">
                        <div class="a4-content" id="preview-content">
                            <p class="text-gray-400 text-center py-8">왼쪽에서 서식을 작성하면 여기에 미리보기가 표시됩니다.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 저장된 서식 목록 -->
        <div class="mt-8 bg-white border rounded-lg p-6">
            <h3 class="text-xl font-bold mb-4">저장된 서식 목록</h3>
            <div id="templatesList" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div>
        </div>
    `;
}

export async function renderTemplatesManagement(container) {
    try {
        container.innerHTML = getManagementTemplatesHTML();
        
        const templateForm = _('#template-form');
        const templateContent = _('#templateContent');
        const templateName = _('#templateName');
        const printBtn = _('#preview-print-btn');
        const resetBtn = _('#reset-form-btn');
        
        if (templateForm) {
            templateForm.addEventListener('submit', handleSaveTemplate);
        }
        
        if (templateContent) {
            templateContent.addEventListener('input', updateLivePreview);
        }
        
        if (templateName) {
            templateName.addEventListener('input', updateLivePreview);
        }
        
        if (printBtn) {
            printBtn.addEventListener('click', handlePrintPreview);
        }
        
        if (resetBtn) {
            resetBtn.addEventListener('click', resetTemplateForm);
        }
        
        await renderTemplatesList();
        updateLivePreview();
        
    } catch (error) {
        console.error('renderTemplatesManagement 에러:', error);
        container.innerHTML = `<div class="p-4 text-red-600">
            <h3 class="font-bold mb-2">서식 관리 로딩 실패</h3>
            <p>${error.message}</p>
        </div>`;
    }
}

function updateLivePreview() {
    const content = _('#templateContent')?.value || '';
    const name = _('#templateName')?.value || '서식 제목';
    const previewEl = _('#preview-content');
    
    if (!previewEl) return;
    
    if (!content.trim()) {
        previewEl.innerHTML = '<p class="text-gray-400 text-center py-8">왼쪽에서 서식을 작성하면 여기에 미리보기가 표시됩니다.</p>';
        return;
    }
    
    let preview = content
        .replace(/{{(.*?)}}/g, '<span class="template-variable">{{$1}}</span>')
        .replace(/\n/g, '<br>');
    
    previewEl.innerHTML = `
        <div class="text-center mb-4">
            <h2 class="text-xl font-bold">${name}</h2>
        </div>
        ${preview}
    `;
}

async function renderTemplatesList() {
    const { templates } = state.management;
    const container = _('#templatesList');
    
    if (!container) return;
    
    if (!templates || templates.length === 0) {
        container.innerHTML = '<p class="text-gray-500 col-span-full text-center py-8">등록된 서식이 없습니다.</p>';
        return;
    }
    
    const cards = templates.map(template => {
        const name = template.template_name || '이름 없음';
        const description = template.template_fields?.description || '설명 없음';
        const requiresAttachment = template.requires_attachment ? '첨부 필수' : '';
        
        return `
        <div class="template-card bg-white border rounded-lg p-4 hover:shadow-md transition">
            <div class="flex justify-between items-start mb-2">
                <h4 class="font-bold text-lg">${name}</h4>
                <div class="flex gap-1">
                    <button onclick="window.editTemplate(${template.id})" 
                            class="text-green-600 hover:text-green-800 text-sm" title="수정">수정</button>
                    <button onclick="window.previewTemplate(${template.id})" 
                            class="text-blue-600 hover:text-blue-800 text-sm" title="미리보기">보기</button>
                    <button onclick="window.deleteTemplate(${template.id})" 
                            class="text-red-600 hover:text-red-800 text-sm" title="삭제">삭제</button>
                </div>
            </div>
            <p class="text-sm text-gray-600 mb-2 line-clamp-2">${description}</p>
            ${requiresAttachment ? `<div class="text-xs text-blue-600 mb-2">${requiresAttachment}</div>` : ''}
            <div class="text-xs text-gray-500">
                생성일: ${dayjs(template.created_at).format('YYYY-MM-DD')}
            </div>
        </div>
    `;
    }).join('');
    
    container.innerHTML = cards;
}

async function handleSaveTemplate(e) {
    e.preventDefault();
    
    const templateId = _('#template-id').value;
    const name = _('#templateName').value.trim();
    const description = _('#templateDescription').value.trim() || '';
    const content = _('#templateContent').value.trim();
    const requires_attachment = _('#requiresAttachment').checked;
    
    console.log('서식 저장 시도:', { templateId, name, description, content, requires_attachment });
    
    if (!name || !content) {
        alert('서식 이름과 본문은 필수입니다.');
        return;
    }
    
    try {
        const data = {
            template_name: name,
            template_fields: {
                description: description,
                content: content
            },
            requires_attachment: requires_attachment
        };
        
        console.log('저장할 데이터:', data);
        
        let result;
        
        if (templateId && templateId !== '') {
            // 수정
            result = await db.from('document_templates')
                .update(data)
                .eq('id', parseInt(templateId))
                .select();
            alert('서식이 수정되었습니다.');
        } else {
            // 신규 생성
            data.created_at = new Date().toISOString();
            result = await db.from('document_templates').insert(data).select();
            alert('서식이 저장되었습니다.');
        }
        
        if (result.error) throw result.error;
        
        resetTemplateForm();
        await window.loadAndRenderManagement();
    } catch (error) {
        console.error('서식 저장 실패:', error);
        alert('서식 저장에 실패했습니다: ' + error.message);
    }
}

window.editTemplate = function(templateId) {
    const template = state.management.templates.find(t => t.id === templateId);
    
    if (!template) {
        alert('서식을 찾을 수 없습니다.');
        return;
    }
    
    _('#template-id').value = template.id;
    _('#templateName').value = template.template_name || '';
    _('#templateDescription').value = template.template_fields?.description || '';
    _('#templateContent').value = template.template_fields?.content || '';
    _('#requiresAttachment').checked = template.requires_attachment || false;
    
    updateLivePreview();
    
    // 스크롤 이동
    _('#template-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function resetTemplateForm() {
    _('#template-form').reset();
    _('#template-id').value = '';
    updateLivePreview();
}

window.previewTemplate = function(templateId) {
    const template = state.management.templates.find(t => t.id === templateId);
    
    if (!template) {
        alert('서식을 찾을 수 없습니다.');
        return;
    }
    
    const templateContent = template.template_fields?.content || '';
    const templateName = template.template_name || '서식';
    
    if (!templateContent) {
        alert('서식 내용이 없습니다.');
        return;
    }
    
    const previewContent = templateContent
        .replace(/{{(.*?)}}/g, '<span class="template-variable">{{$1}}</span>')
        .replace(/\n/g, '<br>');
    
    const modalHTML = `
        <div class="modal-overlay" id="template-preview-modal">
            <div class="modal-content-lg" style="max-height: 90vh; overflow-y: auto;">
                <div class="flex justify-between items-center border-b pb-3 mb-4">
                    <h2 class="text-2xl font-bold">${templateName} 미리보기</h2>
                    <button id="close-preview-modal" class="text-3xl">&times;</button>
                </div>
                
                <div class="a4-document mx-auto">
                    <div class="a4-content">
                        <div class="text-center mb-4">
                            <h2 class="text-xl font-bold">${templateName}</h2>
                        </div>
                        ${previewContent}
                    </div>
                </div>
                
                <div class="flex justify-end pt-4 mt-4 border-t">
                    <button id="print-template-btn" class="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 mr-2">인쇄</button>
                    <button id="close-preview-btn" class="px-6 py-2 bg-gray-300 rounded hover:bg-gray-400">닫기</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    
    _('#close-preview-modal')?.addEventListener('click', () => {
        _('#template-preview-modal')?.remove();
    });
    _('#close-preview-btn')?.addEventListener('click', () => {
        _('#template-preview-modal')?.remove();
    });
    _('#print-template-btn')?.addEventListener('click', () => {
        printTemplateContent(templateName, previewContent);
    });
};

window.deleteTemplate = async function(templateId) {
    if (!confirm('이 서식을 삭제하시겠습니까?')) return;
    
    try {
        const { error } = await db.from('document_templates')
            .delete()
            .eq('id', templateId);
        
        if (error) throw error;
        
        alert('서식이 삭제되었습니다.');
        await window.loadAndRenderManagement();
    } catch (error) {
        console.error('서식 삭제 실패:', error);
        alert('서식 삭제에 실패했습니다: ' + error.message);
    }
};

function handlePrintPreview() {
    const content = _('#preview-content')?.innerHTML;
    const name = _('#templateName')?.value || '서식 미리보기';
    
    if (!content || content.includes('왼쪽에서 서식을')) {
        alert('미리보기할 내용이 없습니다.');
        return;
    }
    
    printTemplateContent(name, content);
}

function printTemplateContent(title, content) {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>${title}</title>
            <style>
                @page { 
                    size: A4; 
                    margin: 20mm; 
                }
                * { 
                    margin: 0; 
                    padding: 0; 
                    box-sizing: border-box; 
                }
                body { 
                    font-family: 'Malgun Gothic', 'Noto Sans KR', sans-serif;
                    background: white;
                    color: #000;
                }
                .a4-content { 
                    font-size: 12pt; 
                    line-height: 1.8; 
                    padding: 20mm;
                }
                .template-variable {
                    background-color: #dbeafe;
                    color: #1e40af;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-weight: 600;
                }
                h2 {
                    margin-bottom: 1em;
                }
                @media print {
                    body {
                        -webkit-print-color-adjust: exact;
                        print-color-adjust: exact;
                    }
                    .template-variable {
                        -webkit-print-color-adjust: exact;
                        print-color-adjust: exact;
                    }
                }
            </style>
        </head>
        <body>
            <div class="a4-content">${content}</div>
            <script>
                window.onload = function() {
                    setTimeout(() => {
                        window.print();
                        setTimeout(() => window.close(), 100);
                    }, 500);
                };
            </script>
        </body>
        </html>
    `);
    printWindow.document.close();
}