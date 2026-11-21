-- Facility values the old plant system stored and this portal had no column for.
-- New equipment values are added in their own transaction so later statements can use them.

ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'DIESEL_GENERATOR';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'SEALING_MACHINE';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'PORTABLE_SEALING_MACHINE';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'ONLINE_VALVE';

ALTER TABLE plants
  ADD COLUMN gst_number varchar(20),
  ADD COLUMN fm_coordinator varchar(160),
  ADD COLUMN zonal_manager varchar(160),
  ADD COLUMN officer_1 varchar(160),
  ADD COLUMN officer_2 varchar(160),
  ADD COLUMN finance_officer varchar(160),
  ADD COLUMN safety_officer varchar(160);

ALTER TABLE plant_equipment
  ADD COLUMN serial_numbers varchar(300);

ALTER TABLE daily_mis
  ADD COLUMN carousels_operated smallint,
  ADD COLUMN cyl_filled_other integer;

ALTER TABLE daily_mis DROP CONSTRAINT daily_mis_counts_non_negative;
ALTER TABLE daily_mis ADD CONSTRAINT daily_mis_counts_non_negative CHECK (
  LEAST(COALESCE(cyl_filled_14_2, 0), COALESCE(cyl_filled_19, 0), COALESCE(cyl_filled_other, 0),
        COALESCE(carousels_operated, 0),
        COALESCE(loss_carousel, 0), COALESCE(loss_eld, 0), COALESCE(loss_old, 0),
        COALESCE(loss_conveyor, 0), COALESCE(loss_up_down_stream, 0), COALESCE(loss_utility, 0),
        COALESCE(loss_power_eb, 0), COALESCE(loss_motor_cable, 0), COALESCE(loss_automation, 0),
        COALESCE(loss_indent_truck, 0), COALESCE(loss_fire_drill, 0), COALESCE(loss_training, 0),
        COALESCE(loss_manpower, 0), COALESCE(indents_status, 0), COALESCE(mr_pin_leak, 0),
        COALESCE(mr_pin_cut, 0), COALESCE(mr_body_leak, 0), COALESCE(mr_bung_leak, 0),
        COALESCE(mr_dpt_hr, 0), COALESCE(mr_weight, 0), COALESCE(mr_other, 0),
        COALESCE(sqc_defective, 0), COALESCE(test_bath_body_leak, 0), COALESCE(test_bath_bung_leak, 0)) >= 0);
ALTER TABLE daily_mis ADD CONSTRAINT daily_mis_carousels_range CHECK (
  carousels_operated IS NULL OR carousels_operated BETWEEN 0 AND 3);

ALTER TABLE daily_exceptions ADD COLUMN legacy_file_name varchar(255);
ALTER TABLE audits ADD COLUMN legacy_file_name varchar(255);
