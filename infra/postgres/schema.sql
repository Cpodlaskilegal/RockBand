create table hosted_repos (
  id text primary key,
  owner text not null,
  repo text not null,
  full_name text not null unique,
  github_installation_id text not null,
  linear_project_slug text not null,
  linear_secret_name text,
  repo_root text,
  orchestration_enabled boolean not null default false,
  cloud_provider text not null default 'local',
  deployment_environment text not null default 'staging',
  control_plane_base_url text,
  setup_status jsonb not null,
  latest_error text,
  workflow_validation jsonb,
  workflow_content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table repo_secrets (
  repo_id text primary key references hosted_repos(id) on delete cascade,
  linear_api_key_secret_arn text not null,
  created_at timestamptz not null default now()
);

create table run_attempts (
  id uuid primary key,
  repo_id text not null references hosted_repos(id) on delete cascade,
  issue_id text not null,
  issue_identifier text not null,
  status text not null,
  attempt integer not null default 1,
  workspace_path text not null,
  session_id text,
  worker_instance_id text,
  task_arn text,
  log_namespace text,
  log_stream text,
  log_group_name text,
  log_stream_name text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_error text
);

create table session_events (
  id bigserial primary key,
  repo_id text not null references hosted_repos(id) on delete cascade,
  issue_identifier text not null,
  event_name text not null,
  message text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table issue_runtime_projection (
  repo_id text not null references hosted_repos(id) on delete cascade,
  issue_identifier text not null,
  status text not null,
  projection jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (repo_id, issue_identifier)
);

create index session_events_repo_issue_idx on session_events (repo_id, issue_identifier, created_at desc);
