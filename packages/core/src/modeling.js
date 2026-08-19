'use strict';

function modelingGuide(problemSummary = '') {
  return {
    scope: 'local_guidance_only',
    problem_summary: String(problemSummary || '').trim(),
    required_sequence: [
      '向用户确认目标、决策范围、硬约束、软约束和输入数据',
      '定义二进制变量，并为每个 index 提供 name 与 meaning',
      '把目标函数展开为 linear 与 quadratic 项',
      '把硬约束平方惩罚后加入 QUBO，并说明 penalty 的选择依据',
      '调用 isingq_qubo_validate，向用户展示模型摘要并取得确认',
      '确认后调用 isingq_solve_start，再用 isingq_solve_poll 轮询',
      '用变量映射解释 bit，不把最低 energy 自动等同于业务可行',
    ],
    qubo_contract: {
      objective: 'offset + Σ linear[i]·x_i + Σ quadratic[i,j]·x_i·x_j',
      binary_domain: 'x_i ∈ {0,1}',
      schema: {
        num_bits: '1 到 2048 的整数',
        linear: [{ index: 0, coefficient: 1.5 }],
        quadratic: [{ i: 0, j: 1, coefficient: -2.0 }],
        offset: 0,
        variables: [{ index: 0, name: 'x_0', meaning: '变量含义' }],
      },
    },
    agent_rules: [
      '建模与 QUBO 校验应在用户电脑上完成',
      '不得索要用户在对话中粘贴 API Key',
      '模型含义不确定时先追问，不得自行补造业务约束',
      '求解前必须取得用户对模型摘要的明确确认',
    ],
  };
}

module.exports = { modelingGuide };
