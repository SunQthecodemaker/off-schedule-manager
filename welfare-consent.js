// 진료비 복지 — 동의서 HTML + 서명 + 인쇄
// Apps Script index.html 의 generateConsentFormHTML / printContent 에 대응.
import { formatNum } from './welfare.js';

// ============================================================
// 1. 동의서 HTML — 인쇄 가능 형태 (offapp window.print() 패턴)
// ============================================================
export function generateConsentHTML(data, signatureUrl /* 저장된 서명 URL, null 이면 빈 서명란 */) {
    if (!data) return '<p class="text-red-600">표시할 데이터가 없습니다.</p>';

    const sigImg = signatureUrl
        ? `<img src="${signatureUrl}" alt="서명" style="width:80px;height:40px;vertical-align:middle;margin-left:10px;border:1px solid #eee;">`
        : '';
    const sigBox = !signatureUrl
        ? `<div style="border:1px solid #ccc;background:#f8f9fa;padding:10px;min-height:150px;text-align:center;">
             <p style="margin:0;">(서명란)</p>
             <canvas id="welfare-signature-canvas" style="width:100%;height:150px;"></canvas>
           </div>`
        : '';

    return `
    <div class="welfare-consent" style="border:1px solid #ccc;padding:30px;margin-top:10px;background:#fff;">
      <h1 style="text-align:center;font-size:24px;">직원 복지 비용 관련 동의서</h1>
      <p>본인은 ${data.clinicName || '(병원명 없음)'}(이하 '회사')의 직원 복지 규정에 따라
         아래와 같이 진료비 지원을 신청하며, 관련 규정 및 아래 명시된 모든 조건에 동의합니다.</p>

      <h3>제 1조 (지원 내역)</h3>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr>
          <th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;width:150px;">동의일자</th>
          <td style="border:1px solid #ccc;padding:10px;">${data.createdAt}</td>
          <th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;width:150px;">직원명</th>
          <td style="border:1px solid #ccc;padding:10px;">${data.employeeName}</td>
        </tr>
        <tr>
          <th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">진료 대상</th>
          <td style="border:1px solid #ccc;padding:10px;">${data.relationType} (${data.patientName})</td>
          <th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">진료 항목</th>
          <td style="border:1px solid #ccc;padding:10px;">${data.treatmentType}</td>
        </tr>
        <tr>
          <th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">세부 진료 항목</th>
          <td colspan="3" style="border:1px solid #ccc;padding:10px;font-weight:bold;">${data.treatmentDetails || '(입력 없음)'}</td>
        </tr>
        <tr>
          <th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">총 진료비</th>
          <td style="border:1px solid #ccc;padding:10px;">${formatNum(data.totalFee)} 원</td>
          <th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">진료 시작일</th>
          <td style="border:1px solid #ccc;padding:10px;">${data.startDate}</td>
        </tr>
      </table>

      <h3>제 2조 (비용 정산 방식)</h3>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;width:200px;">의무 부담금</th>
            <td style="border:1px solid #ccc;padding:10px;">${formatNum(data.selfPay)} 원</td></tr>
        <tr><th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">근속 차감 비용</th>
            <td style="border:1px solid #ccc;padding:10px;">${formatNum(data.prePay)} 원</td></tr>
        <tr><th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">잔여 비용 (상환 대상)</th>
            <td style="border:1px solid #ccc;padding:10px;font-weight:bold;">${formatNum(data.baseAmount)} 원</td></tr>
        <tr><th style="border:1px solid #ccc;padding:10px;background:#f8f9fa;">월 차감 인정액</th>
            <td style="border:1px solid #ccc;padding:10px;">${formatNum(data.monthly)} 원
              <span style="font-size:12px;color:#6c757d;">(월별 약속 이행 확인 시에만 인정)</span></td></tr>
      </table>

      <h3>제 3조 (상환 의무 및 약속 이행)</h3>
      <p>본인은 잔여 비용(${formatNum(data.baseAmount)} 원)을 회사가 정한 약속(블로그 작성·댓글 등)을
         매월 이행하는 조건으로 월 차감받음에 동의합니다.
         <strong>약속 이행이 확인되지 않은 달은 차감되지 않으며</strong>, 누적 미이행분은 잔여 비용에 그대로 남습니다.
         또한 잔여 비용이 모두 상환되기 전에 퇴사할 경우, 퇴사 시점의 잔여 비용 전액을 회사에 일시 상환할 의무가
         있음을 인지하고 이에 동의합니다. 회사는 본인의 최종 급여에서 해당 금액을 우선 공제할 수 있습니다.</p>

      <div style="text-align:right;margin-top:40px;margin-bottom:40px;">
        <p style="margin-bottom:50px;">${data.createdAt}</p>
        <p>동의자: ${data.employeeName} ${sigImg}</p>
      </div>
      ${sigBox}
    </div>`;
}

