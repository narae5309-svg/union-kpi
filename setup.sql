-- =====================================================================
-- UNION 계약·기술지원 관리 시스템 : Supabase 설정 SQL
-- Supabase → SQL Editor → New query 에 전체를 붙여넣고 Run 하세요.
-- 기존 데이터는 지우지 않습니다. 여러 번 실행해도 안전합니다.
-- =====================================================================

-- 1) 고객사: 세금계산서 메일
alter table customers add column if not exists tax_email text default '';

-- 2) 고객 담당자 (고객사 1곳에 여러 명)
create table if not exists customer_contacts (
  id text primary key,
  customer_id text,
  name text default '',
  dept text default '',
  phone text default '',
  email text default '',
  created_at timestamptz default now()
);

-- 3) 계약: 신규/갱신 구분, 시작일, 고객 담당자, 갱신완료 표시
alter table contracts add column if not exists deal_type text default '신규';
alter table contracts add column if not exists start_date date;
alter table contracts add column if not exists contact_id text;
alter table contracts add column if not exists renewed boolean default false;

-- 4) 계약 품목 (계약 1건에 여러 품목, 품목마다 매출/매입)
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

-- 5) 유지보수: 고객사 직접 연결, 매입처/매입금액, 구분, 갱신완료 표시
alter table maintenance_contracts add column if not exists customer_id text;
alter table maintenance_contracts add column if not exists provider text default '벤더 유지보수';
alter table maintenance_contracts add column if not exists deal_type text default '신규';
alter table maintenance_contracts add column if not exists supplier text default '';
alter table maintenance_contracts add column if not exists purchase_amount numeric;
alter table maintenance_contracts add column if not exists renewed boolean default false;

-- 6) 기술지원 요청
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

-- 7) 새 표 접근 권한 (로그인한 사용자만)
alter table customer_contacts enable row level security;
alter table contract_items   enable row level security;
alter table support_tickets  enable row level security;
drop policy if exists "logged in users" on customer_contacts;
drop policy if exists "logged in users" on contract_items;
drop policy if exists "logged in users" on support_tickets;
create policy "logged in users" on customer_contacts for all to authenticated using (true) with check (true);
create policy "logged in users" on contract_items   for all to authenticated using (true) with check (true);
create policy "logged in users" on support_tickets  for all to authenticated using (true) with check (true);

-- =====================================================================
-- 기존 데이터 옮기기 (이미 옮긴 건 다시 옮기지 않습니다)
-- =====================================================================

-- 기존 고객사의 담당자 정보 → 고객 담당자
insert into customer_contacts (id, customer_id, name, phone, email)
select 'cc_mig_' || c.id, c.id, coalesce(c.ceo, ''), coalesce(c.contact_phone, ''), coalesce(c.contact_email, '')
from customers c
where (coalesce(c.ceo, '') <> '' or coalesce(c.contact_email, '') <> '' or coalesce(c.contact_phone, '') <> '')
  and not exists (select 1 from customer_contacts x where x.customer_id = c.id);

-- 기존 계약의 구매담당자 → 고객 담당자 (같은 이름이 없을 때만)
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

-- 기존 계약 금액 → 품목 1개로 (매입 = 계약금액 - 이익금액)
insert into contract_items (id, contract_id, product, vendor, qty, sale_amount, supplier, purchase_amount)
select 'it_mig_' || c.id, c.id, c.name, coalesce(c.biz_type, ''), 1,
       coalesce(c.amount, 0), '', coalesce(c.amount, 0) - coalesce(c.profit_amount, 0)
from contracts c
where not exists (select 1 from contract_items i where i.contract_id = c.id);

-- 계약 시작일이 비어 있으면 계약일로
update contracts set start_date = contract_date where start_date is null;

-- 계약 단계 이름 정리
update contracts set stage = '계산서발행' where stage = '청구완료';
update contracts set stage = '수금완료'   where stage = '유지보수';

-- 유지보수: 고객사 연결, 매입금액 채우기
update maintenance_contracts m set customer_id = c.customer_id
from contracts c where m.customer_id is null and m.contract_id = c.id;
update maintenance_contracts set purchase_amount = coalesce(amount, 0) - coalesce(profit_amount, 0)
where purchase_amount is null;
