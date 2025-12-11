import { state, db } from './state.js';
import { _, show, hide, resizeGivenCanvas } from './utils.js';
import { getLeaveDetails } from './leave-utils.js';
import { renderScheduleManagement } from './schedule.js';
import { getLeaveListHTML } from './management.js';

// =========================================================================================
// 직원 포털 렌더링
// =========================================================================================

export async function renderEmployeePortal() {
    const portal = _('#employee-portal');
    const user = state.currentUser;

    if (!user) {
        portal.innerHTML = '<p class="text-red-600">사용자 정보를 불러올 수 없습니다.</p>';
        return;
    }

    let departmentName = '부서 미지정';

    if (user.department_id) {
        try {
            const { data: dept, error } = await db.from('departments')
                .select('*')
                .eq('id', user.department_id)
                .single();

            if (!error && dept) {
                departmentName = dept.name;
                user.departments = dept;
            }
        } catch (err) {
            console.error('부서 정보 로드 오류:', err);
        }
    } else if (user.dept) {
        departmentName = user.dept;
    } else if (user.departments?.name) {
        departmentName = user.departments.name;
    }

    const leaveDetails = getLeaveDetails(user);

    // ✅ isManager 필드 확인 (디버깅용 로그)
    console.log('👤 현재 사용자:', user.name, '/ isManager:', user.isManager);
    console.log('📅 연차 갱신일:', user.leave_renewal_date);
    console.log('👤 전체 사용자 정보:', user);

    // 갱신일 계산
    let renewalDateText = '미설정';
    let renewalDateShort = '미설정';
    if (user.leave_renewal_date) {
        // DB에 갱신일이 설정되어 있으면 그 날짜 사용
        const today = dayjs();
        const renewalThisYear = dayjs(user.leave_renewal_date).year(today.year());
        const nextRenewal = today.isAfter(renewalThisYear)
            ? renewalThisYear.add(1, 'year')
            : renewalThisYear;
        renewalDateText = nextRenewal.format('YYYY-MM-DD');
        renewalDateShort = nextRenewal.format('YY-MM-DD');
    } else if (user.entryDate) {
        // 갱신일이 없으면 입사일 기준으로 계산
        const today = dayjs();
        const entryAnniversaryThisYear = dayjs(user.entryDate).year(today.year());
        const nextAnniversary = today.isAfter(entryAnniversaryThisYear)
            ? entryAnniversaryThisYear.add(1, 'year')
            : entryAnniversaryThisYear;
        renewalDateText = nextAnniversary.format('YYYY-MM-DD');
        renewalDateShort = nextAnniversary.format('YY-MM-DD');
    }

    portal.innerHTML = `
        <div class="max-w-full mx-auto">
            <div class="flex justify-between items-center mb-6">
                <h1 class="text-3xl font-bold">${user.isManager ? '매니저 포털' : '직원 포털'}</h1>
                <div class="text-right">
                    <p class="text-gray-700 text-sm font-semibold">${user.name}님 (${departmentName})</p>
                    <div class="mt-1 flex gap-2 justify-end">
                        <button id="changePasswordBtn" class="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded transition-colors">비밀번호 변경</button>
                        <button id="employeeLogoutBtn" class="px-3 py-1 text-sm bg-gray-300 hover:bg-gray-400 rounded transition-colors">로그아웃</button>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-4 gap-2 sm:gap-4 mb-6">
                <div class="bg-blue-100 p-2 sm:p-4 rounded shadow">
                    <p class="text-[10px] sm:text-sm text-gray-700 whitespace-nowrap">확정 연차</p>
                    <p class="text-xl sm:text-2xl font-bold">${leaveDetails.final}일</p>
                </div>
                <div class="bg-green-100 p-2 sm:p-4 rounded shadow">
                    <p class="text-[10px] sm:text-sm text-gray-700 whitespace-nowrap">사용 연차</p>
                    <p class="text-xl sm:text-2xl font-bold" id="used-leaves">계산 중...</p>
                </div>
                <div class="bg-yellow-100 p-2 sm:p-4 rounded shadow">
                    <p class="text-[10px] sm:text-sm text-gray-700 whitespace-nowrap">잔여 연차</p>
                    <p class="text-xl sm:text-2xl font-bold" id="remaining-leaves">계산 중...</p>
                </div>
                <div class="bg-purple-100 p-2 sm:p-4 rounded shadow">
                    <p class="text-[10px] sm:text-sm text-gray-700 whitespace-nowrap">갱신일</p>
                    <p class="text-base sm:text-xl font-semibold whitespace-nowrap">${renewalDateShort || renewalDateText}</p>
                </div>
            </div>

            <!-- 탭 버튼 -->
            <div class="flex border-b mb-4">
                <button id="tab-leave-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-blue-600 text-blue-600">연차 신청</button>
                <button id="tab-docs-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700 relative">
                    서류 제출
                    <span id="doc-tab-badge" class="hidden absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">0</span>
                </button>
                ${user.isManager ? `
                    <button id="tab-leave-list-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700">연차 신청 목록</button>
                    <button id="tab-schedule-btn" class="employee-tab-btn px-6 py-3 font-semibold border-b-2 border-transparent text-gray-500 hover:text-gray-700">스케줄 관리</button>
                ` : ''}
            </div>

            <!-- 연차 신청 탭 -->
            <div id="employee-leave-tab" class="tab-content">
                <div id="employee-calendar-container" class="bg-white shadow rounded p-4 mb-6"></div>
                
                <div class="bg-white shadow rounded p-4">
                    <h2 class="text-xl font-bold mb-4">내 연차 신청 내역</h2>
                    <div id="my-leave-requests"></div>
                </div>
            </div>

            <!-- 서류 제출 탭 -->
            <div id="employee-docs-tab" class="tab-content hidden">
                <!-- 제출 요청 받은 서류 목록 -->
                <div class="bg-white shadow rounded p-4 mb-4">
                    <h2 class="text-xl font-bold mb-4">서류 제출 요청 <span class="text-sm text-gray-500">(관리자가 요청한 서류)</span></h2>
                    <div id="document-requests-list"></div>
                </div>
                
                <!-- 제출한 서류 목록 -->
                <div class="bg-white shadow rounded p-4">
                    <h2 class="text-xl font-bold mb-4">제출한 서류 <span class="text-sm text-gray-500">(내가 제출한 서류 현황)</span></h2>
                    <div id="submitted-docs-list"></div>
                </div>
            </div>

            ${user.isManager ? `
                <!-- 연차 신청 목록 탭 (매니저 전용) -->
                <div id="employee-leave-list-tab" class="tab-content hidden"></div>

                <!-- 스케줄 관리 탭 (매니저 전용) -->
                <div id="employee-schedule-tab" class="tab-content hidden"></div>
            ` : ''}
        </div>
    `;

    _('#employeeLogoutBtn').addEventListener('click', async () => {
        sessionStorage.clear();
        window.location.reload();
    });

    _('#changePasswordBtn')?.addEventListener('click', async () => {
        const currentPass = prompt("현재 비밀번호를 입력해주세요:");
        if (currentPass === null) return;

        if (currentPass !== state.currentUser.password) {
            alert("현재 비밀번호가 일치하지 않습니다.");
            return;
        }

        const newPass = prompt("새로운 비밀번호를 입력해주세요:");
        if (newPass === null) return;

        if (!newPass.trim()) {
            alert("비밀번호는 공백일 수 없습니다.");
            return;
        }

        const { error } = await db.from('employees').update({ password: newPass }).eq('id', state.currentUser.id);

        if (error) {
            alert("비밀번호 변경 실패: " + error.message);
        } else {
            alert("비밀번호가 변경되었습니다. 다시 로그인해주세요.");
            sessionStorage.clear();
            window.location.reload();
        }
    });

    _('#tab-leave-btn').addEventListener('click', () => switchEmployeeTab('leave'));
    _('#tab-docs-btn').addEventListener('click', () => switchEmployeeTab('docs'));

    if (user.isManager) {
        console.log('✅ 매니저 탭 이벤트 리스너 연결');
        _('#tab-leave-list-btn')?.addEventListener('click', () => switchEmployeeTab('leaveList'));
        _('#tab-schedule-btn')?.addEventListener('click', () => switchEmployeeTab('schedule'));
    }

    await loadEmployeeData();
}

