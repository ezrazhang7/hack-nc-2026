-- migrate:up
-- Contact publication is explicit opt-in. The intake no longer asks for or enables it.
alter table projects alter column publish_contact_email set default false;

-- migrate:down
alter table projects alter column publish_contact_email set default true;
