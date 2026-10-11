-- migrate:up
-- Add runtime recovery to the existing market schema; preserve identities and history.
CREATE TABLE tokenization_intents (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  identity_id uuid NOT NULL REFERENCES identities(id),
  request_key text NOT NULL,
  request_hash text NOT NULL,
  transaction_base64 text NOT NULL,
  message_base64 text NOT NULL,
  signature text NOT NULL UNIQUE,
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  project_pda text NOT NULL,
  receipt_mint text NOT NULL,
  status text NOT NULL CHECK (status IN ('Prepared', 'Submitted', 'Unknown', 'Confirmed', 'Finalized', 'Failed', 'Expired')),
  kind text NOT NULL CHECK (kind IN ('Tokenize', 'Settle')),
  round_pda text,
  buyer_wallet text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_id, request_key),
  CHECK ((kind = 'Tokenize' AND round_pda IS NULL AND buyer_wallet IS NULL)
      OR (kind = 'Settle' AND round_pda IS NOT NULL AND buyer_wallet IS NOT NULL))
);
CREATE UNIQUE INDEX tokenization_one_active_project ON tokenization_intents(project_id)
  WHERE kind = 'Tokenize' AND status NOT IN ('Failed', 'Expired');
CREATE UNIQUE INDEX tokenization_one_active_settlement ON tokenization_intents(round_pda, buyer_wallet)
  WHERE kind = 'Settle' AND status NOT IN ('Failed', 'Expired');
CREATE INDEX tokenization_pending ON tokenization_intents(last_checked_at)
  WHERE status IN ('Prepared', 'Submitted', 'Unknown', 'Confirmed');
CREATE TABLE tokenization_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES tokenization_intents(id),
  status text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transaction_submission_keys (
  identity_id uuid NOT NULL REFERENCES identities(id),
  request_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, request_key)
);
ALTER TABLE tokenization_intents DROP CONSTRAINT tokenization_intents_kind_check;
ALTER TABLE tokenization_intents DROP CONSTRAINT tokenization_intents_check;
ALTER TABLE tokenization_intents ADD CONSTRAINT tokenization_intents_kind_check CHECK(kind IN ('Tokenize','Settle','Subscribe','Open'));
ALTER TABLE tokenization_intents ADD CONSTRAINT tokenization_intents_purchase_shape CHECK(
  (kind='Tokenize' AND round_pda IS NULL AND buyer_wallet IS NULL)
  OR (kind IN ('Settle','Subscribe','Open') AND round_pda IS NOT NULL AND buyer_wallet IS NOT NULL));
ALTER TABLE tokenization_intents ADD COLUMN gross_amount_micro_usd numeric(20,0);
ALTER TABLE tokenization_intents ADD COLUMN signed_transaction_base64 text;
CREATE UNIQUE INDEX tokenization_one_active_open ON tokenization_intents(round_pda) WHERE kind='Open' AND status NOT IN ('Failed','Expired');
CREATE UNIQUE INDEX tokenization_one_active_subscription ON tokenization_intents(round_pda,buyer_wallet)
  WHERE kind='Subscribe' AND status NOT IN ('Failed','Expired');

ALTER TABLE banking_accounts ADD COLUMN nickname text NOT NULL DEFAULT 'Demo Checking';
CREATE UNIQUE INDEX banking_provider_never_reassigned ON banking_accounts(provider_account_id);
CREATE UNIQUE INDEX banking_identity_generation_binding ON banking_accounts(generation,identity_id,role);
CREATE UNIQUE INDEX banking_single_treasury ON banking_accounts(generation) WHERE role='TREASURY';
ALTER TABLE funding_intents ADD COLUMN provider_transfer_id text UNIQUE;
ALTER TABLE funding_intents ADD COLUMN poll_count integer NOT NULL DEFAULT 0;
ALTER TABLE funding_intents ADD COLUMN audited_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE funding_intents ALTER COLUMN next_attempt_at SET DEFAULT now();
UPDATE funding_intents SET next_attempt_at=now() WHERE next_attempt_at IS NULL;
CREATE TABLE funding_controls (generation text PRIMARY KEY,paused boolean NOT NULL DEFAULT false,reason text);
ALTER TABLE banking_attempts ADD COLUMN observed_at timestamptz;
CREATE UNIQUE INDEX banking_one_funding_dispatch ON banking_attempts(funding_intent_id) WHERE purpose='FUNDING';
ALTER TABLE banking_attempts ADD CONSTRAINT banking_funding_dispatch_once CHECK(purpose<>'FUNDING' OR attempt_ordinal=1);
ALTER TABLE funding_transitions ADD COLUMN evidence_hash text;
CREATE TABLE banking_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,funding_intent_id uuid NOT NULL REFERENCES funding_intents(id),
 observation_hash text NOT NULL,sanitized_response jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE funding_incidents (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,funding_intent_id uuid NOT NULL REFERENCES funding_intents(id),
 reason text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),UNIQUE(funding_intent_id,reason)
);
ALTER TABLE subscription_intents ADD COLUMN chain_intent_id uuid REFERENCES tokenization_intents(id);
ALTER TABLE subscription_intents ADD COLUMN last_checked_at timestamptz NOT NULL DEFAULT now();
-- Reserve identity before generating a signed transaction; preparation may fail and resume later.
ALTER TABLE subscription_intents ALTER COLUMN prepared_message DROP NOT NULL;
ALTER TABLE subscription_intents ALTER COLUMN message_hash DROP NOT NULL;
ALTER TABLE subscription_intents ALTER COLUMN blockhash DROP NOT NULL;
ALTER TABLE subscription_intents ALTER COLUMN last_valid_block_height DROP NOT NULL;
ALTER TABLE subscription_intents ALTER COLUMN preview SET DEFAULT '{}'::jsonb;
ALTER TABLE subscription_intents ADD CONSTRAINT bound_subscription_has_message CHECK(chain_intent_id IS NULL OR
 (prepared_message IS NOT NULL AND message_hash IS NOT NULL AND signature IS NOT NULL AND blockhash IS NOT NULL AND last_valid_block_height IS NOT NULL));
