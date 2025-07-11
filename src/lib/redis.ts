import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';


export const RedisClient = new Redis(REDIS_URL);

// Event listeners for Redis connection status
RedisClient.on('connect', () => {
  console.log('Connected to Redis');
});

RedisClient.on('error', (err) => {
  console.error('Redis Error:', err);
});

RedisClient.on('ready', () => {
  console.log('Redis client is ready');
});

RedisClient.on('reconnecting', () => {
  console.log('Redis client is reconnecting...');
});

RedisClient.on('end', () => {
  console.log('Redis client connection ended');
});

process.on('SIGINT', async () => {
  console.log('Shutting down Redis client...');
  await RedisClient.quit();
  process.exit(0);
});