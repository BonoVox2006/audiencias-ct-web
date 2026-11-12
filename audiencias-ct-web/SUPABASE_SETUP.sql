-- Executar no SQL Editor do Supabase (pode ser o mesmo projeto do mapa de plenário).
-- O app na Netlify usa SUPABASE_SERVICE_ROLE_KEY (Netlify Functions) — não expõe chave no navegador.

create table if not exists public.audiencia_event_state (
  event_id text primary key,
  statuses jsonb not null default '{}'::jsonb,
  photos jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_audiencia_event_state_updated_at
  on public.audiencia_event_state (updated_at desc);

-- Segurança: RLS ligado; anon/authenticated não acessam; só service_role (backend Netlify).
alter table public.audiencia_event_state enable row level security;

revoke all on table public.audiencia_event_state from anon, authenticated;

grant all on table public.audiencia_event_state to service_role;