function switchEmployeeTab(tab) {
    state.employee.activeTab = tab;

    const leaveBtn = _('#tab-leave-btn');
    const docsBtn = _('#tab-docs-btn');
    const leaveListBtn = _('#tab-leave-list-btn');
    const scheduleBtn = _('#tab-schedule-btn');
    const leaveTab = _('#employee-leave-tab');
    const docsTab = _('#employee-docs-tab');
    const leaveListTab = _('#employee-leave-list-tab');
    const scheduleTab = _('#employee-schedule-tab');

    // 모든 버튼 비활성화
    [leaveBtn, docsBtn, leaveListBtn, scheduleBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('border-blue-600', 'text-blue-600');
            btn.classList.add('border-transparent', 'text-gray-500');
        }
    });

    // 모든 탭 숨김
    [leaveTab, docsTab, leaveListTab, scheduleTab].forEach(t => {
        if (t) t.classList.add('hidden');
    });

    // 선택된 탭만 활성화
    if (tab === 'leave' && leaveBtn && leaveTab) {
        leaveBtn.classList.add('border-blue-600', 'text-blue-600');
        leaveBtn.classList.remove('border-transparent', 'text-gray-500');
        leaveTab.classList.remove('hidden');
    } else if (tab === 'docs' && docsBtn && docsTab) {
        docsBtn.classList.add('border-blue-600', 'text-blue-600');
        docsBtn.classList.remove('border-transparent', 'text-gray-500');
        docsTab.classList.remove('hidden');
    } else if (tab === 'leaveList' && leaveListBtn && leaveListTab) {
        leaveListBtn.classList.add('border-blue-600', 'text-blue-600');
        leaveListBtn.classList.remove('border-transparent', 'text-gray-500');
        leaveListTab.classList.remove('hidden');
        renderManagerLeaveList();
    } else if (tab === 'schedule' && scheduleBtn && scheduleTab) {
        scheduleBtn.classList.add('border-blue-600', 'text-blue-600');
        scheduleBtn.classList.remove('border-transparent', 'text-gray-500');
        scheduleTab.classList.remove('hidden');
        renderManagerScheduleTab();
    }
}

