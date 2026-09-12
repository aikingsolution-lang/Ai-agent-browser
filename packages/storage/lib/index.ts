export type { BaseStorage } from './base/types';
export * from './settings';
export * from './chat';
export * from './profile';
export * from './prompt/favorites';
export * from './auth/authStorage';
export * from './linkedin/resumeApproval';

// Re-export instances for direct use
export { default as favoritesStorage } from './prompt/favorites';
export { default as authStorage } from './auth/authStorage';
export { default as careerBrainStore } from './profile/careerBrain';
export { default as resumeApprovalStore } from './linkedin/resumeApproval';
