-- OWNER is private and non-billable. An existing Stripe subscription is never canceled implicitly:
-- its owner must settle it through the billing portal before the trusted operator can grant OWNER.
CREATE TRIGGER owner_grant_refuses_unsettled_subscription
BEFORE INSERT ON entitlement_grants
WHEN NEW.tier = 'owner' AND NEW.source = 'grant' AND EXISTS (
  SELECT 1 FROM billing_subscriptions
  WHERE account_id = NEW.account_id AND status NOT IN ('canceled', 'incomplete_expired')
)
BEGIN
  SELECT RAISE(ABORT, 'OWNER grant requires paid subscriptions to be settled');
END;
