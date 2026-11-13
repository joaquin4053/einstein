-- Einstein: research runs with their agent trace, verified claims and evidence graph.
-- Accessed only server-side with the service role key; RLS blocks anon access.

create table if not exists research_runs (
  id uuid primary key,
  question text not null,
  status text not null default 'done',
  mode jsonb,
  report text,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_events (
  id bigserial primary key,
  run_id uuid not null references research_runs(id) on delete cascade,
  seq int not null,
  event jsonb not null
);

create table if not exists claims (
  id bigserial primary key,
  run_id uuid not null references research_runs(id) on delete cascade,
  claim_id text not null,
  text text not null,
  confidence real not null,
  verdict text not null check (verdict in ('supported', 'weak', 'rejected')),
  debate jsonb,
  sources text[] not null default '{}'
);

create table if not exists evidence_edges (
  id bigserial primary key,
  run_id uuid not null references research_runs(id) on delete cascade,
  subject text not null,
  predicate text not null,
  object text not null,
  evidence text[] not null default '{}'
);

create table if not exists sources (
  id bigserial primary key,
  run_id uuid not null references research_runs(id) on delete cascade,
  work_uri text not null,
  title text,
  year int,
  cites int,
  doi text
);

create index if not exists research_runs_created_idx on research_runs (created_at desc);
create index if not exists agent_events_run_idx on agent_events (run_id, seq);
create index if not exists claims_run_idx on claims (run_id);
create index if not exists evidence_edges_run_idx on evidence_edges (run_id);
create index if not exists sources_run_idx on sources (run_id);

alter table research_runs enable row level security;
alter table agent_events enable row level security;
alter table claims enable row level security;
alter table evidence_edges enable row level security;
alter table sources enable row level security;
