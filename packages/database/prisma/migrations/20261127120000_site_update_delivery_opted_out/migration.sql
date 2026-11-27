-- The site-update templates are UTILITY now (2026-11-24), so a missing MARKETING
-- opt-in no longer blocks a send. Only a recorded denial does, and that deserves
-- its own name: "the buyer asked us to stop" is a different fact from "nobody
-- wrote down an answer".
--
-- SKIPPED_NO_CONSENT stays in the enum because rows already carry it (3 on
-- production at the time of writing). Nothing writes it any more.
ALTER TYPE "SiteUpdateDeliveryStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_OPTED_OUT';
