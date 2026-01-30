# AppSheet 연동 가이드 및 스크립트

이 문서는 기존 연차 관리 시스템(웹)과 AppSheet(구글 시트)를 연동하기 위한 가이드입니다.

## 1. 구글 시트 스크립트 업데이트

AppSheet가 사용 중인 구글 시트(`스케줄표 v3`)를 열고, `확장 프로그램` > `Apps Script` 메뉴로 이동하여 기존 코드를 아래 코드로 **교체(또는 추가)**해야 합니다.

**[데이터]** 시트와 별도로 **[Leaves]** 시트가 자동으로 생성되며, 이곳에 웹사이트의 연차가 기록됩니다.

### 추가할 코드 (기존 코드 제일 위에 붙여넣으세요)

```javascript
/**
 * =========================================================================================
 * [통합 스케줄링 시스템] Google Apps Script (GAS)
 * 
 * * 설명: 웹사이트(Supabase)와 구글 시트(AppSheet) 간의 데이터 동기화를 처리합니다.
 * * 기능:
 *    1. doPost: 웹에서 보낸 직원/연차 데이터를 시트에 반영
 *    2. doGet: 시트에서 생성된 스케줄을 웹으로 전송
 * =========================================================================================
 */

// -----------------------------------------------------------------------------------------
// 1. 웹앱 API 핸들러 (doGet, doPost)
// -----------------------------------------------------------------------------------------

// 웹사이트 -> 구글 시트 (데이터 밀어넣기)
function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const action = params.action;

    if (action === 'syncData') {
      // 1. 직원 정보 업데이트
      updateStaffData(params.employees);
      // 2. 연차 정보 업데이트
      updateLeaveData(params.leaves);
      
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', message: '데이터 동기화 완료' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    throw new Error('알 수 없는 명령입니다: ' + action);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 구글 시트 -> 웹사이트 (데이터 가져오기)
function doGet(e) {
  try {
    const action = e.parameter.action;
    
    if (action === 'getSchedule') {
      const month = e.parameter.month; // YYYY-MM
      const schedule = extractScheduleData(month);
      
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: schedule }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: '잘못된 요청입니다.' }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// -----------------------------------------------------------------------------------------
// 2. 데이터 동기화 로직
// -----------------------------------------------------------------------------------------

function updateStaffData(newStaffList) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Data");
  if (!sheet) throw new Error("'Data' 시트가 없습니다.");

  const data = sheet.getDataRange().getValues();
  const existingStaffMap = new Map();
  
  // 기존 데이터 보존 (팀/휴무 설정 등)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === '직원') {
      existingStaffMap.set(row[1], row);
    }
  }
  
  const newRows = [];
  // 헤더 및 원장/설정 데이터 보존
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] !== '직원') {
      newRows.push(data[i]);
    }
  }
  
  // 새 직원 목록 병합
  newStaffList.forEach(emp => {
    if (existingStaffMap.has(emp.name)) {
      newRows.push(existingStaffMap.get(emp.name));
    } else {
      // 신규 직원 추가 (Type, Name, Limit, Team1, Team2, OffRule, TO, Sub)
      // 부서명(emp.department)을 Team1에 넣을 수도 있음
      newRows.push(['직원', emp.name, '', '-', '-', '-', '', '']);
    }
  });

  // 배열 정리 (원장 -> 직원 -> 설정)
  const sortedRows = [newRows[0]]; // Header
  const doctors = newRows.filter(r => r[0] === '원장');
  const staffs = newRows.filter(r => r[0] === '직원');
  const settings = newRows.filter(r => r[0] === '설정');
  
  const finalRows = [...sortedRows, ...doctors, ...staffs, ...settings];
  
  sheet.clearContents();
  sheet.getRange(1, 1, finalRows.length, finalRows[0].length).setValues(finalRows);
}

function updateLeaveData(leaves) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Leaves");
  if (!sheet) {
    sheet = ss.insertSheet("Leaves");
    sheet.appendRow(["Name", "Date", "Reason"]); // Header
  } else {
    sheet.clearContents();
    sheet.appendRow(["Name", "Date", "Reason"]); // Header
  }
  
  if (leaves && leaves.length > 0) {
    const rows = leaves.map(l => [l.name, l.date, l.reason || '연차']);
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
}

// -----------------------------------------------------------------------------------------
// 3. 스케줄 추출 로직 (Main 시트 -> JSON)
// -----------------------------------------------------------------------------------------

function extractScheduleData(targetMonth) { // YYYY-MM
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  let targetSheet = null;
  
  // 확정본 찾기
  for (let i = sheets.length - 1; i >= 0; i--) {
    const name = sheets[i].getName();
    if (name.includes(targetMonth) && name.includes('확정본')) {
      targetSheet = sheets[i];
      break;
    }
  }
  
  if (!targetSheet) {
     const main = ss.getSheetByName("Main");
     // Main이 해당 월인지 확인 불가하나 fallback으로 사용
     targetSheet = main; 
  }

  const data = targetSheet.getDataRange().getDisplayValues();
  const schedules = [];
  
  // 날짜 행 찾기
  let headerRows = [];
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r].length; c++) {
      if (/\d+일\s*\(/.test(data[r][c])) {
        headerRows.push(r);
        break;
      }
    }
  }

  for (let i = 0; i < headerRows.length; i++) {
    const startRow = headerRows[i];
    const endRow = (i < headerRows.length - 1) ? headerRows[i+1] : data.length;
    const colDateMap = {};
    
    // 날짜 헤더 파싱
    for (let c = 0; c < data[startRow].length; c++) {
      const cellText = data[startRow][c];
      const match = cellText.match(/(\d+)일/);
      if (match) {
        const day = parseInt(match[1]);
        const dateStr = `${targetMonth}-${String(day).padStart(2, '0')}`;
        colDateMap[c] = dateStr;
        colDateMap[c+1] = dateStr;
        colDateMap[c+2] = dateStr;
        colDateMap[c+3] = dateStr;
      }
    }

    const doctorRowIndex = startRow + 1;
    for (let r = doctorRowIndex + 1; r < endRow; r++) {
      for (let c = 0; c < data[r].length; c++) {
        const dateStr = colDateMap[c];
        if (!dateStr) continue;

        const cellVal = data[r][c].trim();
        if (!cellVal) continue;
        if (cellVal.includes('부족') || cellVal.includes('여유') || cellVal.includes('적정')) continue;
        if (cellVal.includes('주간 검수') || cellVal.includes('목표:')) break;
        
        const empName = cellVal.replace(/\(.*\)/, '').trim(); 
        
        schedules.push({
          date: dateStr,
          name: empName,
          status: '근무'
        });
      }
    }
  }
  return schedules;
}
```

