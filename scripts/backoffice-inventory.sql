-- Ejecutar en el proyecto de origen. Devuelve solo cantidades, con una única instantánea.
begin isolation level repeatable read read only;
set local row_security = off;
select now() as captured_at, current_database() as database_name;
select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1;
select role, count(*) from public.profiles group by role;
select count(*) as auth_users from auth.users;
select status,count(*) from public.clients group by status;
select type,status,client_id is null as internal,count(*) from public.projects group by 1,2,3;
select currency,type,status,payment_method,recurrence,count(*),sum(amount) as total from public.financial_movements group by 1,2,3,4,5;
select currency,count(*),sum(budget) as total_budget from public.project_financials group by 1;
select status,count(*) from public.tasks group by 1;
select done,count(*) from public.milestones group by 1;
select status,count(*) from public.feature_requests group by 1;
select revoked_at is null as active,count(*) from public.client_portal_tokens group by 1;
select bucket_id,count(*) from storage.objects group by 1;
select (select count(*) from public.notes) as notes,
       (select count(*) from public.meetings) as meetings,
       (select count(*) from public.meeting_projects) as meeting_project_links,
       (select count(*) from public.meetings where location ~* '^https?://') as meeting_urls,
       (select count(*) from public.feature_request_comments) as feature_comments,
       (select count(*) from public.credentials) as credentials,
       (select count(*) from public.credentials where nullif(trim(service_url),'') is not null) as service_urls,
       (select count(*) from public.credential_access_log) as credential_accesses,
       (select count(*) from public.project_env_files) as env_files,
       (select count(*) from public.env_file_access_log) as env_accesses;
-- Replay this snapshot after suspending writes. A timestamp cannot identify deletions.
select 'clients' entity,max(updated_at) last_change from public.clients
union all select 'projects',max(updated_at) from public.projects
union all select 'tasks',max(updated_at) from public.tasks
union all select 'milestones',max(updated_at) from public.milestones
union all select 'notes',max(updated_at) from public.notes
union all select 'meetings',max(updated_at) from public.meetings
union all select 'feature_requests',max(updated_at) from public.feature_requests
union all select 'feature_request_comments',max(created_at) from public.feature_request_comments
union all select 'financial_movements',max(updated_at) from public.financial_movements
union all select 'project_financials',max(updated_at) from public.project_financials
union all select 'credentials',max(updated_at) from public.credentials
union all select 'project_env_files',max(updated_at) from public.project_env_files
union all select 'credential_access_log',max(accessed_at) from public.credential_access_log
union all select 'env_file_access_log',max(accessed_at) from public.env_file_access_log
union all select 'client_portal_tokens',max(greatest(created_at,revoked_at,last_accessed_at)) from public.client_portal_tokens
order by entity;
select count(*) filter(where nullif(trim(notes),'') is not null) as historical_client_memos from public.clients;
commit;
