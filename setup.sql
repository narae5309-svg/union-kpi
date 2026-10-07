-- =====================================================================
-- UNION 사업관리 시스템 : Supabase 설정 SQL
-- Supabase → SQL Editor → New query 에 전체를 붙여넣고 Run 하세요.
-- 빈 프로젝트든, 기존 CRM 데이터가 있는 프로젝트든 그대로 실행하면 됩니다.
-- 기존 데이터는 지우지 않으며, 여러 번 실행해도 안전합니다.
-- =====================================================================

-- ---------------------------------------------------------------
-- 1) 기본 표 만들기 (이미 있으면 건너뜀)
-- ---------------------------------------------------------------
create table if not exists reps (
  id text primary key,
  name text default '',
  phone text default '',
  email text default '',
  dept text default '',
  is_admin boolean default false,
  created_at timestamptz default now()
);

create table if not exists customers (
  id text primary key,
  code text,
  name text default '',
  biz_reg_no text default '',
  ceo text default '',
  contact_email text default '',
  contact_phone text default '',
  industry text,
  type text,
  source text,
  sales_rep text default '',
  reg_date date,
  created_at timestamptz default now()
);

create table if not exists contracts (
  id text primary key,
  code text,
  name text default '',
  customer_id text,
  end_user_name text default '',
  biz_type text default '',
  stage text default '계약',
  request text default '없음',
  contract_date date,
  amount numeric default 0,
  profit_amount numeric default 0,
  expiry_date date,
  alert_days int default 30,
  alert_dismissed boolean default false,
  buyer_contact text default '',
  buyer_email text default '',
  invoice_date date,
  remarks text default '',
  sales_rep text default '',
  opportunity_id text,
  attachment_url text,
  attachment_name text,
  attachment_path text,
  reg_date date,
  created_at timestamptz default now()
);

create table if not exists maintenance_contracts (
  id text primary key,
  name text default '',
  contract_id text,
  start_date date,
  end_date date,
  billing_cycle text default '연납',
  amount numeric default 0,
  profit_amount numeric default 0,
  renewal_type text default '수동갱신',
  sales_rep text default '',
  alert_days int default 30,
  alert_dismissed boolean default false,
  remarks text default '',
  attachment_url text,
  attachment_name text,
  attachment_path text,
  reg_date date,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------
-- 2) 새 시스템에 필요한 컬럼 추가
-- ---------------------------------------------------------------
alter table customers add column if not exists tax_email text default '';

alter table contracts add column if not exists deal_type text default '신규';
alter table contracts add column if not exists start_date date;
alter table contracts add column if not exists contact_id text;
alter table contracts add column if not exists renewed boolean default false;

alter table maintenance_contracts add column if not exists customer_id text;
alter table maintenance_contracts add column if not exists provider text default '벤더 유지보수';
alter table maintenance_contracts add column if not exists deal_type text default '신규';
alter table maintenance_contracts add column if not exists supplier text default '';
alter table maintenance_contracts add column if not exists purchase_amount numeric;
alter table maintenance_contracts add column if not exists renewed boolean default false;

-- ---------------------------------------------------------------
-- 3) 새 표: 고객 담당자, 계약 품목, 기술지원
-- ---------------------------------------------------------------
create table if not exists customer_contacts (
  id text primary key,
  customer_id text,
  name text default '',
  dept text default '',
  phone text default '',
  email text default '',
  created_at timestamptz default now()
);

create table if not exists contract_items (
  id text primary key,
  contract_id text,
  product text default '',
  vendor text default '',
  qty numeric default 1,
  sale_amount numeric default 0,
  supplier text default '',
  purchase_amount numeric default 0,
  sort int default 0,
  created_at timestamptz default now()
);

create table if not exists support_tickets (
  id text primary key,
  code text,
  customer_id text,
  contact_id text,
  contract_id text,
  product text default '',
  request text default '',
  received_date date,
  assignee text default '',
  status text default '접수',
  method text default '',
  action text default '',
  done_date date,
  created_by text default '',
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------
-- 4) 접근 권한: 로그인한 사용자만 읽고 쓸 수 있게
-- ---------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['reps','customers','contracts','maintenance_contracts','customer_contacts','contract_items','support_tickets']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "logged in users" on %I', t);
    execute format('create policy "logged in users" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------
-- 5) 첨부파일 저장소
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

drop policy if exists "attachments logged in" on storage.objects;
create policy "attachments logged in" on storage.objects
  for all to authenticated
  using (bucket_id = 'attachments') with check (bucket_id = 'attachments');

-- =====================================================================
-- 6) 기존 데이터 옮기기 (데이터가 없으면 아무 일도 안 일어남)
-- =====================================================================
insert into customer_contacts (id, customer_id, name, phone, email)
select 'cc_mig_' || c.id, c.id, coalesce(c.ceo, ''), coalesce(c.contact_phone, ''), coalesce(c.contact_email, '')
from customers c
where (coalesce(c.ceo, '') <> '' or coalesce(c.contact_email, '') <> '' or coalesce(c.contact_phone, '') <> '')
  and not exists (select 1 from customer_contacts x where x.customer_id = c.id);

insert into customer_contacts (id, customer_id, name, email)
select distinct on (c.customer_id, c.buyer_contact)
       'cc_buy_' || c.id, c.customer_id, c.buyer_contact, coalesce(c.buyer_email, '')
from contracts c
where coalesce(c.buyer_contact, '') <> '' and c.customer_id is not null
  and not exists (select 1 from customer_contacts x where x.customer_id = c.customer_id and x.name = c.buyer_contact)
order by c.customer_id, c.buyer_contact;

update contracts c set contact_id = x.id
from customer_contacts x
where c.contact_id is null and x.customer_id = c.customer_id and x.name = c.buyer_contact;

insert into contract_items (id, contract_id, product, vendor, qty, sale_amount, supplier, purchase_amount)
select 'it_mig_' || c.id, c.id, c.name, coalesce(c.biz_type, ''), 1,
       coalesce(c.amount, 0), '', coalesce(c.amount, 0) - coalesce(c.profit_amount, 0)
from contracts c
where not exists (select 1 from contract_items i where i.contract_id = c.id);

update contracts set start_date = contract_date where start_date is null;
update contracts set stage = '계산서발행' where stage = '청구완료';
update contracts set stage = '수금완료'   where stage = '유지보수';

update maintenance_contracts m set customer_id = c.customer_id
from contracts c where m.customer_id is null and m.contract_id = c.id;
update maintenance_contracts set purchase_amount = coalesce(amount, 0) - coalesce(profit_amount, 0)
where purchase_amount is null;

-- 7) 사이트가 새 표를 바로 인식하도록 새로고침
notify pgrst, 'reload schema';
