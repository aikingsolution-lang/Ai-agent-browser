import mongoose from 'mongoose';

// Global Safety Interceptor: Trap all mongoose.connect calls during tests
const originalConnect = mongoose.connect.bind(mongoose);

mongoose.connect = function (uri: any, options?: any) {
  const uriStr = String(uri || '');
  if (uriStr.includes('mongodb.net') || uriStr.includes('mongodb+srv://')) {
    throw new Error(
      `FATAL SAFETY VIOLATION: Vitest test runner attempted to connect to real MongoDB Atlas database URI ("${uriStr}"). Tests are strictly forbidden from connecting to production/development Atlas databases! All tests must use MongoMemoryServer!`,
    );
  }
  return originalConnect(uri, options);
} as any;
