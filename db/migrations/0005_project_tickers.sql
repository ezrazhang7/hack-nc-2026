-- migrate:up
-- A short market symbol per project (QPY, LUNA): founder-chosen at intake, suggested by the API.
-- Nullable so the migration is forward-only safe; new projects always get one (routes/projects.ts),
-- and backend/scripts/backfill-tickers.ts fills older rows.
alter table projects add column ticker text check (ticker ~ '^[A-Z]{2,5}$');
create unique index projects_ticker_unique on projects(ticker) where ticker is not null;

-- Curated symbols for the seeded demo companies (backend/scripts/demo-seed.ts).
update projects p set ticker = t.ticker
  from (values ('mothlight', 'MOTH'), ('fernhill-robotics', 'FERN'), ('quillnote', 'QUIL'), ('tidewater-sensors', 'TIDE'),
               ('dormfold', 'DORM'), ('bracket-bio', 'BRKT'), ('orchard-os', 'ORCH'), ('kiln-labs', 'KILN')) as t(slug, ticker)
 where p.slug = t.slug and p.ticker is null
   and not exists (select 1 from projects q where q.ticker = t.ticker);

-- migrate:down
drop index if exists projects_ticker_unique;
alter table projects drop column if exists ticker;
