-- Test seed data for Shadhil CRM Production
-- Creates a test organization with OWNER user test@shadhilbuilders.in and seed data
-- Idempotent: uses ON CONFLICT DO UPDATE for upserts

-- Password hash for Test@123456 (scrypt N=16384, r=16, p=1)
-- 7c9458df3e1b831d6191ef729f7ca845:f593e22d439e27c7e675585e8fdb1fa5cbfb1164d0a2703fc2b6b85d404a8baca4f4b3f95fc15ac4a4aa18261fd631effa78931d0296437c925e4c134b7c0cc5

-- 1. Test Organization
INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt")
VALUES (
  'k7mjd78nxvpq9vs8fqkzmfyb',
  'Shadhil Test',
  'test',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  "updatedAt" = NOW();

-- 2. Test User (OWNER of test org)
INSERT INTO "User" (id, email, name, role, "organizationId", "emailVerified", "mustChangePassword", "createdAt", "updatedAt")
VALUES (
  't3s70wn3r1d2p4c8e9f0a1b2c',
  'test@shadhilbuilders.in',
  'Test Owner',
  'OWNER',
  'k7mjd78nxvpq9vs8fqkzmfyb',
  true,
  false,
  NOW(),
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  "organizationId" = EXCLUDED."organizationId",
  "emailVerified" = EXCLUDED."emailVerified",
  "mustChangePassword" = EXCLUDED."mustChangePassword",
  "updatedAt" = NOW();

-- 3. Credential Account (password: Test@123456)
INSERT INTO "Account" ("accountId", "providerId", "issuer", "userId", "password", "createdAt", "updatedAt")
VALUES (
  't3s70wn3r1d2p4c8e9f0a1b2c',
  'credential',
  'local:credential',
  't3s70wn3r1d2p4c8e9f0a1b2c',
  '7c9458df3e1b831d6191ef729f7ca845:f593e22d439e27c7e675585e8fdb1fa5cbfb1164d0a2703fc2b6b85d404a8baca4f4b3f95fc15ac4a4aa18261fd631effa78931d0296437c925e4c134b7c0cc5',
  NOW(),
  NOW()
)
ON CONFLICT ("providerId", "accountId") DO UPDATE SET
  password = EXCLUDED.password,
  issuer = EXCLUDED.issuer,
  "updatedAt" = NOW();

-- 4. Test Team (no updatedAt column)
INSERT INTO "Team" (id, name, "managerId", "organizationId", "createdAt")
VALUES (
  'ne5v26zdocwey0594idqakuz',
  'Test Team',
  't3s70wn3r1d2p4c8e9f0a1b2c',
  'k7mjd78nxvpq9vs8fqkzmfyb',
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  "managerId" = EXCLUDED."managerId",
  "organizationId" = EXCLUDED."organizationId";

-- 5. Test Project (no updatedAt column)
INSERT INTO "Project" (id, name, slug, "organizationId", address, "createdAt")
VALUES (
  'uo4inf3gya03lyssknswpljq',
  'Test Villas',
  'test-villas',
  'k7mjd78nxvpq9vs8fqkzmfyb',
  'Test Villas, Chennai, Tamil Nadu (test data)',
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  "organizationId" = EXCLUDED."organizationId",
  address = EXCLUDED.address;

-- 6. ProjectTeam (has assignedAt not createdAt)
INSERT INTO "ProjectTeam" ("projectId", "teamId", "organizationId", "assignedAt")
VALUES (
  'uo4inf3gya03lyssknswpljq',
  'ne5v26zdocwey0594idqakuz',
  'k7mjd78nxvpq9vs8fqkzmfyb',
  NOW()
)
ON CONFLICT ("projectId", "teamId") DO UPDATE SET
  "organizationId" = EXCLUDED."organizationId",
  "assignedAt" = EXCLUDED."assignedAt";

-- 7. Test Phases (no updatedAt column)
INSERT INTO "Phase" (id, name, "projectId", "organizationId", "createdAt")
VALUES
  ('zfoou6t9bvsi5wux4amhr3lc', 'Phase A', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW()),
  ('a6bbl6uncqxwvzye5chn0dme', 'Phase B', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  "projectId" = EXCLUDED."projectId",
  "organizationId" = EXCLUDED."organizationId";

-- 8. Project Options (FACING, BHK) - has id, no updatedAt
INSERT INTO "ProjectOption" (id, "projectId", "organizationId", type, value, "createdAt")
VALUES
  (gen_random_uuid(), 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', 'FACING', 'North', NOW()),
  (gen_random_uuid(), 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', 'FACING', 'South', NOW()),
  (gen_random_uuid(), 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', 'FACING', 'East', NOW()),
  (gen_random_uuid(), 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', 'FACING', 'West', NOW()),
  (gen_random_uuid(), 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', 'BHK', '2', NOW()),
  (gen_random_uuid(), 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', 'BHK', '3', NOW()),
  (gen_random_uuid(), 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', 'BHK', '4', NOW())
ON CONFLICT ("projectId", type, value) DO UPDATE SET
  "organizationId" = EXCLUDED."organizationId";

-- 9. Test Units (Phase A: 2BHK, 3BHK; Phase B: 3BHK, 4BHK) - no updatedAt
INSERT INTO "Unit" (id, "phaseId", "unitNumber", bhk, facing, sqft, "buildupSqft", "pricePerSqft", price, status, "organizationId", "createdAt")
VALUES
  (gen_random_uuid(), 'zfoou6t9bvsi5wux4amhr3lc', 'T-101', 2, 'North', 1050, 1050, 4000.00, 4200000.00, 'AVAILABLE', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW()),
  (gen_random_uuid(), 'zfoou6t9bvsi5wux4amhr3lc', 'T-102', 3, 'East', 1450, 1450, 4000.00, 5800000.00, 'AVAILABLE', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW()),
  (gen_random_uuid(), 'zfoou6t9bvsi5wux4amhr3lc', 'T-103', 3, 'South', 1480, 1480, 4020.27, 5950000.00, 'AVAILABLE', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW()),
  (gen_random_uuid(), 'a6bbl6uncqxwvzye5chn0dme', 'T-201', 3, 'West', 1500, 1500, 4066.67, 6100000.00, 'AVAILABLE', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW()),
  (gen_random_uuid(), 'a6bbl6uncqxwvzye5chn0dme', 'T-202', 4, 'North', 1900, 1900, 4421.05, 8400000.00, 'AVAILABLE', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW())
ON CONFLICT ("phaseId", "unitNumber") DO UPDATE SET
  bhk = EXCLUDED.bhk,
  facing = EXCLUDED.facing,
  sqft = EXCLUDED.sqft,
  "buildupSqft" = EXCLUDED."buildupSqft",
  "pricePerSqft" = EXCLUDED."pricePerSqft",
  price = EXCLUDED.price,
  status = EXCLUDED.status,
  "organizationId" = EXCLUDED."organizationId";

-- 10. Test Leads (various states)
INSERT INTO "Lead" (id, name, phone, email, source, state, "ownerId", "ownerType", "teamId", "projectId", "organizationId", "createdAt", "updatedAt")
VALUES
  ('el7wu9er2k6rqx66pmasnd3g', 'Test Priya', '9876520001', 'test.priya@example.in', 'META_AD', 'NEW', 't3s70wn3r1d2p4c8e9f0a1b2c', 'MANAGER', 'ne5v26zdocwey0594idqakuz', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW(), NOW()),
  ('et642l67tyugijbgad0y5pou', 'Test Arjun', '9876520002', 'test.arjun@example.in', 'LANDING', 'CONTACTED', 't3s70wn3r1d2p4c8e9f0a1b2c', 'MANAGER', 'ne5v26zdocwey0594idqakuz', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW(), NOW()),
  ('okcp4kh02kux5e6nbivv9bo7', 'Test Kavya', '9876520003', 'test.kavya@example.in', 'REFERRAL', 'VISIT_SCHEDULED', 't3s70wn3r1d2p4c8e9f0a1b2c', 'MANAGER', 'ne5v26zdocwey0594idqakuz', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW(), NOW()),
  ('wnsn7dbeakjw47a8k607aqmp', 'Test Rahul', '9876520004', 'test.rahul@example.in', 'WALK_IN', 'NEGOTIATION', 't3s70wn3r1d2p4c8e9f0a1b2c', 'MANAGER', 'ne5v26zdocwey0594idqakuz', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW(), NOW()),
  ('sv899fs2jmjyexbe9mr9r85n', 'Test Meera', '9876520005', 'test.meera@example.in', 'META_AD', 'BOOKING_INITIATED', 't3s70wn3r1d2p4c8e9f0a1b2c', 'MANAGER', 'ne5v26zdocwey0594idqakuz', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW(), NOW()),
  ('lbwv7s9vyqj7soojonymxr6', 'Test Vikram', '9876520006', 'test.vikram@example.in', 'REFERRAL', 'WON', 't3s70wn3r1d2p4c8e9f0a1b2c', 'MANAGER', 'ne5v26zdocwey0594idqakuz', 'uo4inf3gya03lyssknswpljq', 'k7mjd78nxvpq9vs8fqkzmfyb', NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  phone = EXCLUDED.phone,
  email = EXCLUDED.email,
  source = EXCLUDED.source,
  state = EXCLUDED.state,
  "ownerId" = EXCLUDED."ownerId",
  "ownerType" = EXCLUDED."ownerType",
  "teamId" = EXCLUDED."teamId",
  "projectId" = EXCLUDED."projectId",
  "organizationId" = EXCLUDED."organizationId",
  "updatedAt" = NOW();

-- 11. Test Messages (chat) - no updatedAt column
INSERT INTO "Message" (id, "leadId", "organizationId", "userId", direction, channel, body, "createdAt")
SELECT
  gen_random_uuid(),
  l.id,
  'k7mjd78nxvpq9vs8fqkzmfyb',
  CASE WHEN idx % 2 = 0 THEN NULL ELSE 't3s70wn3r1d2p4c8e9f0a1b2c' END,
  CASE WHEN idx % 2 = 0 THEN 'IN' ELSE 'OUT' END,
  CASE WHEN idx % 3 = 0 THEN 'WHATSAPP' ELSE 'IN_APP' END,
  CASE WHEN idx % 2 = 0
    THEN 'Hi, I''m interested in the project. Please share details.'
    ELSE 'Thanks for reaching out, ' || split_part(l.name, ' ', 2) || '. Sharing the brochure now.'
  END,
  NOW() - (idx || ' minutes')::interval
FROM (VALUES
  ('el7wu9er2k6rqx66pmasnd3g'),
  ('et642l67tyugijbgad0y5pou'),
  ('okcp4kh02kux5e6nbivv9bo7'),
  ('wnsn7dbeakjw47a8k607aqmp'),
  ('sv899fs2jmjyexbe9mr9r85n'),
  ('lbwv7s9vyqj7soojonymxr6')
) AS l(id)
CROSS JOIN LATERAL generate_series(0, 5) AS idx
ON CONFLICT (id) DO NOTHING;

-- 12. Test Notifications - no updatedAt column
INSERT INTO "Notification" (id, "userId", "organizationId", type, title, body, "leadId", read, "createdAt")
VALUES
  (gen_random_uuid(), 't3s70wn3r1d2p4c8e9f0a1b2c', 'k7mjd78nxvpq9vs8fqkzmfyb', 'lead.assigned', 'New lead: Test Priya', 'Assigned to you by the system. Review and respond within 24h.', 'el7wu9er2k6rqx66pmasnd3g', false, NOW()),
  (gen_random_uuid(), 't3s70wn3r1d2p4c8e9f0a1b2c', 'k7mjd78nxvpq9vs8fqkzmfyb', 'visit.scheduled', 'Visit confirmed for tomorrow', 'Test Kavya confirmed the site visit at 10:00 AM.', 'okcp4kh02kux5e6nbivv9bo7', false, NOW()),
  (gen_random_uuid(), 't3s70wn3r1d2p4c8e9f0a1b2c', 'k7mjd78nxvpq9vs8fqkzmfyb', 'booking.requested', 'Token request received', 'Test Meera requested a token for Unit T-102.', 'sv899fs2jmjyexbe9mr9r85n', true, NOW())
ON CONFLICT (id) DO NOTHING;

-- 13. Test Bookings (TOKEN on T-101, HOLD on T-102)
-- Need to get unit IDs first
WITH token_unit AS (
  SELECT id, price FROM "Unit" WHERE "phaseId" = 'zfoou6t9bvsi5wux4amhr3lc' AND "unitNumber" = 'T-101'
)
INSERT INTO "Booking" (id, "leadId", "organizationId", "unitId", "userId", amount, "tokenAmount", status, "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  'lbwv7s9vyqj7soojonymxr6',
  'k7mjd78nxvpq9vs8fqkzmfyb',
  tu.id,
  't3s70wn3r1d2p4c8e9f0a1b2c',
  tu.price,
  '250000.00',
  'TOKEN',
  NOW(),
  NOW()
FROM token_unit tu
ON CONFLICT (id) DO NOTHING;

WITH hold_unit AS (
  SELECT id, price FROM "Unit" WHERE "phaseId" = 'a6bbl6uncqxwvzye5chn0dme' AND "unitNumber" = 'T-202'
)
INSERT INTO "Booking" (id, "leadId", "organizationId", "unitId", "userId", amount, "tokenAmount", status, "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  'wnsn7dbeakjw47a8k607aqmp',
  'k7mjd78nxvpq9vs8fqkzmfyb',
  hu.id,
  't3s70wn3r1d2p4c8e9f0a1b2c',
  hu.price,
  NULL,
  'HOLD',
  NOW(),
  NOW()
FROM hold_unit hu
ON CONFLICT (id) DO NOTHING;

-- 14. Test Site Visits
INSERT INTO "SiteVisit" (id, "leadId", "organizationId", "userId", "scheduledFor", status, outcome, notes, "createdAt", "updatedAt")
VALUES
  ('test-visit-upcoming-1', 'sv899fs2jmjyexbe9mr9r85n', 'k7mjd78nxvpq9vs8fqkzmfyb', 't3s70wn3r1d2p4c8e9f0a1b2c', '2026-12-31T11:00:00.000Z', 'SCHEDULED', NULL, 'Seeded upcoming visit for testing', NOW(), NOW()),
  ('test-visit-past-1', 'lbwv7s9vyqj7soojonymxr6', 'k7mjd78nxvpq9vs8fqkzmfyb', 't3s70wn3r1d2p4c8e9f0a1b2c', '2026-01-15T10:00:00.000Z', 'SCHEDULED', NULL, 'Seeded past visit on WON lead for testing', NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  "leadId" = EXCLUDED."leadId",
  "organizationId" = EXCLUDED."organizationId",
  "userId" = EXCLUDED."userId",
  "scheduledFor" = EXCLUDED."scheduledFor",
  status = EXCLUDED.status,
  outcome = EXCLUDED.outcome,
  notes = EXCLUDED.notes,
  "updatedAt" = NOW();

-- Done
SELECT 'Test seed completed successfully!' as result;