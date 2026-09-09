import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export async function connectDatabase(): Promise<typeof mongoose | null> {
  try {
    mongoose.connection.on('connected', () => {
      logger.info('MongoDB database connected successfully');
    });

    mongoose.connection.on('error', err => {
      logger.error(`MongoDB connection error: ${err.message}`);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB database connection disconnected');
    });

    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    return conn;
  } catch (error: any) {
    logger.error(`Failed to connect to MongoDB: ${error.message}`);
    // Non-fatal during foundation boot if DB is offline, but log clearly
    return null;
  }
}

export function checkDatabaseHealth(): { isConnected: boolean; state: string } {
  const states: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  const readyState = mongoose.connection.readyState;
  return {
    isConnected: readyState === 1,
    state: states[readyState] || 'unknown',
  };
}
