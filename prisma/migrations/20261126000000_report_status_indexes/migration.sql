-- Indexes for plant + date + status filters. Does not change stored rows.
CREATE INDEX IF NOT EXISTS "daily_mis_plant_id_report_date_status_idx"
  ON "daily_mis" ("plant_id", "report_date", "status");

CREATE INDEX IF NOT EXISTS "monthly_mis_plant_id_month_status_idx"
  ON "monthly_mis" ("plant_id", "month", "status");
