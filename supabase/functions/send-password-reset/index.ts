// 직원이 로그인 화면에서 [비밀번호 잊으셨나요?] 클릭 → 이름 입력 시 호출됨.
// DB 에서 이름 매칭 → 등록된 이메일로 임시비번 자동 발송 (Gmail SMTP).
// verify_jwt=false (로그인 전 호출). rate limit + 메일은 등록 이메일로만 → 도용 위험 차단.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_USER = Deno.env.get("GMAIL_USER")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// in-memory cooldown — 같은 이름 1분에 1회 (장난 방지)
const cooldown = new Map<string, number>();
const COOLDOWN_MS = 60_000;

function maskEmail(email: string): string {
    const at = email.indexOf("@");
    if (at <= 0) return email;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const visible = local.slice(0, 1);
    const stars = "*".repeat(Math.max(local.length - 1, 1));
    return `${visible}${stars}@${domain}`;
}

function generateTempPassword(): string {
    // 헷갈리는 문자 (0/O, 1/l/I) 제외
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    const buf = new Uint32Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

// ⚠️ denomailer 1.6.0 헤더 인코더 버그 우회 (2026-08-23 실제 사고)
// denomailer 는 subject 에 비ASCII 가 있으면 quotedPrintableEncodeInline() 을 태우는데,
// 그 내부 quotedPrintableEncode() 는 "본문용" 인코더라 74자마다 `=\r\n` (soft line break) 를 끼워 넣는다.
// 헤더에서 CRLF 다음에 공백이 없으면 헤더 블록이 거기서 끝나버려 →
// 나머지 헤더(From/To/MIME-Version/Content-Type)와 MIME 구조 전체가 본문으로 쏟아진다.
// (게다가 encoded-word 안에 raw space 를 그대로 둬서 RFC 2047 위반이기도 함)
// → 우리가 직접 base64 encoded-word 로 만들어 "순수 ASCII" 로 넘기면 denomailer 가 손대지 않는다.
//   맨 앞 공백: 문자열이 "=?" 로 시작하지 않게 해 재인코딩을 막고(=denomailer passthrough 조건),
//   동시에 encoded-word 앞 구분 공백 역할도 한다 (헤더 값 앞 공백은 파서가 무시).
function encodeHeaderValue(text: string): string {
    const enc = new TextEncoder();
    if (!enc.encode(text).some((b) => b > 127)) return text; // ASCII 면 그대로

    // encoded-word 1개 = 최대 75자. `=?UTF-8?B?` + `?=` 오버헤드 12자 → base64 63자 → 원본 45바이트
    const MAX_BYTES = 45;
    const toWord = (bytes: number[]) =>
        `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`;

    const words: string[] = [];
    let cur: number[] = [];
    for (const ch of text) { // 코드포인트 단위 순회 — 멀티바이트 문자를 쪼개지 않음
        const b = Array.from(enc.encode(ch));
        if (cur.length + b.length > MAX_BYTES) {
            words.push(toWord(cur));
            cur = [];
        }
        cur.push(...b);
    }
    if (cur.length) words.push(toWord(cur));

    // 여러 개면 `CRLF + 공백` 으로 정상 folding (RFC 5322 §2.2.3)
    return " " + words.join("\r\n ");
}

// ⚠️ 같은 denomailer 버그가 본문에도 있다 (2026-08-24 재현).
// quotedPrintableEncode() 는 74자마다 줄을 자르면서 `=XX` escape 경계를 제대로 못 지켜
// 한글 3바이트 문자의 중간 바이트를 통째로 날려먹는다 ("알려주세요." → "알려주세▯4.").
// → text/html 대신 mimeContent 를 직접 넘기면 denomailer 가 인코딩에 손대지 않고 그대로 싣는다.
//    본문을 우리가 base64 로 인코딩해서 전달 (RFC 2045 — 76자마다 CRLF).
function base64Body(text: string): string {
    const bytes = new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return (btoa(bin).match(/.{1,76}/g) ?? []).join("\r\n");
}

function isInvalidEmail(email: string | null | undefined): boolean {
    if (!email) return true;
    if (email === "6030primes@gmail.com") return true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return true;
    return false;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    try {
        const body = await req.json().catch(() => null);
        const name = body?.name;
        if (!name || typeof name !== "string" || !name.trim()) {
            return jsonResponse({ error: "이름을 입력해주세요." }, 400);
        }

        const trimmedName = name.trim();
        const now = Date.now();
        const last = cooldown.get(trimmedName);
        if (last && now - last < COOLDOWN_MS) {
            const remain = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
            return jsonResponse(
                { error: `잠시 후 다시 시도해주세요 (${remain}초 후).` },
                429,
            );
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

        const { data: employee, error: queryError } = await supabase
            .from("employees")
            .select("id, name, email")
            .eq("name", trimmedName)
            .maybeSingle();

        if (queryError) {
            console.error("Query error:", queryError);
            return jsonResponse({ error: "조회 실패. 잠시 후 다시 시도해주세요." }, 500);
        }
        if (!employee) {
            return jsonResponse({ error: "등록되지 않은 이름입니다." }, 404);
        }
        if (isInvalidEmail(employee.email)) {
            return jsonResponse(
                { error: "등록된 이메일이 없습니다. 관리자에게 문의하세요." },
                400,
            );
        }

        const tempPassword = generateTempPassword();
        const { error: updateError } = await supabase
            .from("employees")
            .update({ password: tempPassword })
            .eq("id", employee.id);
        if (updateError) {
            console.error("Update error:", updateError);
            return jsonResponse({ error: "비밀번호 갱신 실패." }, 500);
        }

        const smtp = new SMTPClient({
            connection: {
                hostname: "smtp.gmail.com",
                port: 465,
                tls: true,
                auth: {
                    username: GMAIL_USER,
                    password: GMAIL_APP_PASSWORD,
                },
            },
        });

        try {
            await smtp.send({
                from: GMAIL_USER,
                to: employee.email,
                subject: encodeHeaderValue("[프라임에스] 임시 비밀번호 안내"),
                mimeContent: [{
                    mimeType: 'text/plain; charset="utf-8"',
                    content: base64Body(
                        `${employee.name}님 안녕하세요.\n\n` +
                        `임시 비밀번호: ${tempPassword}\n\n` +
                        `로그인 후 [비밀번호 변경] 버튼을 눌러 본인 비밀번호로 바로 변경해주세요.\n\n` +
                        `이 메일을 요청하지 않으셨다면 관리자에게 알려주세요.\n\n` +
                        `프라임에스`,
                    ),
                    transferEncoding: "base64",
                }],
            });
        } finally {
            try { await smtp.close(); } catch (_) { /* ignore */ }
        }

        cooldown.set(trimmedName, now);

        return jsonResponse({
            success: true,
            masked_email: maskEmail(employee.email),
        });
    } catch (e) {
        console.error("Unexpected error:", e);
        return jsonResponse({ error: "오류가 발생했습니다. 잠시 후 다시 시도해주세요." }, 500);
    }
});
