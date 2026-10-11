-- migrate:up
-- Operator-pinned research runs (scripts/research-seed.ts) stay cache hits past the 24-hour TTL,
-- so seeded demo companies never need a live Gemini call. Only the cache lookup reads this flag.
alter table research_runs add column pinned boolean not null default false;

-- migrate:down
alter table research_runs drop column pinned;
