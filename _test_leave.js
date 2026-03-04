const dayjs = require('c:/temp/dayjs-test/node_modules/dayjs');
global.dayjs = dayjs;
const fs = require('fs');
const content = fs.readFileSync('leave-utils.js', 'utf8').replace(/export function getLeaveDetails/g, 'function getLeaveDetails');
eval(content);

const kim = { name: '김민재', entryDate: '2025-09-17', work_days_per_week: 3 };
const lee = { name: '이진현', entryDate: '2025-04-01', work_days_per_week: 5 };

console.log('Kim:', getLeaveDetails(kim, '2026-03-04'));
console.log('Lee:', getLeaveDetails(lee, '2026-03-04'));