### 필수 수정사항: `calculateAllocation` 함수

기존 코드에 있는 `calculateAllocation` 함수를 찾아 아래와 같이 수정해야 합니다. (연차 반영을 위함)

1. `generateSchedule` 함수 맨 윗부분에 다음 줄 추가:
   ```javascript
   const allLeaves = getLeavesFromSheet(); // getLeavesFromSheet 함수는 아래에 추가 필요
   ```

2. `renderWideGrid` 함수 호출부 수정:
   - `calculateAllocation` 호출 시 `allLeaves`를 인자로 넘겨주세요.
   - `renderWideGrid(..., allLeaves)`

3. `calculateAllocation` 함수 정의 수정:
   ```javascript
   function calculateAllocation(date, config, holidays, weeklyCounts, rotationOffs, holidayCountInWeek, allLeaves) {
      // ... (기존 코드)

      config.staffs.forEach(staff => {
        let isAvailable = true;
        
        // [추가된 부분] Leaves 시트에 있는 날짜면 휴무 처리
        const dateStr = formatDate(date);
        if (allLeaves && allLeaves.some(l => l.name === staff.name && l.date === dateStr)) {
            isAvailable = false;
        }
        
        // ... (이후 기존 코드)
   ```

4. 맨 아래에 헬퍼 함수 추가:
   ```javascript
   function getLeavesFromSheet() {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName("Leaves");
      if (!sheet) return [];
      const data = sheet.getDataRange().getValues();
      const leaves = [];
      for(let i=1; i<data.length; i++) {
         // 날짜 포맷 변환 필요할 수 있음
         let d = data[i][1];
         if (d instanceof Date) d = formatDate(d);
         leaves.push({ name: data[i][0], date: d });
      }
      return leaves;
   }
   ```

## 2. 웹 앱으로 배포

1. Apps Script 화면 우측 상단의 `배포` -> `새 배포` 클릭
2. 유형: `웹 앱`
3. 설명: `v1` (아무거나)
4. **다음 사용자 권한으로 실행**: `나(Me)` (중요!)
5. **액세스 권한이 있는 사용자**: `모든 사용자` (중요! 로그인 없이 Supabase에서 접근 가능하게 함)
6. `배포` 클릭 -> **웹 앱 URL** 복사
7. 이 URL을 웹사이트의 `스케줄 관리` -> `AppSheet 연동` 설정에 입력하세요.

