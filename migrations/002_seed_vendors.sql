-- Networks FTV is known to use. Intake addresses are unset until confirmed.
INSERT INTO vendors (name) VALUES
  ('proSapient'),
  ('Guidepoint'),
  ('Third Bridge'),
  ('Dialectica'),
  ('Magellan Research Group')
ON CONFLICT (name) DO NOTHING;
