import nodemailer from 'npm:nodemailer@6.9.16';

// =====================================================================
// UNION 사업관리 : 메일 발송 서버 함수 (Supabase Edge Function, 이름: send-mail)
// 견적서·발주서 PDF를 첨부해서 Resend로 메일을 보냅니다.
//
// 발송 방법은 둘 중 하나 (Supabase → Edge Functions → Secrets에 넣은 값으로 자동 선택):
//  [A] 회사/Gmail 메일 계정으로 보내기 (SMTP)  ← SMTP_HOST가 있으면 이 방법 사용
//   SMTP_HOST  : 예) smtp.gmail.com / smtps.hiworks.com
//   SMTP_PORT  : 465 (SSL)  ※ Supabase는 25·587 포트를 막아서 465만 사용
//   SMTP_USER  : 로그인 메일 주소
//   SMTP_PASS  : 비밀번호 (Gmail은 '앱 비밀번호' 16자리)
//  [B] Resend로 보내기 (도메인 인증 필요)
//   RESEND_API_KEY  : Resend에서 만든 API 키 (re_로 시작)
//   MAIL_FROM       : 보내는 주소. Resend에서 인증한 도메인이어야 함 (예: sales@unionsystems.co.kr)
//  공통
//   MAIL_FROM_NAME  : 보내는 사람 이름 (예: 유니온시스템즈)  ※ 선택
//   MAIL_FROM       : [A]에서는 생략하면 SMTP_USER로 보냄
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
    const smtpHost = Deno.env.get('SMTP_HOST');
    const smtpUser = Deno.env.get('SMTP_USER');
    const smtpPass = Deno.env.get('SMTP_PASS');
    const key = Deno.env.get('RESEND_API_KEY');
    const fromAddr = Deno.env.get('MAIL_FROM') || (smtpHost ? smtpUser : '');
    if (smtpHost) {
      if (!smtpUser || !smtpPass) return json({ error: '메일 발송 설정이 덜 됐습니다 (SMTP_USER, SMTP_PASS 비밀값 필요)' }, 500);
    } else if (!key || !fromAddr) {
      return json({ error: '메일 발송 설정이 안 되어 있습니다 (SMTP_HOST·SMTP_USER·SMTP_PASS 또는 RESEND_API_KEY·MAIL_FROM 비밀값 필요)' }, 500);
    }

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

    // 4-A) 메일 계정(SMTP)으로 발송
    if (smtpHost) {
      const port = Number(Deno.env.get('SMTP_PORT') || 465);
      const transporter = nodemailer.createTransport({
        host: smtpHost, port, secure: port === 465,
        auth: { user: smtpUser, pass: smtpPass },
      });
      try {
        const info = await transporter.sendMail({
          from: payload.from as string,
          to, cc: cc.length ? cc : undefined,
          replyTo: payload.reply_to as string,
          subject: payload.subject as string,
          text: payload.text as string,
          html: (payload.html as string) || undefined,
          attachments: ((payload.attachments as { filename: string; content: string }[]) || [])
            .map((a) => ({ filename: a.filename, content: a.content, encoding: 'base64' })),
        });
        return json({ ok: true, id: info.messageId, sender: user.email, via: 'smtp' });
      } catch (e) {
        const m = String((e as Error)?.message || e);
        const hint = /auth|535|534|Invalid login|Username and Password/i.test(m)
          ? ' — 메일 계정 로그인 실패: SMTP_USER/SMTP_PASS를 확인하세요 (Gmail은 앱 비밀번호 필요)'
          : /ETIMEDOUT|ECONNREFUSED|connect|timeout/i.test(m) ? ' — 메일 서버 연결 실패: SMTP_HOST와 포트(465)를 확인하세요' : '';
        return json({ error: '메일 발송에 실패했습니다' + hint, detail: { message: m } }, 400);
      }
    }

    // 4-B) Resend로 발송
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