-- The logical reservation survives failed transaction attempts; only the attempt is replaced.
CREATE UNIQUE INDEX subscription_logical_identity_round ON subscription_intents(identity_id,round_id);
CREATE TABLE subscription_chain_attempts (
 subscription_intent_id uuid NOT NULL REFERENCES subscription_intents(id),ordinal integer NOT NULL,
 chain_intent_id uuid NOT NULL UNIQUE REFERENCES tokenization_intents(id),PRIMARY KEY(subscription_intent_id,ordinal)
);
ALTER TABLE subscriptions ADD COLUMN minted boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN refunded boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN round_status text NOT NULL DEFAULT 'open';
CREATE FUNCTION prevent_banking_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.generation,OLD.identity_id,OLD.role,OLD.provider_account_id,OLD.provider_customer_id)
     IS DISTINCT FROM (NEW.generation,NEW.identity_id,NEW.role,NEW.provider_account_id,NEW.provider_customer_id) THEN
    RAISE EXCEPTION 'Bank account ownership and provider mappings are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_banking_accounts BEFORE UPDATE ON banking_accounts FOR EACH ROW EXECUTE FUNCTION prevent_banking_immutable_change();
CREATE FUNCTION prevent_funding_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id,OLD.generation,OLD.identity_id,OLD.wallet_address,OLD.amount_micro_usd,OLD.mode,OLD.source_banking_account_id,OLD.treasury_banking_account_id,
      OLD.idempotency_key,OLD.request_hash,OLD.correlation_tag,OLD.provider_profile)
     IS DISTINCT FROM (NEW.id,NEW.generation,NEW.identity_id,NEW.wallet_address,NEW.amount_micro_usd,NEW.mode,NEW.source_banking_account_id,NEW.treasury_banking_account_id,
      NEW.idempotency_key,NEW.request_hash,NEW.correlation_tag,NEW.provider_profile) THEN
    RAISE EXCEPTION 'Funding request fields are immutable';
  END IF;
  IF OLD.bank_proof_hash IS NOT NULL AND OLD.bank_proof_hash IS DISTINCT FROM NEW.bank_proof_hash THEN
    RAISE EXCEPTION 'Funding proof is immutable';
  END IF;
  IF OLD.provider_transfer_id IS NOT NULL AND OLD.provider_transfer_id IS DISTINCT FROM NEW.provider_transfer_id THEN
    RAISE EXCEPTION 'Bank transfer binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_funding_intents BEFORE UPDATE ON funding_intents FOR EACH ROW EXECUTE FUNCTION prevent_funding_immutable_change();
CREATE FUNCTION prevent_subscription_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id,OLD.identity_id,OLD.round_id,OLD.wallet_address,OLD.gross_amount_micro_usd,OLD.idempotency_key,OLD.request_hash)
    IS DISTINCT FROM (NEW.id,NEW.identity_id,NEW.round_id,NEW.wallet_address,NEW.gross_amount_micro_usd,NEW.idempotency_key,NEW.request_hash) THEN
    RAISE EXCEPTION 'Subscription reservation inputs are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_subscription_intents BEFORE UPDATE ON subscription_intents
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_immutable_change();
CREATE FUNCTION prevent_evidence_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Recovery evidence is append-only';
END $$;
CREATE TRIGGER immutable_bank_observations BEFORE UPDATE OR DELETE ON banking_observations
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_edit();
CREATE TRIGGER immutable_funding_incidents BEFORE UPDATE OR DELETE ON funding_incidents
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_edit();

GRANT SELECT,INSERT,UPDATE ON tokenization_intents,transaction_submission_keys,subscription_chain_attempts,funding_controls TO prospecto_app;
GRANT SELECT,INSERT ON tokenization_observations,banking_observations,funding_incidents TO prospecto_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO prospecto_app;
-- migrate:down
-- Forward-only. Disable purchase configuration to roll back runtime; preserve evidence.
