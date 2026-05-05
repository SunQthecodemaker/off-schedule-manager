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
                subject: "[프라임에스] 임시 비밀번호 안내",
                content:
                    `${employee.name}님 안녕하세요.\n\n` +
                    `임시 비밀번호: ${tempPassword}\n\n` +
                    `로그인 후 [비밀번호 변경] 버튼을 눌러 본인 비밀번호로 바로 변경해주세요.\n\n` +
                    `이 메일을 요청하지 않으셨다면 관리자에게 알려주세요.\n\n` +
                    `프라임에스`,
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
