import type { Register } from 'claude-code'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]
const isEffort = (value: string | undefined): value is Effort =>
  EFFORTS.some(effort => effort === value)

export const register: Register = on => {
  on('agent.spawn', async ($, e, next) => {
    const model = await $.env.get('ROUTER_SPIKE_MODEL')
    return next(model ? { ...e, model } : e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const effort = await $.env.get('ROUTER_SPIKE_EFFORT')
    return next(isEffort(effort) ? { ...e, effort } : e)
  })
}