// ✨ 매니저용 연차 신청 목록 (관리자 화면 그대로 사용)
async function renderManagerLeaveList() {
    const container = _('#employee-leave-list-tab');
    if (!container) return;

    // state.management 초기화 (없으면)
    if (!state.management) {
        state.management = {
            leaveRequests: [],
            employees: [],
            departments: []
        };
    }

    // 데이터 로드
    try {
        const [requestsRes, employeesRes] = await Promise.all([
            db.from('leave_requests').select('*').order('created_at', { ascending: false }),
            db.from('employees').select('*, departments(*)').order('id')
        ]);

        if (requestsRes.error) throw requestsRes.error;
        if (employeesRes.error) throw employeesRes.error;

        state.management.leaveRequests = requestsRes.data || [];
        state.management.employees = employeesRes.data || [];

        // 관리자 모드와 동일하게 getLeaveListHTML()만 사용 (이 안에 달력 포함됨)
        container.innerHTML = getLeaveListHTML();

        // 📅 달력 렌더링 (DOM에 추가된 후 실행)
        setTimeout(() => {
            if (typeof window.renderLeaveCalendar === 'function') {
                // 명시적으로 현재 탭 내의 컨테이너를 지정
                window.renderLeaveCalendar('#employee-leave-list-tab #leave-calendar-container');
            } else {
                console.error('window.renderLeaveCalendar 함수가 정의되지 않았습니다.');
                alert('달력 기능을 불러올 수 없습니다. 새로고침을 해주세요.');
            }
        }, 100);

    } catch (error) {
        console.error('연차 목록 로드 오류:', error);
        container.innerHTML = '<div class="p-4 text-red-600">데이터를 불러오는데 실패했습니다: ' + error.message + '</div>';
    }
}

// ✨ 매니저용 스케줄 관리 (관리자 화면 그대로 사용)
async function renderManagerScheduleTab() {
    const container = _('#employee-schedule-tab');
    if (!container) return;

    // state.management와 state.schedule 초기화
    if (!state.management) {
        state.management = {
            leaveRequests: [],
            employees: [],
            departments: []
        };
    }

    if (!state.schedule) {
        state.schedule = {
            currentDate: dayjs().format('YYYY-MM-DD'),
            viewMode: 'working',
            teamLayout: { month: '', data: [] },
            schedules: [],
            activeDepartmentFilters: new Set(),
            companyHolidays: new Set(),
            activeReorder: { date: null, sortable: null },
            sortableInstances: []
        };
    }

    // 데이터 로드
    try {
        const [requestsRes, employeesRes, departmentsRes] = await Promise.all([
            db.from('leave_requests').select('*').order('created_at', { ascending: false }),
            db.from('employees').select('*, departments(*)').order('id'),
            db.from('departments').select('*').order('id')
        ]);

        if (requestsRes.error) throw requestsRes.error;
        if (employeesRes.error) throw employeesRes.error;
        if (departmentsRes.error) throw departmentsRes.error;

        state.management.leaveRequests = requestsRes.data || [];
        state.management.employees = employeesRes.data || [];
        state.management.departments = departmentsRes.data || [];

        // 관리자 스케줄 관리 화면 그대로 렌더링
        await renderScheduleManagement(container);

    } catch (error) {
        console.error('스케줄 로드 오류:', error);
        container.innerHTML = '<div class="p-4 text-red-600">데이터를 불러오는데 실패했습니다: ' + error.message + '</div>';
    }
}

async function loadEmployeeData() {
    try {
        const userId = state.currentUser.id;

        const [requestsRes, docRequestsRes, submittedDocsRes] = await Promise.all([
            db.from('leave_requests').select('*').eq('employee_id', userId).order('created_at', { ascending: false }),
            db.from('document_requests').select('*').eq('employeeId', userId).order('created_at', { ascending: false }),
            db.from('submitted_documents').select('*').eq('employee_id', userId).order('created_at', { ascending: false })
        ]);

        if (requestsRes.error) throw requestsRes.error;

        const requests = requestsRes.data || [];
        state.employee.documentRequests = docRequestsRes.data || [];
        state.employee.submittedDocuments = submittedDocsRes.data || [];

        const approved = requests.filter(r => r.status === 'approved');
        const usedDays = approved.reduce((sum, r) => sum + (r.dates?.length || 0), 0);
        const leaveDetails = getLeaveDetails(state.currentUser);

        _('#used-leaves').textContent = `${usedDays}일`;
        _('#remaining-leaves').textContent = `${leaveDetails.final - usedDays}일`;

        renderMyLeaveRequests(requests);
        initializeEmployeeCalendar(approved);
        renderDocumentRequests();
        renderSubmittedDocuments();

        // 배지 업데이트
        updateDocumentBadge();

        // 알림 표시 (미제출 서류가 있을 때)
        const pendingCount = state.employee.documentRequests.filter(req => req.status === 'pending').length;
        if (pendingCount > 0) {
            setTimeout(() => {
                alert(`미제출 서류가 ${pendingCount}건 있습니다!\n\n"서류 제출" 탭에서 확인해주세요.\n\n※ 서류를 제출하지 않으면 연차 신청이 불가능합니다.`);
            }, 500);
        }
    } catch (error) {
        console.error('직원 데이터 로딩 오류:', error);
        alert('데이터를 불러오는 중 오류가 발생했습니다: ' + error.message);
    }
}

