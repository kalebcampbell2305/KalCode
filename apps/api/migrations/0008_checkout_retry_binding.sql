-- NULL identifies pre-migration intents: their already-sent Stripe parameters are unknown.
-- New intents start at '{}' and freeze all creation parameters before calling Stripe.
ALTER TABLE billing_checkout_intents ADD COLUMN creation_parameters TEXT
  CHECK (creation_parameters IS NULL OR json_valid(creation_parameters));
ALTER TABLE billing_checkout_intents ADD COLUMN checkout_url TEXT;
