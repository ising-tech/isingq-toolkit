'use strict';
// Candidate contract shared by the packaged inspector and outer verifier.
// Never derive expected names from the Host's received tool list.
module.exports = Object.freeze([
  'isingq_api_key_setup',
  'isingq_delivery_validate',
  'isingq_knowledge_get',
  'isingq_modeling_guide_get',
  'isingq_qubo_validate',
  'isingq_report_verify',
  'isingq_resource_list',
  'isingq_resource_read',
  'isingq_solve_poll',
  'isingq_solve_records_list',
  'isingq_solve_result_get',
  'isingq_solve_start',
  'isingq_solver_config_open',
  'isingq_solver_profiles_delete',
  'isingq_solver_profiles_list',
  'isingq_solver_profiles_save',
  'isingq_solver_targets_list',
  'isingq_target_delivery_validate',
  'isingq_target_solve_prepare',
  'isingq_target_solve_start',
  'isingq_update_check',
].sort());
