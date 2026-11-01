/**
 * Every AI gateway model carries an `x-run-id`: the backend counts JobForm Automator Premium /
 * Diamond AI tasks by it (Auto Apply runs keep their own run id and are not counted).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@extension/storage', () => ({
  AgentNameEnum: { Planner: 'planner', Navigator: 'navigator' },
  llmProviderStore: { getAllProviders: async () => ({}) },
  agentModelStore: { getAllAgentModels: async () => ({}) },
  authStorage: { getSession: async () => ({ token: 'id-token', user: { uid: 'userA' } }) },
}));

import { newAiTaskId } from '@extension/shared';
import { getActiveChatModel } from '../activeModelHelper';

const runIdOf = (model: unknown) =>
  (model as { clientConfig?: { defaultHeaders?: Record<string, string> } }).clientConfig?.defaultHeaders?.['x-run-id'];

describe('AI task ids sent to the gateway', () => {
  it('a new task id per model by default', async () => {
    const a = runIdOf(await getActiveChatModel());
    const b = runIdOf(await getActiveChatModel());
    expect(a).toMatch(/^ai_[0-9a-f-]{36}$/);
    expect(b).toMatch(/^ai_/);
    expect(a).not.toBe(b);
  });

  it('an Auto Apply run keeps its own run id', async () => {
    expect(runIdOf(await getActiveChatModel('auto_loop_123_job9'))).toBe('auto_loop_123_job9');
  });

  it('task ids are unique', () => {
    expect(new Set(Array.from({ length: 50 }, () => newAiTaskId())).size).toBe(50);
  });
});
