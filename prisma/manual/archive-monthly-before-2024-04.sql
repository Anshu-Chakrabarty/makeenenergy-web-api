-- NOT applied by migrate. Review against the live database before running.
-- Moves Monthly MIS that is still Pending for months before April 2024
-- (the 2022-23 and 2023-24 backlog) out of the live queue by returning it
-- with a fixed reason. It does not approve those months, so they stay out of charts.
-- The approval queue already hides months before 2024-04-01 without this script.

UPDATE monthly_mis
   SET status = 'RETURNED',
       return_reason = 'Archived: period is before April 2024 and is not part of the live approval queue.',
       returned_at = now()
 WHERE status = 'PENDING'
   AND month < DATE '2024-04-01';
