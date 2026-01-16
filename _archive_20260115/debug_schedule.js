const https = require('https');

const SUPABASE_URL = 'https://chnqtrmlglqdmzqwsazm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNobnF0cm1sZ2xxZG16cXdzYXptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0ODUxOTksImV4cCI6MjA3MDA2MTE5OX0.HBvXKoFAQsIjyePoMgtOpYZePoOHO9dYekcAsY1G6gQ';

function supabaseFetch(table, query) {
    return new Promise((resolve, reject) => {
        const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
        const options = {
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json'
            }
        };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log('Checking schedule confirmations for 2025-12...');
    const confirmations = await supabaseFetch('schedule_confirmations', 'month=eq.2025-12&select=*');
    console.log('Confirmations:', JSON.stringify(confirmations, null, 2));

    console.log('Checking schedules for 2025-12-08 to 2025-12-14...');
    const schedules = await supabaseFetch('schedules', 'date=gte.2025-12-08&date=lte.2025-12-14&select=*');
    console.log(`Found ${schedules.length} schedules.`);
    if (schedules.length > 0) {
        console.log('Sample schedule:', JSON.stringify(schedules[0], null, 2));
        const statuses = [...new Set(schedules.map(s => s.status))];
        console.log('Statuses found:', statuses);
    } else {
        console.log('No schedules found for this week.');
    }
}

main().catch(console.error);
