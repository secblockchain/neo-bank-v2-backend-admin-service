// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types/express-request.d.ts" />
import 'dotenv/config';
import logger from './lib/logger';
import { config, validateConfig } from './config/environment';
import { connectDB, disconnectDB } from './config/db';
import { ensureBootstrapAdmin } from './services/adminAuth.service';
import app from './app';

const startServer = async () => {
  validateConfig();

  let dbConnected = false;
  try {
    await connectDB();
    dbConnected = true;
  } catch (err) {
    logger.error(
      { err },
      'Database connection failed at startup (continuing so /health stays available)',
    );
  }

  if (dbConnected) {
    try {
      await ensureBootstrapAdmin();
    } catch (err) {
      logger.error({ err }, 'Bootstrap admin was not created');
    }
  }

  const server = app.listen(config.PORT, () => {
    logger.info({}, `Server is running on http://localhost:${config.PORT}`);
    logger.info({}, `Environment: ${config.NODE_ENV}`);
  });

  const shutdown = (signal: string) => {
    logger.info({}, `${signal} received. Shutting down gracefully...`);
    server.close(async () => {
      await disconnectDB().catch(() => {
        /* already disconnected */
      });
      logger.info({}, 'Process terminated');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer();

export default app;
