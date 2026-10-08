-- Drop standing trust a blocker holds in a sender they currently block. Blocking
-- now revokes that trust, so after an unblock the sender's next message lands in
-- Message Requests. This applies the same rule to pairs blocked before the
-- change, including rows migration 046 grandfathered. Only the blocker's trust
-- in the blocked user is removed, the blocked user's trust in the blocker stays.
DELETE FROM trusted_senders
WHERE EXISTS (
    SELECT 1 FROM user_blocks b
    WHERE b.blocker_id = trusted_senders.recipient_id
      AND b.blocked_id = trusted_senders.sender_id
);
