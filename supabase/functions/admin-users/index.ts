// =====================================================================
// UNION 사업관리 : 직원 로그인 계정 관리 (Supabase Edge Function, 이름: admin-users)
// 담당자관리 화면에서 관리자만 사용합니다.
//  - list         : 로그인 계정 목록
//  - create       : 계정 만들기 (이메일 + 임시 비밀번호, 바로 로그인 가능)
//  - set_password : 비밀번호 초기화 (임시 비밀번호로 변경)
//  - delete       : 계정 삭제 (로그인만 못 하게 됨 · 계약 등 데이터는 그대로)
//
// 추가로 넣을 비밀값은 없습니다. (Supabase가 기본 제공하는 서비스 키를 사용)
// 배포 후 이 함수의 "Verify JWT" 는 꺼 주세요. 함수 안에서 직접 로그인·관리자 여부를 확인합니다.
// =====================================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const isEmail = (v: unknown) => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());

function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    return keys.default || Object.values(keys)[0] as string || '';
  } catch { return ''; }
}
function adminHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST만 허용됩니다' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = serviceKey();
    if (!url || !key) return json({ error: '서버 키를 찾지 못했습니다 (SUPABASE_SERVICE_ROLE_KEY)' }, 500);

    // 1) 로그인한 사용자 확인
    const auth = req.headers.get('Authorization') || '';
    const apikey = req.headers.get('apikey') || '';
    const who = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
    if (!who.ok) return json({ error: '로그인이 필요합니다' }, 401);
    const me = await who.json();
    const myEmail = String(me.email || '').toLowerCase();

    // 2) 관리자 확인 (담당자관리의 관리자 체크)
    const H = adminHeaders(key);
    const r = await fetch(`${url}/rest/v1/reps?select=email,is_admin`, { headers: H });
    const reps = r.ok ? await r.json() : [];
    const isAdmin = Array.isArray(reps) && reps.some((x: { email?: string; is_admin?: boolean }) => String(x.email || '').toLowerCase() === myEmail && x.is_admin);
    if (!isAdmin) return json({ error: '관리자만 사용할 수 있습니다' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === 'list') {
      const res = await fetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers: H });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: data.msg || data.message || '목록을 불러오지 못했습니다' }, 400);
      const users = (data.users || []).map((u: Record<string, unknown>) => ({
        id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
        confirmed: !!(u.email_confirmed_at || u.confirmed_at),
        name: (u.user_metadata as Record<string, unknown> | undefined)?.name || '',
      }));
      return json({ ok: true, users });
    }

    if (action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!isEmail(email)) return json({ error: '이메일 형식이 아닙니다' }, 400);
      if (String(body.password || '').length < 8) return json({ error: '비밀번호는 8자 이상이어야 합니다' }, 400);
      const res = await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ email, password: body.password, email_confirm: true, user_metadata: { name: body.name || '' } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const m = data.msg || data.message || data.error_description || '';
        return json({ error: /already|registered|exists/i.test(m) ? '이미 계정이 있는 이메일입니다' : (m || '계정을 만들지 못했습니다') }, 400);
      }
      return json({ ok: true, id: data.id });
    }

    if (action === 'set_password' || action === 'delete') {
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: '계정 정보가 올바르지 않습니다' }, 400);
      if (id === me.id) return json({ error: action === 'delete' ? '내 계정은 여기서 삭제할 수 없습니다' : '내 비밀번호는 "비밀번호 변경"에서 바꿔 주세요' }, 400);
      if (action === 'set_password') {
        if (String(body.password || '').length < 8) return json({ error: '비밀번호는 8자 이상이어야 합니다' }, 400);
        const res = await fetch(`${url}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: H, body: JSON.stringify({ password: body.password }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return json({ error: data.msg || data.message || '비밀번호를 바꾸지 못했습니다' }, 400);
        return json({ ok: true });
      }
      const res = await fetch(`${url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: H });
      if (!res.ok) { const data = await res.json().catch(() => ({})); return json({ error: data.msg || data.message || '삭제하지 못했습니다' }, 400); }
      return json({ ok: true });
    }

    return json({ error: '알 수 없는 요청입니다' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
