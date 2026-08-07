// 복지 미션 게시판 — 직원 작성 화면 + 관리자 열람 화면
//   · 직원  : 진료비 복지 탭 > [📸 복지 미션] 하위 탭. 본인 월별 미션 현황 + 본인 글만 작성/수정/삭제
//   · 관리자: 복지 탭 > [📸 미션 게시판] 하위 탭. 전체 글 열람 + 삭제
// 사진은 docs 버킷(비공개) → 표시는 signed URL. 이행체크 첨부와 동일 패턴.
import { state, db, isTestEmployee } from './state.js?v=20260703b';
import {
    loadWelfarePosts, createWelfarePost, updateWelfarePost, deleteWelfarePost,
    uploadPostPhoto, removeDocsFile, compressImage, currentYearMonth,
} from './welfare.js?v=20260807a';

// 작성 가능한 월 목록 — 지난 11개월 ~ 다음 달 (8월에 7월분·9월분 모두 입력 가능).
// 기본 선택은 항상 이번 달.
function monthOptions() {
    const out = [];
    const base = dayjs().startOf('month');
    for (let i = 11; i >= -1; i--) out.push(base.subtract(i, 'month').format('YYYY-MM'));
    return out;
}

function monthLabel(ym) {
    if (!ym) return '-';
    const [y, m] = ym.split('-');
    return `${y}년 ${Number(m)}월`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 여러 경로 → { path: signedUrl } 맵 (한 번의 요청으로 일괄 발급).
async function signedUrlMap(paths) {
    const list = [...new Set((paths || []).filter(Boolean))];
    if (!list.length) return {};
    const { data, error } = await db.storage.from('docs').createSignedUrls(list, 60 * 60);
    if (error) { console.warn('[board] signed URL 발급 실패:', error.message); return {}; }
    const map = {};
    (data || []).forEach(d => { if (d.signedUrl && !d.error) map[d.path] = d.signedUrl; });
    return map;
}

function photoGridHTML(photos, urlMap) {
    const paths = Array.isArray(photos) ? photos : [];
    if (!paths.length) return '';
    return `<div class="flex gap-2 flex-wrap mt-2">
        ${paths.map(p => urlMap[p]
            ? `<img src="${urlMap[p]}" data-url="${urlMap[p]}" class="wb-photo w-20 h-20 object-cover rounded border cursor-pointer" title="클릭하면 원본 보기">`
            : '').join('')}
    </div>`;
}

function bindPhotoOpen(host) {
    host.querySelectorAll('.wb-photo').forEach(im => {
        im.onclick = () => window.open(im.dataset.url, '_blank');
    });
}

// 직원 본인의 월별 미션 현황 — 관리자 이행 인정 여부 + 내가 올린 글 수.
// 표시 구간: 진료 시작월 ~ 이번 달 (최대 최근 12개월).
async function loadMissionStatus(empId) {
    const cur = dayjs().startOf('month');
    let earliest = cur;
    let hasRecords = false;
    let ids = [];
    try {
        const { data: recs } = await db.from('welfare_records')
            .select('id, start_date, status').eq('employee_id', empId);
        const active = (recs || []).filter(r => r.status === 'Active');
        hasRecords = active.length > 0;
        active.forEach(r => {
            const s = dayjs(r.start_date).startOf('month');
            if (s.isValid() && s.isBefore(earliest)) earliest = s;
        });
        ids = active.map(r => r.id);
    } catch (e) { console.warn('[board] 진료기록 로드 실패:', e.message); }

    // 최근 12개월로 제한 (모바일 가독성)
    const floor = cur.subtract(11, 'month');
    let from = earliest.isBefore(floor) ? floor : earliest;
    if (!hasRecords) from = cur.subtract(5, 'month');

    const months = [];
    let m = from;
    while (m.isSameOrBefore(cur, 'month')) { months.push(m.format('YYYY-MM')); m = m.add(1, 'month'); }

    const fulfilled = new Set();
    if (ids.length) {
        const { data } = await db.from('welfare_monthly_fulfillment')
            .select('year_month, fulfilled').in('record_id', ids);
        (data || []).forEach(f => { if (f.fulfilled) fulfilled.add(f.year_month); });
    }
    return { months, fulfilled, hasRecords };
}

// ============================================================
// 직원 화면 — 월별 미션 현황 + 작성 폼 + 내 글 목록
// ============================================================
export async function renderMyBoardSection(container) {
    if (!container) return;
    const empId = state.currentUser?.id;
    if (!empId) {
        container.innerHTML = `<p class="text-red-600 p-4">로그인 정보를 확인할 수 없습니다.</p>`;
        return;
    }

    const months = monthOptions();
    const thisMonth = currentYearMonth();
    let photos = [];        // 현재 폼에 첨부된 사진 경로
    let editingId = null;   // null = 새 글, 값 있으면 수정 중

    container.innerHTML = `
        <div class="bg-blue-50 border border-blue-200 rounded p-3 mb-4 text-sm text-blue-800">
            작성한 <b>블로그 글</b>이나 <b>미션 인증</b>을 올려주세요. 사진도 함께 첨부할 수 있습니다.
            <span class="block text-xs text-blue-600 mt-1">※ 등록한 글은 원장님(관리자)이 확인합니다. 다른 직원에게는 보이지 않습니다.</span>
        </div>

        <div class="bg-white shadow rounded p-4 mb-5">
            <h3 class="font-bold text-lg mb-1">📅 내 월별 미션 현황</h3>
            <p class="text-xs text-gray-500 mb-3">달을 누르면 그 달로 <b>올리기</b> 준비가 됩니다.</p>
            <div id="wb-status"><div class="text-gray-400 text-sm">불러오는 중...</div></div>
            <div class="flex items-center gap-3 mt-3 text-xs text-gray-500 flex-wrap">
                <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 bg-green-500 rounded-sm"></span>이행 인정</span>
                <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 bg-yellow-200 rounded-sm"></span>글 올림 (확인 대기)</span>
                <span class="flex items-center gap-1"><span class="inline-block w-3 h-3 bg-white border rounded-sm"></span>미등록</span>
            </div>
        </div>

        <div id="wb-form-card" class="bg-white shadow rounded p-4 mb-5">
            <div class="flex items-center justify-between mb-3">
                <h3 id="wb-form-title" class="font-bold text-lg">✏️ 새 글 등록</h3>
                <button id="wb-cancel-edit" class="hidden text-xs px-2 py-1 bg-gray-200 rounded">수정 취소</button>
            </div>
            <div class="mb-3">
                <label class="block text-xs font-semibold mb-1">해당 월</label>
                <select id="wb-ym" class="w-full border p-2 rounded text-sm">
                    ${months.map(m => `<option value="${m}" ${m === thisMonth ? 'selected' : ''}>${monthLabel(m)}${m === thisMonth ? ' (이번 달)' : ''}</option>`).join('')}
                </select>
            </div>
            <div class="mb-3">
                <label class="block text-xs font-semibold mb-1">제목</label>
                <input id="wb-title" type="text" maxlength="100" class="w-full border p-2 rounded text-sm" placeholder="예) 8월 미션 — 원내 이벤트 블로그 포스팅">
            </div>
            <div class="mb-3">
                <label class="block text-xs font-semibold mb-1">내용</label>
                <textarea id="wb-body" rows="5" class="w-full border p-2 rounded text-sm" placeholder="어떤 미션을 어떻게 이행했는지 자유롭게 적어주세요."></textarea>
            </div>
            <div class="mb-3">
                <label class="block text-xs font-semibold mb-1">링크 (선택)</label>
                <input id="wb-link" type="url" class="w-full border p-2 rounded text-sm" placeholder="https://blog.naver.com/...">
            </div>
            <div class="mb-4">
                <label class="block text-xs font-semibold mb-1">사진 첨부 (여러 장 가능)</label>
                <div class="flex items-center gap-2 flex-wrap">
                    <label class="cursor-pointer text-xs px-3 py-2 bg-gray-200 rounded hover:bg-gray-300">📷 사진 추가
                        <input type="file" accept="image/*" multiple id="wb-file" class="hidden">
                    </label>
                    <span id="wb-upl" class="text-xs text-blue-600"></span>
                </div>
                <div id="wb-thumbs" class="flex gap-2 flex-wrap mt-2"></div>
            </div>
            <button id="wb-submit" class="w-full sm:w-auto px-5 py-2 bg-blue-600 text-white rounded font-semibold text-sm">등록하기</button>
        </div>

        <div class="bg-white shadow rounded p-4">
            <h3 class="font-bold text-lg mb-3">📚 내가 올린 글 <span id="wb-count" class="text-sm text-gray-500"></span></h3>
            <div id="wb-list"><div class="text-gray-500 text-sm py-4 text-center">불러오는 중...</div></div>
        </div>`;

    const $ = sel => container.querySelector(sel);
    const thumbHost = $('#wb-thumbs');

    const paintThumbs = async () => {
        if (!photos.length) { thumbHost.innerHTML = '<span class="text-xs text-gray-400">첨부된 사진 없음</span>'; return; }
        const map = await signedUrlMap(photos);
        thumbHost.innerHTML = photos.map(p => `
            <span class="relative inline-block">
                <img src="${map[p] || ''}" class="w-16 h-16 object-cover rounded border">
                <button class="wb-del-photo absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-5 h-5 text-xs leading-none flex items-center justify-center" data-path="${p}" title="삭제">×</button>
            </span>`).join('');
        thumbHost.querySelectorAll('.wb-del-photo').forEach(b => {
            b.onclick = async () => {
                const path = b.dataset.path;
                // 수정 중인 글의 기존 사진은 [저장] 전까지 스토리지에서 지우지 않는다 (취소 시 복구 위해).
                if (!editingId) await removeDocsFile(path);
                photos = photos.filter(x => x !== path);
                await paintThumbs();
            };
        });
    };
    await paintThumbs();

    // 해당 월을 폼에 세팅하고 작성 폼으로 이동 ("올리기" 진입점)
    const pickMonth = (ym) => {
        $('#wb-ym').value = ym;
        $('#wb-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('#wb-title').focus({ preventScroll: true });
    };

    $('#wb-file').addEventListener('change', async (e) => {
        const files = [...e.target.files]; e.target.value = '';
        const upl = $('#wb-upl');
        let seq = photos.length, done = 0;
        for (const f of files) {
            if (!f.type.startsWith('image/')) continue;
            upl.textContent = `업로드 중… (${done + 1}/${files.length})`;
            try {
                const blob = await compressImage(f);
                photos.push(await uploadPostPhoto(empId, blob, seq++));
                done++;
            } catch (err) {
                console.error('[board] 사진 업로드 실패:', err);
                alert('사진 업로드 실패: ' + err.message);
            }
        }
        upl.textContent = '';
        await paintThumbs();
    });

    const resetForm = async () => {
        editingId = null;
        photos = [];
        $('#wb-form-title').textContent = '✏️ 새 글 등록';
        $('#wb-submit').textContent = '등록하기';
        $('#wb-cancel-edit').classList.add('hidden');
        $('#wb-ym').value = thisMonth;
        $('#wb-title').value = '';
        $('#wb-body').value = '';
        $('#wb-link').value = '';
        await paintThumbs();
    };

    $('#wb-cancel-edit').addEventListener('click', resetForm);

    $('#wb-submit').addEventListener('click', async () => {
        const btn = $('#wb-submit');
        const payload = {
            employeeId: empId,
            yearMonth: $('#wb-ym').value,
            title:     $('#wb-title').value,
            body:      $('#wb-body').value,
            linkUrl:   $('#wb-link').value,
            photos,
        };
        if (!payload.title.trim()) { alert('제목을 입력해주세요.'); return; }
        btn.disabled = true; btn.textContent = '저장 중…';
        try {
            if (editingId) await updateWelfarePost(editingId, payload);
            else           await createWelfarePost(payload);
            await resetForm();
            await refreshList();
            if (typeof window.showToast === 'function') window.showToast('등록되었습니다');
        } catch (e) {
            alert('저장 실패: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = editingId ? '수정 저장' : '등록하기';
        }
    });

    // 월별 현황 스트립 — 관리자 이행 인정 / 내 글 등록 여부를 한눈에.
    async function refreshStatus(posts) {
        const host = $('#wb-status');
        let st;
        try { st = await loadMissionStatus(empId); }
        catch (e) { host.innerHTML = `<span class="text-xs text-red-600">현황 불러오기 실패: ${esc(e.message)}</span>`; return; }

        const postCount = {};
        (posts || []).forEach(p => { postCount[p.year_month] = (postCount[p.year_month] || 0) + 1; });

        host.innerHTML = `<div class="flex gap-2 flex-wrap">${st.months.map(ym => {
            const done = st.fulfilled.has(ym);
            const mine = postCount[ym] || 0;
            const cls = done ? 'bg-green-500 text-white border-green-600'
                     : (mine ? 'bg-yellow-200 text-yellow-800 border-yellow-300'
                             : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-100');
            const mark = done ? '✓' : (mine ? `📸${mine > 1 ? mine : ''}` : '+');
            const [, mm] = ym.split('-');
            return `<button class="wb-month px-2 py-1 rounded border text-xs flex-shrink-0" data-ym="${ym}"
                        title="${monthLabel(ym)} — ${done ? '이행 인정됨' : (mine ? `내 글 ${mine}건 (확인 대기)` : '아직 등록 안 함')} · 누르면 이 달로 올리기">
                        ${Number(mm)}월 ${mark}</button>`;
        }).join('')}</div>
        ${st.hasRecords ? '' : '<p class="text-xs text-gray-400 mt-2">등록된 진료비 복지 기록이 없어도 미션 글은 올릴 수 있습니다.</p>'}`;

        host.querySelectorAll('.wb-month').forEach(b => { b.onclick = () => pickMonth(b.dataset.ym); });
    }

    async function refreshList() {
        const listHost = $('#wb-list');
        let posts = [];
        try {
            posts = await loadWelfarePosts({ employeeId: empId });
        } catch (e) {
            listHost.innerHTML = `<p class="text-red-600 text-sm">불러오기 실패: ${esc(e.message)}</p>`;
            return;
        }
        await refreshStatus(posts);

        $('#wb-count').textContent = posts.length ? `(총 ${posts.length}건)` : '';
        if (!posts.length) {
            listHost.innerHTML = `<p class="text-gray-500 text-sm py-4 text-center">아직 올린 글이 없습니다. 위에서 첫 글을 등록해보세요.</p>`;
            return;
        }
        const urlMap = await signedUrlMap(posts.flatMap(p => p.photos || []));
        listHost.innerHTML = `<div class="space-y-3">${posts.map(p => `
            <div class="border rounded p-3">
                <div class="flex items-start justify-between gap-2 mb-1">
                    <span class="px-2 py-0.5 rounded bg-gray-800 text-white text-xs">${monthLabel(p.year_month)}</span>
                    <div class="flex gap-1 flex-shrink-0">
                        <button class="wb-edit text-xs px-2 py-1 bg-gray-200 rounded" data-id="${p.id}">수정</button>
                        <button class="wb-del text-xs px-2 py-1 bg-red-100 text-red-700 rounded" data-id="${p.id}">삭제</button>
                    </div>
                </div>
                <div class="font-semibold">${esc(p.title)}</div>
                <div class="text-xs text-gray-400 mb-1">작성 ${dayjs(p.created_at).format('YYYY-MM-DD HH:mm')}</div>
                ${p.body ? `<div class="text-sm text-gray-700" style="white-space:pre-wrap">${esc(p.body)}</div>` : ''}
                ${p.link_url ? `<a href="${esc(p.link_url)}" target="_blank" rel="noopener" class="text-xs text-blue-600 underline break-all">${esc(p.link_url)}</a>` : ''}
                ${photoGridHTML(p.photos, urlMap)}
            </div>`).join('')}</div>`;

        bindPhotoOpen(listHost);

        listHost.querySelectorAll('.wb-edit').forEach(b => {
            b.onclick = async () => {
                const post = posts.find(x => String(x.id) === b.dataset.id);
                if (!post) return;
                editingId = post.id;
                photos = Array.isArray(post.photos) ? [...post.photos] : [];
                $('#wb-form-title').textContent = '✏️ 글 수정';
                $('#wb-submit').textContent = '수정 저장';
                $('#wb-cancel-edit').classList.remove('hidden');
                $('#wb-ym').value = post.year_month;
                $('#wb-title').value = post.title;
                $('#wb-body').value = post.body || '';
                $('#wb-link').value = post.link_url || '';
                await paintThumbs();
                $('#wb-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
            };
        });

        listHost.querySelectorAll('.wb-del').forEach(b => {
            b.onclick = async () => {
                if (!confirm('이 글을 삭제할까요? (첨부 사진도 함께 삭제됩니다)')) return;
                try {
                    await deleteWelfarePost(Number(b.dataset.id));
                    if (editingId === Number(b.dataset.id)) await resetForm();
                    await refreshList();
                } catch (e) { alert('삭제 실패: ' + e.message); }
            };
        });
    }

    await refreshList();
}

// ============================================================
// 관리자 화면 — 전체 글 열람 (월/직원 필터)
// ============================================================
function adminShowsTest() {
    return state.userRole === 'admin' ? state.showTestEmployeesAdmin : state.showTestEmployees;
}

export async function renderBoardAdminSection(pane) {
    if (!pane) return;
    state.welfareBoard ??= { ym: '', empId: '' };
    const f = state.welfareBoard;
    const months = monthOptions().slice().reverse();

    pane.innerHTML = `
        <div class="bg-blue-50 border border-blue-200 rounded p-3 mb-4 text-sm">
            <span class="font-bold text-blue-800">📸 미션 게시판</span> —
            직원들이 올린 <b>블로그 글 / 미션 인증</b>입니다. 사진을 클릭하면 원본이 열립니다.
        </div>
        <div class="flex flex-wrap gap-2 items-end mb-3">
            <div>
                <label class="block text-xs font-semibold mb-1">해당 월</label>
                <select id="wba-ym" class="border p-2 rounded text-sm">
                    <option value="">전체 월</option>
                    ${months.map(m => `<option value="${m}" ${f.ym === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
                </select>
            </div>
            <div>
                <label class="block text-xs font-semibold mb-1">직원</label>
                <select id="wba-emp" class="border p-2 rounded text-sm"><option value="">전체</option></select>
            </div>
            <button id="wba-reload" class="px-3 py-2 bg-gray-200 rounded text-sm">새로고침</button>
            <div id="wba-summary" class="text-sm text-gray-600 ml-auto"></div>
        </div>
        <div id="wba-list"><div class="text-center text-gray-500 py-8">불러오는 중...</div></div>`;

    const $ = sel => pane.querySelector(sel);
    const listHost = $('#wba-list');

    async function load() {
        let posts = [];
        try {
            posts = await loadWelfarePosts({ yearMonth: f.ym || null });
        } catch (e) {
            listHost.innerHTML = `<p class="text-red-600 p-4">불러오기 실패: ${esc(e.message)}</p>`;
            return;
        }

        // 테스트 직원은 토글에 따라 제외 (복지 탭 다른 화면과 동일 규칙)
        if (!adminShowsTest()) posts = posts.filter(p => !isTestEmployee(p.employee));

        // 직원 필터 옵션 — 실제 글이 있는 직원만
        const empSel = $('#wba-emp');
        const emps = [];
        posts.forEach(p => {
            if (p.employee && !emps.some(e => e.id === p.employee.id)) emps.push(p.employee);
        });
        emps.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        empSel.innerHTML = `<option value="">전체 직원</option>` + emps.map(e =>
            `<option value="${e.id}" ${String(f.empId) === String(e.id) ? 'selected' : ''}>${esc(e.name)}</option>`).join('');

        const filtered = f.empId ? posts.filter(p => String(p.employee_id) === String(f.empId)) : posts;

        $('#wba-summary').textContent =
            `${filtered.length}건 · 참여 직원 ${new Set(filtered.map(p => p.employee_id)).size}명`;

        if (!filtered.length) {
            listHost.innerHTML = `<div class="text-center text-gray-500 py-10">해당 조건의 글이 없습니다.</div>`;
            return;
        }

        const urlMap = await signedUrlMap(filtered.flatMap(p => p.photos || []));
        const canDelete = state.userRole === 'admin';

        listHost.innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-3">${filtered.map(p => `
            <div class="border rounded p-3 bg-white">
                <div class="flex items-start justify-between gap-2 mb-1">
                    <div class="flex items-center gap-1 flex-wrap">
                        <span class="px-2 py-0.5 rounded bg-gray-800 text-white text-xs">${esc(p.employee?.name || '?')}</span>
                        <span class="px-2 py-0.5 rounded bg-gray-100 border text-xs">${monthLabel(p.year_month)}</span>
                    </div>
                    ${canDelete ? `<button class="wba-del text-xs px-2 py-1 bg-red-100 text-red-700 rounded flex-shrink-0" data-id="${p.id}">삭제</button>` : ''}
                </div>
                <div class="font-semibold">${esc(p.title)}</div>
                <div class="text-xs text-gray-400 mb-1">작성 ${dayjs(p.created_at).format('YYYY-MM-DD HH:mm')}</div>
                ${p.body ? `<div class="text-sm text-gray-700" style="white-space:pre-wrap">${esc(p.body)}</div>` : ''}
                ${p.link_url ? `<a href="${esc(p.link_url)}" target="_blank" rel="noopener" class="text-xs text-blue-600 underline break-all">${esc(p.link_url)}</a>` : ''}
                ${photoGridHTML(p.photos, urlMap)}
            </div>`).join('')}</div>`;

        bindPhotoOpen(listHost);
        listHost.querySelectorAll('.wba-del').forEach(b => {
            b.onclick = async () => {
                if (!confirm('이 글을 삭제할까요? (직원이 올린 글입니다)')) return;
                try { await deleteWelfarePost(Number(b.dataset.id)); await load(); }
                catch (e) { alert('삭제 실패: ' + e.message); }
            };
        });
    }

    $('#wba-ym').addEventListener('change', e => { f.ym = e.target.value; load(); });
    $('#wba-emp').addEventListener('change', e => { f.empId = e.target.value; load(); });
    $('#wba-reload').addEventListener('click', () => load());

    await load();
}
