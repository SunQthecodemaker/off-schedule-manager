-- 직원 비밀번호 평문 저장 → bcrypt 해시 전환 (내부용 최소 보안)
-- 목적: 공개 배포 시 employees.password 평문 유출 차단.
-- 설계 원칙: "쓰기 경로는 그대로, 저장만 해시" — 비번을 쓰는 7곳(직원추가/매니저초기화/
--   staging/임시직원/분실복구 Edge Function/본인변경)을 건드리지 않기 위해
--   DB 트리거가 쓰기 시점에 투명하게 해시한다. 로그인/검증만 서버 함수(RPC)로 전환.
-- 잔여 위험(내부용으로 수용): anon 이 select('*') 로 해시값 자체는 여전히 읽을 수 있음.
--   단 평문이 아니므로 그대로 로그인에 쓸 수 없음. pending_changes RLS 는 별도 과제.

create extension if not exists pgcrypto;

-- 1) 쓰기 시 투명 해시 트리거 -------------------------------------------------
-- 이미 bcrypt 해시($2a/$2b/$2y$..) 면 건드리지 않음(이중 해시 방지).
create or replace function public.hash_employee_password()
returns trigger
language plpgsql
as $$
begin
  if new.password is not null and new.password !~ '^\$2[aby]\$' then
    new.password := extensions.crypt(new.password, extensions.gen_salt('bf'));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hash_employee_password on public.employees;
create trigger trg_hash_employee_password
  before insert or update of password on public.employees
  for each row execute function public.hash_employee_password();

-- 2) 로그인 RPC (SECURITY DEFINER: RLS 우회, 해시 비교, password 제외 후 반환) ----
-- 평문 잔존 행도 안전하게 처리: 해시 행에만 crypt() 적용(평문에 crypt 시 invalid salt 에러 방지).
create or replace function public.employee_login(p_name text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp public.employees;
  v_dept public.departments;
  v_result jsonb;
begin
  select * into v_emp
    from public.employees
   where name = p_name
     and password is not null
     and ( password = p_password
           or (password ~ '^\$2[aby]\$' and password = extensions.crypt(p_password, password)) )
   limit 1;

  if not found then
    return null;
  end if;

  if v_emp.department_id is not null then
    select * into v_dept from public.departments where id = v_emp.department_id;
  end if;

  v_result := to_jsonb(v_emp) - 'password';
  v_result := v_result || jsonb_build_object(
    'departments',
    case when v_dept.id is null then null else to_jsonb(v_dept) end
  );
  return v_result;
end;
$$;

-- 3) 현재 비번 검증 RPC (본인 비번변경/이메일변경 본인확인용) -------------------
create or replace function public.employee_verify_password(p_id bigint, p_password text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.employees
     where id = p_id
       and password is not null
       and ( password = p_password
             or (password ~ '^\$2[aby]\$' and password = extensions.crypt(p_password, password)) )
  );
$$;

grant execute on function public.employee_login(text, text) to anon, authenticated;
grant execute on function public.employee_verify_password(bigint, text) to anon, authenticated;

-- 4) 기존 평문 비밀번호 일괄 해시 전환 (1회) ----------------------------------
update public.employees
   set password = extensions.crypt(password, extensions.gen_salt('bf'))
 where password is not null
   and password !~ '^\$2[aby]\$';