// ============================================================
// 2. 정산 확인서 HTML
// ============================================================
export function generateSettlementHTML({ employeeName, resignDate, details, totalRemaining }) {
    const today = dayjs().format('YYYY-MM-DD');
    const rows = (details || []).map(d => `
        <tr>
          <td style="border:1px solid #ddd;padding:8px;">${d.patientName || employeeName}</td>
          <td style="border:1px solid #ddd;padding:8px;">${d.treatmentDetails || '-'}</td>
          <td style="border:1px solid #ddd;padding:8px;text-align:right;">${formatNum(d.remaining)} 원</td>
        </tr>`).join('');
    return `
    <div class="welfare-consent" style="padding:20px;border:1px solid #ccc;background:#fff;">
      <h1 style="text-align:center;">퇴사자 복지 비용 정산 확인서</h1>
      <p><b>확인자:</b> ${employeeName}</p>
      <p><b>정산 기준일(퇴사일):</b> ${resignDate}</p>
      <p>상기 본인은 퇴사함에 있어, 재직 중 발생한 직원 복지 진료비 지원금에 대한 잔여 상환 의무가 아래와 같이
         남아있음을 확인하고, 최종 급여에서 해당 금액을 정산(공제)하는 것에 동의합니다.</p>

      <h4>정산 내역</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f2f2f2;">
          <th style="border:1px solid #ddd;padding:8px;">진료대상</th>
          <th style="border:1px solid #ddd;padding:8px;">세부 항목</th>
          <th style="border:1px solid #ddd;padding:8px;">잔여금액</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="font-weight:bold;">
          <td colspan="2" style="border:1px solid #ddd;padding:8px;text-align:right;">최종 정산(공제) 합계</td>
          <td style="border:1px solid #ddd;padding:8px;color:red;text-align:right;">${formatNum(totalRemaining)} 원</td>
        </tr></tfoot>
      </table>

      <div style="border-top:1px solid #ccc;margin-top:40px;padding-top:20px;">
        <p style="margin-bottom:10px;">상기 내용을 모두 확인하였으며, 최종 급여 정산에 동의합니다.</p>
        <p><b>작성일:</b> ${today}</p>
        <p><b>확인자 (서명)</b></p>
        <div style="border:1px solid #ccc;background:#f8f9fa;padding:10px;min-height:150px;text-align:center;">
          <canvas id="welfare-settlement-signature-canvas" style="width:100%;height:150px;"></canvas>
        </div>
      </div>
    </div>`;
}

// ============================================================
// 3. SignaturePad 부착 (offapp 에 이미 SignaturePad UMD 로드됨)
// ============================================================
export function attachSignaturePad(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof SignaturePad === 'undefined') return null;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width  = canvas.offsetWidth  * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    return new SignaturePad(canvas, { backgroundColor: 'rgb(248, 249, 250)' });
}

// ============================================================
// 4. 인쇄 (offapp 표준: window.print)
//    인쇄 영역만 보이도록 body 에 print-only 클래스 추가 후 print, 끝나면 복원.
// ============================================================
export function printHTML(html) {
    const win = window.open('', '_blank', 'width=900,height=900');
    if (!win) { alert('팝업이 차단되었습니다. 브라우저 팝업 차단을 해제해주세요.'); return; }
    win.document.write(`
        <!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>복지 동의서 인쇄</title>
        <style>
          body { font-family: 'Malgun Gothic', sans-serif; padding: 20px; }
          h1 { font-size: 24px; }
          h3 { font-size: 16px; margin-top: 20px; }
          h4 { font-size: 14px; }
          table { border-collapse: collapse; }
          @media print { body { padding: 0; } }
        </style></head><body>${html}
        <script>window.onload = () => { setTimeout(() => { window.print(); }, 200); };<\/script>
        </body></html>`);
    win.document.close();
}