function updateDocumentBadge() {
    const pendingCount = state.employee.documentRequests.filter(req => req.status === 'pending').length;
    const tabBadge = _('#doc-tab-badge');

    // 탭 버튼 배지만 업데이트
    if (tabBadge) {
        if (pendingCount > 0) {
            tabBadge.textContent = pendingCount;
            tabBadge.classList.remove('hidden');
        } else {
            tabBadge.classList.add('hidden');
        }
    }
}

// =========================================================================================
// 서류 요청 목록 렌더링 - 상태별 분류 개선
// =========================================================================================

function renderDocumentRequests() {
    const container = _('#document-requests-list');
    if (!container) return;

    const requests = state.employee.documentRequests;

    if (requests.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">서류 제출 요청이 없습니다.</p>';
        return;
    }

    // pending 상태인 요청만 표시 (아직 제출하지 않은 요청)
    const pendingRequests = requests.filter(req => req.status === 'pending');

    if (pendingRequests.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">대기 중인 서류 요청이 없습니다. 모든 요청이 처리되었습니다.</p>';
        return;
    }

    const rows = pendingRequests.map(req => {
        let statusBadge = '<span class="bg-yellow-200 text-yellow-800 text-xs font-medium px-2.5 py-0.5 rounded-full">제출 대기</span>';
        let actionButton = `<button onclick="window.openDocSubmissionModal(${req.id})" class="text-sm bg-blue-600 text-white px-4 py-1 rounded hover:bg-blue-700 font-bold">작성하기</button>`;

        const docType = req.type || '일반 서류';

        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-3">${docType}</td>
                <td class="p-3 text-sm text-gray-600">${req.message || '-'}</td>
                <td class="p-3">${dayjs(req.created_at).format('YYYY-MM-DD')}</td>
                <td class="p-3">${statusBadge}</td>
                <td class="p-3 text-center">${actionButton}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left text-xs">서류 유형</th>
                    <th class="p-3 text-left text-xs">요청 사유</th>
                    <th class="p-3 text-left text-xs">요청일</th>
                    <th class="p-3 text-left text-xs">상태</th>
                    <th class="p-3 text-center text-xs">관리</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function renderSubmittedDocuments() {
    const container = _('#submitted-docs-list');
    if (!container) return;

    const docs = state.employee.submittedDocuments;

    if (docs.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-4">제출한 서류가 없습니다.</p>';
        return;
    }

    // 제출된 모든 서류 표시 (submitted, approved, rejected)
    const rows = docs.map(doc => {
        let statusBadge = '';

        switch (doc.status) {
            case 'submitted':
                statusBadge = '<span class="bg-yellow-200 text-yellow-800 text-xs font-medium px-2.5 py-0.5 rounded-full">검토 대기</span>';
                break;
            case 'approved':
                statusBadge = '<span class="bg-green-200 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded-full">승인됨</span>';
                break;
            case 'rejected':
                statusBadge = '<span class="bg-red-200 text-red-800 text-xs font-medium px-2.5 py-0.5 rounded-full">반려됨</span>';
                break;
        }

        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-3">${doc.template_name || '일반 서류'}</td>
                <td class="p-3">${dayjs(doc.created_at).format('YYYY-MM-DD HH:mm')}</td>
                <td class="p-3">${statusBadge}</td>
                <td class="p-3 text-center">
                    <button onclick="window.viewSubmittedDocument(${doc.id})" class="text-sm bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600">내용 보기</button>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
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
// 서류 작성 모달 - 파일 첨부 기능 추가
// =========================================================================================

window.openDocSubmissionModal = async function (requestId) {
    const request = state.employee.documentRequests.find(req => req.id === requestId);
    if (!request) {
        alert('요청을 찾을 수 없습니다.');
        return;
    }

    state.docSubmission.currentRequestId = requestId;

    const today = dayjs().format('YYYY년 MM월 DD일');

    // 해당 서류 유형이 파일 첨부 필수인지 확인
    const isAttachmentRequired = await checkIfAttachmentRequired(request.type);

    const modalHTML = `
        <div id="temp-doc-submission-modal" class="modal-overlay">
            <div class="modal-content-lg" style="max-height: 90vh; overflow-y: auto;">
                <div class="flex justify-between items-center border-b pb-3 mb-4 sticky top-0 bg-white z-10">
                    <h2 class="text-2xl font-bold">${request.type || '서류'} 제출</h2>
                    <button id="close-temp-doc-modal" class="text-3xl">&times;</button>
                </div>
                
                <!-- 공문서 형식 -->
                <div class="bg-white border-2 border-gray-800 p-6" style="min-height: auto;">
                    <div class="text-center mb-6">
                        <h1 class="text-2xl font-bold mb-2">${request.type || '서류'}</h1>
                        <div class="text-xs text-gray-600">문서번호: DOC-${requestId}-${dayjs().format('YYYYMMDD')}</div>
                    </div>
                    
                    <!-- 기본 정보 테이블 -->
                    <table class="w-full mb-4 border border-gray-800 text-sm" style="border-collapse: collapse;">
                        <tr>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold" style="width: 100px;">제출자</td>
                            <td class="border border-gray-800 px-3 py-2">${state.currentUser.name}</td>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold" style="width: 100px;">소속</td>
                            <td class="border border-gray-800 px-3 py-2">${state.currentUser.departments?.name || '부서 미지정'}</td>
                        </tr>
                        <tr>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold">제출일</td>
                            <td class="border border-gray-800 px-3 py-2" colspan="3">${today}</td>
                        </tr>
                        <tr>
                            <td class="border border-gray-800 bg-gray-100 px-3 py-2 font-bold">사유</td>
                            <td class="border border-gray-800 px-3 py-2" colspan="3">${request.message || '-'}</td>
                        </tr>
                    </table>
                    
                    <!-- 파일 첨부 영역 (필수인 경우만) -->
                    ${isAttachmentRequired ? `
                    <div class="mb-4">
                        <div class="font-bold mb-2 text-red-600">🔎 파일 첨부 (필수)</div>
                        <input type="file" id="doc-attachment" class="w-full p-2 border-2 border-red-300 rounded" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" required>
                        <div class="text-xs text-gray-600 mt-1">지원 형식: PDF, DOC, DOCX, JPG, PNG (최대 10MB)</div>
                    </div>
                    ` : ''}
                    
                    <!-- 내용 -->
                    <div class="mb-4">
                        <div class="font-bold mb-2">내용</div>
                        <textarea id="doc-content" rows="8" class="w-full p-3 border-2 border-gray-800 text-sm" style="resize: none; line-height: 1.6;" placeholder="서류 내용을 작성하세요...

예시:
본인은 ${request.message || '해당 사유'}에 대하여 다음과 같이 보고드립니다.

1. 
2. 
3. 

이상과 같이 보고드리오니 검토 부탁드립니다."></textarea>
                    </div>
                    
                    <!-- 서명란 -->
                    <div class="flex justify-end items-end mb-4">
                        <div class="text-right">
                            <div class="mb-2 font-bold text-sm">제출자 서명</div>
                            <div class="border-2 border-gray-800 bg-gray-50" style="width: 180px; height: 90px; position: relative;">
                                <canvas id="doc-signature-canvas" width="180" height="90" style="cursor: crosshair;"></canvas>
                                <button type="button" id="clear-doc-signature" class="absolute top-1 right-1 text-xs bg-white border px-2 py-0.5 rounded hover:bg-gray-100">지우기</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="text-center text-xs text-gray-600">
                        위와 같이 서류를 제출합니다.
                    </div>
                </div>
                
                <div class="flex justify-end space-x-3 pt-4 mt-4 border-t sticky bottom-0 bg-white">
                    <button id="cancel-temp-doc-btn" class="px-6 py-2 bg-gray-300 rounded hover:bg-gray-400">취소</button>
                    <button id="submit-temp-doc-btn" class="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-bold">제출하기</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // 서명 패드 초기화
    const canvas = document.getElementById('doc-signature-canvas');
    window.docSignaturePad = new SignaturePad(canvas, {
        backgroundColor: 'rgb(249, 250, 251)',
        penColor: 'rgb(0, 0, 0)'
    });

    document.getElementById('clear-doc-signature').addEventListener('click', () => {
        window.docSignaturePad.clear();
    });

    document.getElementById('close-temp-doc-modal').addEventListener('click', closeDocSubmissionModal);
    document.getElementById('cancel-temp-doc-btn').addEventListener('click', closeDocSubmissionModal);
    document.getElementById('submit-temp-doc-btn').addEventListener('click', handleDocumentSubmit);
};

// 서류 유형이 파일 첨부 필수인지 확인하는 함수
async function checkIfAttachmentRequired(docType) {
    try {
        const { data: templates, error } = await db.from('document_templates')
            .select('requires_attachment')
            .eq('template_name', docType)
            .single();

        if (error || !templates) return false;
        return templates.requires_attachment || false;
    } catch (error) {
        console.error('서식 정보 확인 실패:', error);
        return false;
    }
}

function closeDocSubmissionModal() {
    const modal = _('#temp-doc-submission-modal');
    if (modal) modal.remove();
    state.docSubmission.currentRequestId = null;
}

async function handleDocumentSubmit() {
    const content = _('#doc-content')?.value.trim();
    const requestId = state.docSubmission.currentRequestId;
    const attachmentInput = _('#doc-attachment');

    if (!content) {
        alert('서류 내용을 작성해주세요.');
        return;
    }

    if (!window.docSignaturePad || window.docSignaturePad.isEmpty()) {
        alert('서명을 해주세요.');
        return;
    }

    // 파일 첨부 필수인 경우 검증
    if (attachmentInput && attachmentInput.hasAttribute('required') && !attachmentInput.files[0]) {
        alert('파일 첨부가 필수입니다.');
        return;
    }

    const request = state.employee.documentRequests.find(req => req.id === requestId);
    if (!request) {
        alert('요청 정보를 찾을 수 없습니다.');
        return;
    }

    const signatureData = window.docSignaturePad.toDataURL();

    // 제출 버튼 비활성화
    const submitBtn = _('#submit-temp-doc-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '제출 중...';
    }

    try {
        let attachmentUrl = null;

        // 파일 업로드 처리 (파일이 있는 경우)
        if (attachmentInput && attachmentInput.files[0]) {
            const file = attachmentInput.files[0];

            // 파일 크기 검증 (10MB)
            if (file.size > 10 * 1024 * 1024) {
                alert('파일 크기는 10MB 이하여야 합니다.');
                return;
            }

            // Supabase Storage에 파일 업로드
            const fileName = `${state.currentUser.id}_${Date.now()}_${file.name}`;
            const { data: uploadData, error: uploadError } = await db.storage
                .from('document-attachments')
                .upload(fileName, file);

            if (uploadError) {
                console.error('파일 업로드 실패:', uploadError);
                alert('파일 업로드에 실패했습니다. 다시 시도해주세요.');
                return;
            }

            // 업로드된 파일의 공개 URL 생성
            const { data: urlData } = db.storage
                .from('document-attachments')
                .getPublicUrl(fileName);

            attachmentUrl = urlData.publicUrl;
        }

        console.log('서류 제출 시도:', {
            employee_id: state.currentUser.id,
            employee_name: state.currentUser.name,
            template_name: request.type || '일반 서류',
            related_issue_id: requestId
        });

        // Supabase JS SDK 사용
        const { data, error } = await db
            .from('submitted_documents')
            .insert({
                employee_id: state.currentUser.id,
                employee_name: state.currentUser.name,
                template_name: request.type || '일반 서류',
                submission_data: { text: content },
                signature: signatureData,
                attachment_url: attachmentUrl,
                status: 'submitted',
                related_issue_id: requestId
            })
            .select();

        if (error) {
            console.error('Supabase 오류:', error);
            throw new Error(`${error.message}\n\n⚠️ Supabase SQL 편집기에서 다음 명령을 실행해주세요:\n\nALTER TABLE submitted_documents DISABLE ROW LEVEL SECURITY;`);
        }

        console.log('서류 제출 성공:', data);

        // document_requests 상태 업데이트 (pending → submitted로 변경)
        const { error: updateError } = await db
            .from('document_requests')
            .update({ status: 'submitted' })
            .eq('id', requestId);

        if (updateError) {
            console.error('상태 업데이트 실패:', updateError);
        }

        alert('서류가 제출되었습니다.');
        closeDocSubmissionModal();
        await loadEmployeeData();
    } catch (error) {
        console.error('서류 제출 실패:', error);

        // 사용자 친화적인 오류 메시지
        let userMessage = '서류 제출에 실패했습니다.\n\n';

        if (error.message.includes('row-level security')) {
            userMessage += '관리자에게 다음 조치를 요청하세요:\n\n';
            userMessage += '1. Supabase 대시보드 접속\n';
            userMessage += '2. SQL Editor 열기\n';
            userMessage += '3. 다음 명령 실행:\n\n';
            userMessage += 'ALTER TABLE submitted_documents DISABLE ROW LEVEL SECURITY;\n';
            userMessage += 'ALTER TABLE document_requests DISABLE ROW LEVEL SECURITY;';
        } else {
            userMessage += '오류 내용: ' + error.message;
        }

        alert(userMessage);

        // 버튼 복구
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '제출하기';
        }
    }
}

// 제출한 서류 보기 함수
window.viewSubmittedDocument = function (docId) {
    const doc = state.employee.submittedDocuments.find(d => d.id === docId);
    if (!doc) {
        alert('서류를 찾을 수 없습니다.');
        return;
    }

    const content = doc.submission_data?.text || doc.text || '내용 없음';
    const attachmentHtml = doc.attachment_url ?
        `<div class="mb-4"><strong>첨부파일:</strong> <a href="${doc.attachment_url}" target="_blank" class="text-blue-600 hover:underline">파일 보기</a></div>` : '';

    const modalHTML = `
        <div class="modal-overlay" id="view-submitted-doc-modal">
            <div class="modal-content-lg" style="max-height: 90vh; overflow-y: auto;">
                <div class="flex justify-between items-center border-b pb-3 mb-4">
                    <h2 class="text-2xl font-bold">${doc.template_name || '서류'} 내용</h2>
                    <button id="close-view-submitted-doc-modal" class="text-3xl">&times;</button>
                </div>
                <div class="bg-white border-2 border-gray-800 p-6">
                    <div class="text-center mb-6">
                        <h1 class="text-2xl font-bold mb-2">${doc.template_name || '서류'}</h1>
                        <div class="text-xs text-gray-600">제출자: ${doc.employee_name}</div>
                        <div class="text-xs text-gray-600">제출일시: ${dayjs(doc.created_at).format('YYYY-MM-DD HH:mm')}</div>
                        <div class="text-xs text-gray-600">상태: 
                            ${doc.status === 'submitted' ? '검토 대기' :
            doc.status === 'approved' ? '승인됨' :
                doc.status === 'rejected' ? '반려됨' : doc.status}
                        </div>
                    </div>
                    ${attachmentHtml}
                    <div class="mb-4 whitespace-pre-wrap border p-4 rounded" style="line-height: 1.8;">${content}</div>
                    ${doc.signature ? `<div class="text-right"><img src="${doc.signature}" alt="서명" class="inline-block border-2 border-gray-800" style="width: 180px; height: 90px;"></div>` : ''}
                </div>
                <div class="flex justify-end pt-4 mt-4 border-t">
                    <button id="close-view-submitted-doc-btn" class="px-6 py-2 bg-gray-300 rounded hover:bg-gray-400">닫기</button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    _('#close-view-submitted-doc-modal')?.addEventListener('click', () => {
        _('#view-submitted-doc-modal')?.remove();
    });
    _('#close-view-submitted-doc-btn')?.addEventListener('click', () => {
        _('#view-submitted-doc-modal')?.remove();
    });
};

// =========================================================================================
// 연차 신청 관련
// =========================================================================================

function renderMyLeaveRequests(requests) {
    const container = _('#my-leave-requests');

    if (requests.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-4">신청 내역이 없습니다.</p>';
        return;
    }

    const statusBadges = {
        pending: '<span class="bg-yellow-200 text-yellow-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">대기중</span>',
        approved: '<span class="bg-green-200 text-green-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">승인됨</span>',
        rejected: '<span class="bg-red-200 text-red-800 text-xs px-2 py-1 rounded-full whitespace-nowrap">반려됨</span>'
    };

    const rows = requests.map(req => {
        // 날짜 간소화 로직
        const dates = req.dates || [];
        let dateDisplay = '';

        if (dates.length > 0) {
            const firstDate = dayjs(dates[0]);
            const parts = [firstDate.format('YYYY-MM-DD')];

            for (let i = 1; i < dates.length; i++) {
                const currentDate = dayjs(dates[i]);
                const prevDate = dayjs(dates[i - 1]);

                if (currentDate.year() === prevDate.year() && currentDate.month() === prevDate.month()) {
                    parts.push(currentDate.format('DD'));
                } else if (currentDate.year() === prevDate.year()) {
                    parts.push(currentDate.format('MM-DD'));
                } else {
                    parts.push(currentDate.format('YYYY-MM-DD'));
                }
            }

            dateDisplay = parts.join(', ');
        }

        return `
            <tr class="border-b">
                <td class="p-3">${dateDisplay}</td>
                <td class="p-3">${dayjs(req.created_at).format('YYYY-MM-DD')}</td>
                <td class="p-3">${statusBadges[req.status] || req.status}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="min-w-full text-sm">
            <thead class="bg-gray-50">
                <tr>
                    <th class="p-3 text-left">신청 날짜</th>
                    <th class="p-3 text-left">신청 일시</th>
                    <th class="p-3 text-left">상태</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

let selectedDatesForLeave = [];
let employeeCalendarInstance = null;

// ⚡ 수정: 달력 초기화 함수 개선 (에러 핸들링 강화 + 이벤트 리스너 연결 개선)
function initializeEmployeeCalendar(approvedRequests) {
    console.log('📅 달력 초기화 시작');
    const container = _('#employee-calendar-container');

    if (!container) {
        console.error('❌ 달력 컨테이너를 찾을 수 없습니다');
        return;
    }

    // 기존 인스턴스 제거
    if (employeeCalendarInstance) {
        try {
            employeeCalendarInstance.destroy();
        } catch (e) {
            console.log('기존 달력 제거 중 에러:', e);
        }
        employeeCalendarInstance = null;
    }

    const approvedDates = approvedRequests.flatMap(r => r.dates || []);
    console.log('✅ 승인된 날짜:', approvedDates);

    // 선택 날짜 초기화
    selectedDatesForLeave.length = 0;

    // ⚡ 수정: 컨테이너 완전히 초기화
    container.innerHTML = '';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'flex justify-between items-center mb-4';
    buttonContainer.innerHTML = `
        <h2 class="text-xl font-bold">연차 신청 달력 <span class="text-sm text-gray-500">(날짜를 클릭하여 선택/해제)</span></h2>
        <div class="flex gap-2">
            <span id="selected-dates-count" class="text-sm text-gray-600 self-center">선택된 날짜: 0일</span>
            <button id="clear-selection-btn" class="px-3 py-1 text-sm bg-gray-300 rounded hover:bg-gray-400">선택 취소</button>
            <button id="submit-leave-request-btn" class="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 font-bold">연차 신청하기</button>
        </div>
    `;

    const calendarEl = document.createElement('div');
    calendarEl.id = 'employee-calendar';

    container.appendChild(buttonContainer);
    container.appendChild(calendarEl);

    console.log('✅ 버튼 컨테이너 추가 완료');

    if (typeof FullCalendar === 'undefined') {
        console.error('❌ FullCalendar가 로드되지 않았습니다!');
        alert('달력 라이브러리가 로드되지 않았습니다. 페이지를 새로고침해주세요.');
        return;
    }

    employeeCalendarInstance = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        headerToolbar: {
            left: 'today',
            center: 'prev title next',
            right: ''
        },
        // 전체 달력이 세로 스크롤 없이 보이도록 자동 높이 설정
        height: 'auto',
        locale: 'ko',
        selectable: false,  // ✅ select 기능 비활성화
        selectMirror: false,
        unselectAuto: false,
        editable: false,
        events: function (info, successCallback) {
            const events = [
                ...approvedDates.map(date => ({
                    title: '연차 (승인됨)',
                    start: date,
                    allDay: true,
                    color: '#10b981',
                    textColor: '#ffffff',
                    classNames: ['approved-leave']
                })),
                ...selectedDatesForLeave.map(date => ({
                    title: '선택됨',
                    start: date,
                    allDay: true,
                    color: '#3b82f6',
                    textColor: '#ffffff',
                    classNames: ['selected-date']
                }))
            ];
            successCallback(events);
        },
        dateClick: function (info) {
            console.log('📅 날짜 클릭:', info.dateStr);
            const dateStr = info.dateStr;

            if (approvedDates.includes(dateStr)) {
                alert('이미 승인된 연차가 있는 날짜입니다.');
                return;
            }

            const index = selectedDatesForLeave.indexOf(dateStr);
            if (index > -1) {
                selectedDatesForLeave.splice(index, 1);
                console.log('❌ 날짜 선택 해제:', dateStr);
            } else {
                selectedDatesForLeave.push(dateStr);
                console.log('✅ 날짜 선택 추가:', dateStr);
            }

            console.log('📋 현재 선택된 날짜:', selectedDatesForLeave);
            updateSelectionUI();
            employeeCalendarInstance.refetchEvents();
        }
    });

    // UI 업데이트 함수를 전역 스코프로 이동
    function updateSelectionUI() {
        const count = selectedDatesForLeave.length;
        const countEl = _('#selected-dates-count');

        // ✅ 선택된 날짜 개수만 업데이트 (버튼은 항상 표시)
        if (countEl) countEl.textContent = `선택된 날짜: ${count}일`;

        console.log('📊 선택된 날짜 개수:', count);
    }

    console.log('📅 달력 렌더링 시작');
    employeeCalendarInstance.render();
    console.log('✅ 달력 렌더링 완료');

    updateSelectionUI();

    // ⚡ 수정: 이벤트 리스너를 즉시 연결
    const clearBtn = _('#clear-selection-btn');
    const submitBtn = _('#submit-leave-request-btn');

    if (clearBtn) {
        clearBtn.onclick = () => {
            console.log('🗑️ 선택 취소 클릭');
            selectedDatesForLeave.length = 0;
            updateSelectionUI();
            employeeCalendarInstance.refetchEvents();
            employeeCalendarInstance.unselect();
        };
        console.log('✅ 선택 취소 버튼 이벤트 연결 완료');
    } else {
        console.error('❌ 선택 취소 버튼을 찾을 수 없음');
    }

    if (submitBtn) {
        submitBtn.onclick = () => {
            console.log('📝 연차 신청 버튼 클릭, 선택된 날짜:', selectedDatesForLeave);
            if (selectedDatesForLeave.length === 0) {
                alert('날짜를 선택해주세요.');
                return;
            }
            openLeaveFormModal([...selectedDatesForLeave]);
        };
        console.log('✅ 연차 신청 버튼 이벤트 연결 완료');
    } else {
        console.error('❌ 연차 신청 버튼을 찾을 수 없음');
    }

    console.log('✅ 달력 초기화 완료');
}

function openLeaveFormModal(dates) {
    _('#form-applicant-name').textContent = state.currentUser.name;
    _('#form-selected-dates').innerHTML = dates.sort().map(d =>
        `<span class="inline-block bg-blue-100 text-blue-800 px-2 py-1 rounded mr-2 mb-2">${d}</span>`
    ).join('');
    _('#form-reason').value = '';

    const canvas = _('#signature-canvas');
    if (canvas) {
        resizeGivenCanvas(canvas, window.signaturePad);
        if (!window.signaturePad) {
            window.signaturePad = new SignaturePad(canvas);
        }
        window.signaturePad.clear();
    }

    state.employee.selectedDates = dates;
    show('#leave-form-modal');
}

// ✅ window 객체에 등록하여 전역 접근 가능하게 설정
window.openLeaveFormModal = openLeaveFormModal;

export function closeLeaveFormModal() {
    hide('#leave-form-modal');
    state.employee.selectedDates = [];
}

export async function handleSubmitLeaveRequest() {
    const dates = state.employee.selectedDates;
    const reason = _('#form-reason').value.trim();
    const signatureData = window.signaturePad?.toDataURL();

    if (!dates || dates.length === 0) {
        alert('날짜를 선택해주세요.');
        return;
    }

    if (!signatureData || window.signaturePad.isEmpty()) {
        alert('서명을 해주세요.');
        return;
    }

    // 미제출 서류 확인 (document_requests 테이블 사용)
    const { data: pendingRequests, error: checkError } = await db.from('document_requests')
        .select('*')
        .eq('employeeId', state.currentUser.id)
        .eq('status', 'pending');

    if (checkError) {
        console.error('서류 확인 오류:', checkError);
    }

    if (pendingRequests && pendingRequests.length > 0) {
        alert('⚠️ 미제출 서류가 있습니다.\n\n서류를 먼저 제출해야 연차 신청이 가능합니다.\n\n"서류 제출" 탭에서 요청된 서류를 확인해주세요.');
        return;
    }

    try {
        const { error } = await db.from('leave_requests').insert({
            employee_id: state.currentUser.id,
            employee_name: state.currentUser.name,
            dates: dates,
            reason: reason || null,
            signature: signatureData,
            status: 'pending',
            created_at: new Date().toISOString()
        });

        if (error) throw error;

        alert('연차 신청이 완료되었습니다.');
        closeLeaveFormModal();


        renderEmployeePortal();

        // ✅ 포털 재렌더링 후 선택 초기화
        selectedDatesForLeave.length = 0;
    } catch (error) {
        console.error('연차 신청 오류:', error);
        alert('연차 신청 중 오류가 발생했습니다: ' + error.message);
    }
}