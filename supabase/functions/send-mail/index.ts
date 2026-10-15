// =====================================================================
// UNION 사업관리 : 메일 발송 서버 함수 (Supabase Edge Function, 이름: send-mail)
// 견적서·발주서 PDF를 첨부해서 Resend로 메일을 보냅니다.
//
// 필요한 비밀값 (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY  : Resend에서 만든 API 키 (re_로 시작)
//   MAIL_FROM       : 보내는 주소. Resend에서 인증한 도메인이어야 함 (예: sales@unionsystems.co.kr)
//   MAIL_FROM_NAME  : 보내는 사람 이름 (예: 유니온시스템즈)  ※ 선택
//
// 로그인한 직원만 호출할 수 있고, 답장은 보낸 직원의 메일로 가도록 reply_to를 넣습니다.
// =====================================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const isEmail = (v: unknown) => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST만 허용됩니다' }, 405);

  try {
    // 1) 로그인한 사용자인지 확인
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const auth = req.headers.get('Authorization') || '';
    const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
    const who = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
    if (!who.ok) return json({ error: '로그인이 필요합니다' }, 401);
    const user = await who.json();

    // 2) 설정값 확인
    const key = Deno.env.get('RESEND_API_KEY');
    const fromAddr = Deno.env.get('MAIL_FROM');
    if (!key || !fromAddr) return json({ error: '메일 발송 설정이 안 되어 있습니다 (RESEND_API_KEY, MAIL_FROM 비밀값 필요)' }, 500);

    // 3) 요청 내용 확인
    const body = await req.json();
    const to = (Array.isArray(body.to) ? body.to : [body.to]).filter(isEmail);
    const cc = (Array.isArray(body.cc) ? body.cc : body.cc ? [body.cc] : []).filter(isEmail);
    if (!to.length) return json({ error: '받는 사람 이메일이 없습니다' }, 400);
    if (to.length + cc.length > 30) return json({ error: '받는 사람이 너무 많습니다 (최대 30명)' }, 400);
    if (!body.subject) return json({ error: '제목이 없습니다' }, 400);

    const fromName = body.fromName || Deno.env.get('MAIL_FROM_NAME') || '';
    const payload: Record<string, unknown> = {
      from: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
      to,
      subject: String(body.subject).slice(0, 300),
      text: body.text || '',
      reply_to: isEmail(body.replyTo) ? body.replyTo : user.email,
    };
    if (cc.length) payload.cc = cc;
    if (body.html) payload.html = body.html;
    if (Array.isArray(body.attachments) && body.attachments.length) {
      payload.attachments = body.attachments
        .filter((a: { filename?: string; content?: string }) => a && a.filename && a.content)
        .map((a: { filename: string; content: string }) => ({ filename: a.filename, content: a.content }));
    }

    // 4) Resend로 발송
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: data.message || '메일 발송에 실패했습니다', detail: data }, 400);
    return json({ ok: true, id: data.id, sender: user.email });
  } catch (e) {
    return json({ error: String(e && (e as Error).message || e) }, 500);
  }
});
