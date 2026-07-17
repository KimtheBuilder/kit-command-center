DROP TABLE IF EXISTS scorecards, recommendations, edit_jobs, workflows, assets, providers, scenes, cinematic_projects, campaigns, findings, audits, reviews, benchmarks, kpis, decisions, events, agents, approvals, tasks, goals CASCADE;
DROP FUNCTION IF EXISTS kit_reject_event_mutation();
DROP FUNCTION IF EXISTS kit_set_updated_at();
